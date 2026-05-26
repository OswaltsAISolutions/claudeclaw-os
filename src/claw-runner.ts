// claw-runner — subprocess wrapper around the `claw-analog` Rust binary
// (built from github.com/ultraworkers/claw-code at ~/repos/claw-code,
// staged to ~/bin/claw-analog). Spawns a one-shot agentic run, pipes the
// task as the prompt, parses the NDJSON event stream on stdout, and
// surfaces tool_use / tool_result events to the caller via onProgress so
// the dashboard activity panel shows what the local model is doing in
// real time.
//
// Why claw-analog and not full `claw`?
//   - claw-analog has a fixed, sandboxed tool set (read_file, list_dir,
//     glob_workspace, grep_workspace, git_diff, git_log, write_file with
//     workspace-write). No bash, no MCP, no plugins — safe defaults for
//     specialists that don't need shell access.
//   - Specialists that need shell (e.g. sentinel) can use runClawFull
//     once added; for now those stay on direct-ollama.
//
// Ollama routing:
//   claw-code treats Ollama as a plain OpenAI-compatible /v1 endpoint.
//   We set OPENAI_BASE_URL = http://<wsl-host-ip>:11434/v1 (reusing the
//   gateway-IP detection from src/ollama.ts) and OPENAI_API_KEY to a
//   placeholder string. Any ambient ANTHROPIC_API_KEY is scrubbed so the
//   binary cannot fall back to the paid Anthropic route by accident.
//
// NDJSON schema we consume (verified against claw-analog 0.1.3 on
// 2026-05-25):
//   - run_start    { schema, format_version, workspace, model, permission, ... }
//   - turn_start   { turn }
//   - assistant_text_delta { delta }                       (only with --stream)
//   - assistant_turn { turn, stop_reason, text, tool_calls[], usage }
//   - tool_result  { turn, tool_use_id, name, output, is_error, truncated }
//   - run_end      { ok }
//   - error        { message }

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveOllamaBaseUrl } from './ollama.js';
import { PROXY_BASE_URL_V1 } from './ollama-prefix-proxy.js';
import { DASHBOARD_TOKEN } from './config.js';
import { logger } from './logger.js';

// Default install paths — `~/bin/claw[-analog]` per the setup script. Can
// be overridden via env (`CLAW_BIN` / `CLAW_ANALOG_BIN`) so a different
// user / install layout can still drive the integration.
const HOME = process.env.HOME || os.homedir();
export const CLAW_ANALOG_BIN = process.env.CLAW_ANALOG_BIN || path.join(HOME, 'bin', 'claw-analog');
export const CLAW_FULL_BIN   = process.env.CLAW_BIN        || path.join(HOME, 'bin', 'claw');

/** Progress event surface — designed to slot directly into the existing
 *  DelegateProgressEvent shape consumed by src/agent.ts -> src/bot.ts ->
 *  the dashboard SSE bus, so a claw-backed specialist looks identical in
 *  the activity panel to a cloud specialist. */
export interface ClawProgressEvent {
  type: 'tool_active' | 'tool_use' | 'tool_result';
  description: string;
  toolUseId?: string;
  toolName?: string;
  input?: string;
  output?: string;
}

export type ClawPermission = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ClawRunOptions {
  /** Ollama model tag, e.g. "qwen3-coder:30b". */
  model: string;
  /** The user prompt / task description. */
  task: string;
  /** Optional system-prompt prefix; merged with the task as a single
   *  prompt string since claw-analog takes its prompt as one argv entry. */
  systemAddendum?: string;
  /** Workspace root claw operates inside. Defaults to an ephemeral
   *  tempdir so prompts that don't need file context can still run. */
  workspace?: string;
  /** read-only is the safe default. Bump to workspace-write when the
   *  specialist legitimately needs to create/modify files inside the
   *  workspace (coder editing source, scribe writing drafts). */
  permission?: ClawPermission;
  /** Cap on tool-loop iterations. claw-analog default is 24 — we trim
   *  to 12 so a stuck specialist can't burn unbounded GPU time. */
  maxTurns?: number;
  /** Cap on tokens claw will emit per call. Maps to --max-output-tokens
   *  if the build supports it; for now we let the model decide. */
  maxTokens?: number;
  /** Forwarded to onProgress + the spawned process so cancel-via-/stop
   *  in the dashboard kills the live claw subprocess. */
  signal?: AbortSignal;
  /** Activity-panel pipe. */
  onProgress?: (ev: ClawProgressEvent) => void;
  /** Use the FULL `claw` binary instead of `claw-analog` (gets bash +
   *  MCP + plugins, but loses the analog sandbox). Reserved for sentinel
   *  and similar shell-using specialists. */
  useFullClaw?: boolean;
  /** Disable claw's filesystem isolation by setting CLAWD_SANDBOX_FILESYSTEM_MODE=off
   *  in the subprocess env. Default workspace-only mode bind-mounts ONLY the
   *  workspace into the sandbox, which means /run/user/$UID/bus (D-Bus socket)
   *  is invisible and any `systemctl --user`, `journalctl --user`, etc. fails
   *  with "could not connect to user scope bus". Set this true for sysadmin-shaped
   *  specialists (sentinel) that need host-wide read access. Namespace isolation
   *  remains on; this only widens filesystem visibility. */
  disableFilesystemSandbox?: boolean;
}

export interface ClawRunResult {
  text: string;
  toolCalls: number;
  turns: number;
  durationMs: number;
  /** First non-zero exit code or model-emitted error message, if any.
   *  When set the caller should surface it as an assistant_message. */
  error?: string;
  /** Final stop_reason from the last assistant_turn — useful for
   *  distinguishing "model finished naturally" (end_turn) from
   *  "we ran out of turns" (max_turns) or "abort signalled". */
  stopReason?: string;
  /** Path of the workspace we actually ran in (handy for cleaning up
   *  ephemeral tempdirs from the caller). */
  workspace: string;
  /** Last reported token usage from assistant_turn. */
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** Run claw-analog once and return when the agent loop terminates. */
export async function runClaw(opts: ClawRunOptions): Promise<ClawRunResult> {
  // Pick the binary first so we can fail fast with a clear error message
  // before doing any other setup work.
  const bin = opts.useFullClaw ? CLAW_FULL_BIN : CLAW_ANALOG_BIN;
  if (!fs.existsSync(bin)) {
    return {
      text: '',
      toolCalls: 0,
      turns: 0,
      durationMs: 0,
      workspace: opts.workspace || '',
      error: `claw binary not found at ${bin} — build it via ~/repos/claw-code/rust && cargo build --release`,
    };
  }

  // Workspace handling: prefer the caller-supplied one; otherwise allocate
  // an ephemeral tempdir under /tmp. We do NOT clean this up here — the
  // caller may want to inspect outputs (and tempdirs are cheap). The OS
  // tmp reaper will sweep them.
  const workspace = opts.workspace || fs.mkdtempSync(path.join(os.tmpdir(), 'claw-ws-'));
  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  // Build the environment. Two flavors:
  //   - claw-analog accepts a bare model id like "qwen3-coder:30b" and
  //     talks to OPENAI_BASE_URL directly. We point it at Ollama.
  //   - full `claw` requires a `provider/model` slug like
  //     "openai/qwen3-coder:30b" and forwards the FULL slug to the
  //     upstream API. Ollama doesn't recognize the prefix, so we point
  //     full claw at the local prefix-strip proxy (src/ollama-prefix-proxy.ts)
  //     which sits in front of Ollama and strips the prefix before
  //     forwarding. Result: model name gets to Ollama as it expects.
  const ollamaBase = resolveOllamaBaseUrl();
  const baseUrl = opts.useFullClaw ? PROXY_BASE_URL_V1 : `${ollamaBase}/v1`;
  // DASHBOARD_TOKEN is sourced from config.ts (which reads .env at boot)
  // and forwarded into the subprocess env. Specialists with bash use it
  // to authenticate calls to /api/web/search.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: process.env.CLAW_OPENAI_API_KEY || 'local-dev-token',
    DASHBOARD_TOKEN: DASHBOARD_TOKEN || process.env.DASHBOARD_TOKEN || '',
  };
  // Scrub Anthropic creds so the binary can't accidentally egress to the
  // paid route. (Per docs/local-openai-compatible-providers.md: if
  // multiple provider keys are present, claw may prefer Anthropic.)
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  // Sentinel-shaped specialists need /run/user/$UID/bus etc. visible inside
  // the sandbox so `systemctl --user`, `journalctl --user`, etc. can reach
  // the user-scope D-Bus session. Claw's default workspace-only filesystem
  // mode bind-mounts ONLY the workspace, hiding /run entirely. Setting
  // CLAWD_SANDBOX_FILESYSTEM_MODE=off keeps the host filesystem visible.
  // Namespace isolation stays on (UID remapping etc.); only the FS view
  // widens. See claw doctor → Sandbox section for the active config.
  if (opts.disableFilesystemSandbox) {
    env.CLAWD_SANDBOX_FILESYSTEM_MODE = 'off';
  }

  // Assemble argv. The two binaries have meaningfully different surfaces:
  //   - claw-analog: -w WORKSPACE, --permission, --no-stream, --max-turns,
  //                  trailing positional prompt, bare model id
  //   - full claw:   --permission-mode, NO -w (cwd carries workspace),
  //                  `prompt SUBCOMMAND PROMPT`, `provider/model` slug
  const prompt = opts.systemAddendum
    ? `${opts.systemAddendum.trim()}\n\n---\n\n${opts.task.trim()}`
    : opts.task.trim();

  let args: string[];
  let spawnCwd: string | undefined;
  if (opts.useFullClaw) {
    // Force the `openai/` routing prefix. The prefix-strip proxy will
    // remove it before forwarding to Ollama.
    const fullModel = opts.model.includes('/') ? opts.model : `openai/${opts.model}`;
    // `--dangerously-skip-permissions` is mandatory here: we run claw
    // non-interactively (stdin: 'ignore'), so any tool that triggers a
    // permission-escalation prompt ("Approve this tool call? [y/N]")
    // deadlocks the subprocess and the model never produces output.
    // That was the actual root cause of atlas/mercury empty outputs
    // in the bake-off (the journal showed claw printing interactive
    // approval prompts that our parser then choked on as non-JSON).
    // Trusting our own roster of specialists is the right call here.
    args = [
      '--model', fullModel,
      '--output-format', 'json',
      '--permission-mode', opts.permission || 'read-only',
      '--dangerously-skip-permissions',
      'prompt',
      prompt,
    ];
    spawnCwd = workspace;
  } else {
    args = [
      '-w', workspace,
      '--model', opts.model,
      '--output-format', 'json',
      '--no-stream', // simpler parser; we get the full text in assistant_turn anyway
      '--permission', opts.permission || 'read-only',
      '--max-turns', String(opts.maxTurns ?? 12),
      prompt,
    ];
  }

  logger.info(
    { bin, model: opts.model, workspace, perm: opts.permission || 'read-only' },
    '[claw] spawning subprocess',
  );

  return new Promise<ClawRunResult>((resolve) => {
    const start = Date.now();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Full claw uses cwd for the workspace root; claw-analog uses -w.
        ...(spawnCwd ? { cwd: spawnCwd } : {}),
      });
    } catch (err) {
      resolve({
        text: '',
        toolCalls: 0,
        turns: 0,
        durationMs: Date.now() - start,
        workspace,
        error: `claw spawn failed: ${(err as Error).message}`,
      });
      return;
    }

    let assistantText = '';
    let lastStopReason: string | undefined;
    let lastUsage: ClawRunResult['usage'];
    let toolCalls = 0;
    let turns = 0;
    let stderrBuf = '';
    let stdoutBuf = '';
    let modelEmittedError: string | undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      if (opts.useFullClaw) {
        // Full claw (v0.1.3) with --output-format json emits ONE JSON object
        // at end-of-run, not NDJSON. We buffer everything and parse on exit.
        return;
      }
      // claw-analog: NDJSON, one event per line.
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, lineLen: line.length, head: line.slice(0, 200) },
            '[claw] NDJSON parse error',
          );
        }
      }
    });

    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      // Keep at most last 8 KB to avoid pinning memory on noisy runs.
      if (stderrBuf.length > 8192) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - 8192);
      }
    });

    // Wire cancellation. Two SIGTERMs in 4s should be more than enough
    // for any well-behaved tool; if not, escalate to SIGKILL.
    const abortHandler = () => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 4000).unref();
    };
    opts.signal?.addEventListener('abort', abortHandler);

    child.on('error', (err) => {
      // Spawn-time errors (ENOENT, EACCES) land here, NOT in `exit`.
      logger.error({ err: err.message }, '[claw] subprocess error event');
      resolve({
        text: assistantText.trim(),
        toolCalls,
        turns,
        durationMs: Date.now() - start,
        workspace,
        error: `claw process error: ${err.message}`,
      });
    });

    child.on('exit', (code, signal) => {
      opts.signal?.removeEventListener('abort', abortHandler);
      if (opts.useFullClaw) {
        // Full claw end-of-run: stdoutBuf holds one JSON object.
        // Shape (claw 0.1.3): { message, model, iterations, tool_uses[],
        // tool_results[], usage, estimated_cost, auto_compaction? }.
        // See rusty-claude-cli/src/main.rs::run_prompt_json.
        const raw = stdoutBuf.trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as {
              message?: string;
              iterations?: number;
              tool_uses?: Array<{ id?: string; name?: string; input?: unknown }>;
              tool_results?: Array<{ tool_use_id?: string; output?: string; is_error?: boolean }>;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (typeof parsed.message === 'string') {
              assistantText = parsed.message;
            }
            if (typeof parsed.iterations === 'number') {
              turns = parsed.iterations;
            }
            if (Array.isArray(parsed.tool_uses)) {
              toolCalls = parsed.tool_uses.length;
              for (const use of parsed.tool_uses) {
                if (!use.name) continue;
                const inputJson = (() => {
                  try { return JSON.stringify(use.input ?? {}, null, 2); }
                  catch { return String(use.input ?? ''); }
                })();
                const detail = detailFromInput(use.name, use.input);
                const label = detail ? `${labelFor(use.name)}: ${detail}` : labelFor(use.name);
                opts.onProgress?.({ type: 'tool_active', description: label });
                if (use.id) {
                  opts.onProgress?.({
                    type: 'tool_use',
                    description: label,
                    toolUseId: use.id,
                    toolName: use.name,
                    input: inputJson.length > 4000
                      ? inputJson.slice(0, 4000) + '\n…[truncated]'
                      : inputJson,
                  });
                }
              }
            }
            if (Array.isArray(parsed.tool_results)) {
              for (const r of parsed.tool_results) {
                if (!r.tool_use_id) continue;
                const out = String(r.output ?? '');
                opts.onProgress?.({
                  type: 'tool_result',
                  description: r.is_error ? '[error]' : '',
                  toolUseId: r.tool_use_id,
                  output: out.length > 4000 ? out.slice(0, 4000) + '\n…[truncated]' : out,
                });
              }
            }
            if (parsed.usage) {
              const u = parsed.usage;
              const tot = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
              lastUsage = {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                total_tokens: tot > 0 ? tot : undefined,
              };
            }
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, head: raw.slice(0, 400) },
              '[claw] full-claw JSON parse error',
            );
          }
        }
      } else if (stdoutBuf.trim()) {
        // claw-analog: drain a trailing NDJSON line (rare; usually \n-terminated).
        try { handleEvent(JSON.parse(stdoutBuf.trim())); } catch { /* */ }
      }
      logger.info({ code, signal, assistantTextLen: assistantText.length, turns, toolCalls, stderrLen: stderrBuf.length, fullClaw: opts.useFullClaw === true }, '[claw] subprocess exit');
      const aborted = opts.signal?.aborted === true;
      let error: string | undefined;
      if (modelEmittedError) {
        error = modelEmittedError;
      } else if (aborted) {
        error = 'aborted';
      } else if (code !== 0) {
        error = stderrBuf.trim().slice(-800) || `claw exited code=${code} signal=${signal ?? ''}`;
      }
      resolve({
        text: assistantText.trim(),
        toolCalls,
        turns,
        durationMs: Date.now() - start,
        workspace,
        stopReason: lastStopReason,
        usage: lastUsage,
        error,
      });
    });

    function handleEvent(ev: Record<string, unknown>): void {
      const t = String(ev['type'] || '');
      switch (t) {
        case 'run_start': {
          logger.info({ model: ev['model'], permission: ev['permission'] }, '[claw] run_start');
          break;
        }
        case 'turn_start': {
          turns = Number(ev['turn'] || turns + 1);
          logger.info({ turns }, '[claw] turn_start');
          break;
        }
        case 'assistant_text_delta': {
          // Only emitted with --stream. We disabled streaming above for
          // simplicity, but keep the branch so a future flag flip Just
          // Works.
          const delta = String(ev['delta'] || ev['text'] || '');
          if (delta) assistantText += delta;
          break;
        }
        case 'assistant_turn': {
          const text = String(ev['text'] || '');
          if (text && !assistantText.endsWith(text)) {
            // When NOT streaming, the full per-round text arrives once
            // here. When streaming, deltas already populated assistantText.
            assistantText = text;
          }
          lastStopReason = String(ev['stop_reason'] || '');
          const usage = ev['usage'] as Record<string, number> | undefined;
          if (usage && typeof usage === 'object') {
            lastUsage = {
              input_tokens: usage['input_tokens'],
              output_tokens: usage['output_tokens'],
              total_tokens: usage['total_tokens'],
            };
          }
          // Each tool_use the model issued in THIS turn — emit the
          // analytics events for the activity panel. The tool_result
          // for each pair will land on a later NDJSON line.
          const calls = ev['tool_calls'] as Array<{
            id?: string;
            name?: string;
            input?: unknown;
          }> | undefined;
          if (Array.isArray(calls)) {
            for (const call of calls) {
              if (!call.name) continue;
              toolCalls += 1;
              const inputJson = (() => {
                try { return JSON.stringify(call.input ?? {}, null, 2); }
                catch { return String(call.input ?? ''); }
              })();
              const detail = detailFromInput(call.name, call.input);
              const label = detail
                ? `${labelFor(call.name)}: ${detail}`
                : labelFor(call.name);
              opts.onProgress?.({ type: 'tool_active', description: label });
              if (call.id) {
                opts.onProgress?.({
                  type: 'tool_use',
                  description: label,
                  toolUseId: call.id,
                  toolName: call.name,
                  input: inputJson.length > 4000
                    ? inputJson.slice(0, 4000) + '\n…[truncated]'
                    : inputJson,
                });
              }
            }
          }
          break;
        }
        case 'tool_result': {
          const id = ev['tool_use_id'] as string | undefined;
          if (!id) break;
          const output = String(ev['output'] ?? '');
          const isError = ev['is_error'] === true;
          opts.onProgress?.({
            type: 'tool_result',
            description: isError ? '[error]' : '',
            toolUseId: id,
            output: output.length > 4000
              ? output.slice(0, 4000) + '\n…[truncated]'
              : output,
          });
          break;
        }
        case 'run_end': {
          logger.debug({ ev }, '[claw] run_end');
          break;
        }
        case 'error': {
          const msg = String(ev['message'] || 'claw error');
          modelEmittedError = msg;
          break;
        }
        default:
          // Unknown event types are non-fatal — claw may extend the
          // schema. Just log for visibility.
          logger.debug({ type: t, ev }, '[claw] unknown ndjson event');
      }
    }
  });
}

// ── Tool label helpers ───────────────────────────────────────────────
// Map claw-analog's tool names to short verb labels and extract a
// useful detail string for the activity panel. Mirrors the same
// approach used in src/agent.ts for cloud tool_use events.

function labelFor(toolName: string): string {
  switch (toolName) {
    case 'read_file':       return 'Reading file';
    case 'list_dir':        return 'Listing directory';
    case 'glob_workspace':  return 'Finding files';
    case 'grep_workspace':  return 'Searching code';
    case 'grep_search':     return 'Searching code';
    case 'git_diff':        return 'Diffing repo';
    case 'git_log':         return 'Reading git log';
    case 'write_file':      return 'Writing file';
    case 'retrieve_context':return 'Retrieving context';
    default:                return toolName;
  }
}

function detailFromInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const grab = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : '');
  switch (name) {
    case 'read_file':
    case 'write_file':
      return path.basename(grab('path')) || grab('path');
    case 'list_dir':
      return grab('path') || '.';
    case 'glob_workspace':
      return grab('pattern');
    case 'grep_workspace':
    case 'grep_search':
      return grab('pattern') || grab('query');
    case 'git_diff':
    case 'git_log':
      return grab('rev_range') || (Array.isArray(obj['paths']) ? (obj['paths'] as unknown[]).join(' ') : '');
    case 'retrieve_context':
      return grab('query');
    default:
      return '';
  }
}
