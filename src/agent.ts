import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_ID, AGENT_MAX_TURNS, PROJECT_ROOT, agentCwd, agentSystemPrompt } from './config.js';
import { readEnvFile } from './env.js';
import { classifyError, AgentError } from './errors.js';
import { logger } from './logger.js';
import { getScrubbedSdkEnv } from './security.js';
import { requireEnabled } from './kill-switches.js';
import { intelligentRoute, delegate as delegateToSpecialist } from './specialists.js';
import { createTeamMcpServer } from './team-tools.js';
import { toolLabel } from './tool-labels.js';

// ── MCP server loading ──────────────────────────────────────────────
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Merge MCP server configs from user settings (~/.claude/settings.json) and
 * project settings (.claude/settings.json in cwd), optionally filtered by
 * an allowlist (e.g. from an agent's agent.yaml `mcp_servers` field).
 *
 * Exported so the voice bridge can reuse the exact same loader the text
 * bot uses — keeping behavior consistent across channels.
 */
export function loadMcpServers(allowlist?: string[], projectCwd?: string): Record<string, McpStdioConfig> {
  const merged: Record<string, McpStdioConfig> = {};

  // Load from project settings (.claude/settings.json in cwd). `projectCwd`
  // lets callers (e.g. the voice bridge) target a specific sub-agent's
  // settings file without needing the module-level `agentCwd` to be set.
  const projectSettings = path.join(projectCwd ?? agentCwd ?? PROJECT_ROOT, '.claude', 'settings.json');
  // Load from user settings (~/.claude/settings.json)
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  for (const file of [userSettings, projectSettings]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;
          if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — skip
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active' | 'tool_use' | 'tool_result';
  description: string;
  // Set on type='tool_use' and 'tool_result' so the SSE frontend can pair
  // them and show input → output as a collapsible card.
  toolUseId?: string;
  toolName?: string;
  input?: string;   // serialized tool input (truncated)
  output?: string;  // serialized tool result content (truncated)
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
  routingOptions?: { skip?: boolean; chatId?: string; userText?: string },
): Promise<AgentResult> {
  // Centralized kill-switch enforcement. Throws KillSwitchDisabledError if
  // LLM_SPAWN_ENABLED has been flipped off — caller is expected to surface
  // a "feature disabled" message rather than retry. This is the SINGLE
  // chokepoint for Telegram, scheduler, mission worker, and any other
  // path that ends up here; the war-room and voice paths have their own
  // requireEnabled calls at their own SDK boundaries.
  requireEnabled('LLM_SPAWN_ENABLED');

  // ── Specialist routing ──────────────────────────────────────────────
  // Before invoking the main Jarvis agent, ask intelligentRoute() whether
  // this task belongs to a specialist (coder, scribe, sleuth, archivist,
  // sentinel, cipher, eye, reaper, atlas, mercury). 3-stage chain:
  //   1) Keyword heuristic (~1ms)
  //   2) Opus 4.8 LLM router (~3-4s) for ambiguous tasks ≥ 20 chars
  //   3) Local mistral-small:24b fallback if Opus fails
  // Documented never-throws (try/catch + 'self' fallback inside), but we
  // wrap defensively anyway — a routing failure must never block Jarvis.
  // The routingOptions.skip arg is reserved for future internal callers
  // that need to bypass (delegate() itself doesn't reach back into
  // runAgent today, but this keeps the door closed).
  if (!routingOptions?.skip) {
    try {
      // Route on the clean user text when the caller supplied it. The
      // `message` parameter is typically a prebuilt prompt with a
      // [Memory context] preamble jammed on top, which (a) makes the
      // keyword heuristic miss short prompts, (b) sends the LLM router a
      // wall of noise, and (c) gets persisted under the specialist's
      // agent_id where it bleeds into the chat view.
      const routeInput = routingOptions?.userText ?? message;
      const delegateInput = routingOptions?.userText ?? message;
      const route = await intelligentRoute(routeInput);
      logger.info(
        { callsign: route.callsign, source: route.source, reason: route.reason },
        '[router] task routing decision',
      );
      // Also write a plain console line so it shows up clearly in
      // `journalctl --user -u com.claudeclaw.main.service -f`.
      console.log(`[router] ${route.callsign} (${route.source}): ${route.reason}`);

      if (route.callsign !== 'self') {
        // Surface the routing decision on the chat stream so the
        // dashboard's activity panel can attribute subsequent tool
        // events to the chosen specialist callsign.
        onProgress?.({ type: 'tool_active', description: '▸ Routed to @' + route.callsign });
        const result = await delegateToSpecialist(route.callsign, delegateInput, {
          chatId: routingOptions?.chatId,
          shareMemory: true,
          onProgress: onProgress
            ? (ev) => onProgress({
                type: ev.type,
                description: ev.description,
                toolUseId: ev.toolUseId,
                toolName: ev.toolName,
                input: ev.input,
                output: ev.output,
              })
            : undefined,
        });
        // Preserve sessionId so subsequent user messages can resume Jarvis's
        // session (specialists run stateless single-turns; the main session
        // remains continuous for the user's conversation thread).
        return {
          text: result.output,
          newSessionId: sessionId,
          usage: null,
          aborted: false,
        };
      }
      // 'self' → fall through to the existing main-agent path below.
    } catch (err) {
      logger.warn(
        { err: (err as Error).message ?? String(err) },
        '[router] routing failed, falling through to main agent',
      );
      // Intentionally swallow — the main agent path below handles the task.
    }
  }

  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  // Strip secret-shaped env vars (DASHBOARD_TOKEN, third-party API keys,
  // DB_ENCRYPTION_KEY, etc.) before handing process.env to the SDK
  // subprocess. A prompt-injected agent that calls `env` or `cat .env`
  // can otherwise read every credential the parent process holds.
  const sdkEnv = getScrubbedSdkEnv(secrets);

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;
  let streamedText = '';

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  try {
    // Load MCP servers from project + user settings files, filtered by agent allowlist.
    // SDK Options.mcpServers expects Record<string, McpServerConfig>, whose union
    // accepts in-process SDK servers alongside stdio ones, so we can mix them here.
    const mcpServerSpecs: Record<string, McpStdioConfig | ReturnType<typeof createTeamMcpServer>> = {
      ...loadMcpServers(mcpAllowlist),
    };

    // The MAIN Jarvis agent gets an in-process "team" MCP server so he can do
    // the job he exists for: think big, make a plan, break it into independent
    // sub-tasks, and hand each to the specialist best suited to it, running
    // several at once. Attached ONLY here, on main's own live turn, gated three
    // ways:
    //   AGENT_ID === 'main'     never on a delegated sub-agent process
    //   routingOptions present  the real Telegram/scheduler path, not an
    //                           internal caller that opted out via skip
    //   chatId present          so the hive_mind log + shared memory key off
    //                           the actual conversation
    // Recursion is bounded by construction: a delegated specialist runs through
    // delegateCloud / delegateClaw, neither of which wires this server in, so a
    // specialist can never sub-delegate. Depth is exactly one.
    if (AGENT_ID === 'main' && !!routingOptions && !routingOptions.skip && routingOptions.chatId) {
      mcpServerSpecs['team'] = createTeamMcpServer(routingOptions.chatId);
    }

    const mcpServerNames = Object.keys(mcpServerSpecs);
    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length, mcpServers: mcpServerNames },
      'Starting agent query',
    );

    for await (const event of query({
      prompt: singleTurn(message),
      options: {
        // cwd = agent directory (if running as agent) or project root.
        // Claude Code loads CLAUDE.md from cwd via settingSources: ['project'].
        cwd: agentCwd ?? PROJECT_ROOT,

        // Resume the previous session for this chat (persistent context)
        resume: sessionId,

        // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills/ and user settings
        settingSources: ['project', 'user'],

        // Append the personalized CLAUDE.md from CLAUDECLAW_CONFIG (loaded
        // at startup by index.ts via setAgentOverrides). cwd's CLAUDE.md is
        // the public template with [PLACEHOLDERS]; this is the real persona
        // (Jarvis identity, Ollama HARD RULE, em-dash rule, recall queries).
        // Has to be appended on every query — `resume: sessionId` causes the
        // SDK to reuse the prior turn's system prompt, so without this the
        // persona is frozen at session start and never reflects later edits.
        // Bug observed 2026-05-24: persona edits were no-ops because setAgentOverrides
        // stored the prompt but no code read it back into the SDK.
        ...(agentSystemPrompt ? { appendSystemPrompt: agentSystemPrompt } : {}),

        // Skip all permission prompts — this is a trusted personal bot on your own machine
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // Cap agentic turns to prevent runaway tool-use loops (e.g. retrying
        // stale cookies 40+ times). Configurable via AGENT_MAX_TURNS in .env.
        ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),

        // Pass secrets to the subprocess without polluting our own process.env
        env: sdkEnv,

        // MCP servers loaded from .claude/settings.json and ~/.claude/settings.json,
        // plus the in-process "team" server on the main agent's live turn.
        ...(mcpServerNames.length > 0 ? { mcpServers: mcpServerSpecs } : {}),

        // Stream partial text so Telegram can show progressive updates
        includePartialMessages: !!onStreamText,

        // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5')
        ...(model ? { model } : {}),

        // Abort support — signals the SDK to kill the subprocess
        ...(abortController ? { abortController } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        logger.info({ newSessionId }, 'Session initialized');
      }

      // Detect auto-compaction (context window was getting full)
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens },
          'Context window compacted',
        );
      }

      // Track per-call token usage and detect tool use from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          lastCallCacheRead = callCacheRead;
        }
        if (callInputTokens > 0) {
          lastCallInputTokens = callInputTokens;
        }

        // Extract tool_use blocks from assistant content. Emit BOTH a
        // short 'tool_active' label (back-compat with Telegram) AND a
        // richer 'tool_use' event carrying the full input — the chat
        // SPA pairs the latter with the matching 'tool_result' event
        // (see user-role handler below) to show a Claude-Code-style
        // collapsible card with command + output.
        if (onProgress) {
          const content = msg?.['content'] as Array<{
            type: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          }> | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && block.name) {
                let detail = '';
                if (block.input) {
                  if (block.name === 'Bash' && typeof block.input['command'] === 'string') {
                    const cmd = block.input['command'] as string;
                    detail = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
                  } else if ((block.name === 'Read' || block.name === 'Write' || block.name === 'Edit') && typeof block.input['file_path'] === 'string') {
                    const fp = block.input['file_path'] as string;
                    detail = fp.split('/').pop() || fp;
                  } else if (block.name === 'Grep' && typeof block.input['pattern'] === 'string') {
                    detail = block.input['pattern'] as string;
                  } else if (block.name === 'Glob' && typeof block.input['pattern'] === 'string') {
                    detail = block.input['pattern'] as string;
                  } else if (block.name === 'WebSearch' && typeof block.input['query'] === 'string') {
                    detail = block.input['query'] as string;
                  }
                }
                const label = detail
                  ? `${toolLabel(block.name)}: ${detail}`
                  : toolLabel(block.name);
                // Short label (Telegram-compatible).
                onProgress({ type: 'tool_active', description: label });
                // Rich event with full input — capped at 4000 chars so a
                // 100KB Edit's full file content doesn't flood the wire.
                if (block.id) {
                  const inputJson = (() => {
                    try { return JSON.stringify(block.input ?? {}, null, 2); }
                    catch { return String(block.input ?? ''); }
                  })();
                  onProgress({
                    type: 'tool_use',
                    description: label,
                    toolUseId: block.id,
                    toolName: block.name,
                    input: inputJson.length > 4000 ? inputJson.slice(0, 4000) + '\n…[truncated]' : inputJson,
                  });
                }
              }
            }
          }
        }
      }

      // Tool RESULTS arrive as user-role events with content arrays
      // containing tool_result blocks. Pair them with the tool_use by
      // tool_use_id so the chat SPA can fill in the matching card.
      if (ev['type'] === 'user' && onProgress) {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as Array<{
          type: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              // tool_result.content can be a string OR an array of content
              // parts (each with type='text' + text). Flatten to plain text.
              let output = '';
              if (typeof block.content === 'string') {
                output = block.content;
              } else if (Array.isArray(block.content)) {
                output = block.content
                  .map((p: unknown) => {
                    if (typeof p === 'string') return p;
                    if (p && typeof p === 'object' && 'text' in p) return String((p as { text: unknown }).text ?? '');
                    return '';
                  })
                  .join('\n');
              } else if (block.content != null) {
                try { output = JSON.stringify(block.content); }
                catch { output = String(block.content); }
              }
              const trimmed = output.length > 4000
                ? output.slice(0, 4000) + '\n…[truncated]'
                : output;
              onProgress({
                type: 'tool_result',
                description: block.is_error ? '[error]' : '',
                toolUseId: block.tool_use_id,
                output: trimmed,
              });
            }
          }
        }
      }

      // Sub-agent lifecycle events — surface to Telegram for user feedback
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
        const desc = (ev['description'] as string) ?? 'Sub-agent started';
        onProgress({ type: 'task_started', description: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
        const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
        const status = (ev['status'] as string) ?? 'completed';
        onProgress({
          type: 'task_completed',
          description: status === 'failed' ? `Failed: ${summary}` : summary,
        });
      }

      // Stream text deltas for progressive Telegram updates.
      // Only stream the outermost assistant response (parent_tool_use_id === null)
      // to avoid showing internal tool-use reasoning.
      if (ev['type'] === 'stream_event' && onStreamText && ev['parent_tool_use_id'] === null) {
        const streamEvent = ev['event'] as Record<string, unknown> | undefined;
        if (streamEvent?.['type'] === 'content_block_delta') {
          const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            streamedText += delta['text'];
            onStreamText(streamedText);
          }
        }
        if (streamEvent?.['type'] === 'message_start') {
          streamedText = '';
        }
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage info from result event
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
            didCompact,
            preCompactTokens,
            lastCallCacheRead,
            lastCallInputTokens,
          };
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: ev['subtype'] },
          'Agent result received',
        );
      }
    }
  } catch (err) {
    if (abortController?.signal.aborted) {
      logger.info('Agent query aborted by user');
      return { text: null, newSessionId, usage, aborted: true };
    }

    // Classify the error and attach context-aware metadata
    const contextTokens = lastCallInputTokens || lastCallCacheRead || 0;
    const classified = classifyError(err, contextTokens || undefined);
    logger.error(
      { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
      'Agent query failed (classified)',
    );
    throw classified;
  } finally {
    clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId, usage };
}

// ── Retry wrapper ─────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 4; // 2s, 8s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the agent with automatic retry for transient errors.
 * Only retries errors where recovery.shouldRetry is true.
 * Calls onRetry before each retry so the caller can notify the user.
 */
export async function runAgentWithRetry(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  onRetry?: (attempt: number, error: AgentError) => void,
  fallbackModels?: string[],
  mcpAllowlist?: string[],
  routingOptions?: { skip?: boolean; chatId?: string; userText?: string },
): Promise<AgentResult> {
  let lastError: AgentError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const currentModel =
        attempt === 0 ? model
        : lastError?.recovery.shouldSwitchModel && fallbackModels?.length
          ? fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
          : model;

      return await runAgent(
        message, sessionId, onTyping, onProgress,
        currentModel, abortController, onStreamText,
        mcpAllowlist, routingOptions,
      );
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      lastError = err;

      // Don't retry non-retryable errors or if aborted
      if (!err.recovery.shouldRetry || abortController?.signal.aborted) {
        throw err;
      }

      // Don't retry past the limit
      if (attempt >= MAX_RETRIES) {
        throw err;
      }

      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
        60000,
      );
      // Add jitter (0-25% of delay)
      const jitter = Math.random() * delayMs * 0.25;

      logger.warn(
        { attempt: attempt + 1, category: err.category, delayMs: Math.round(delayMs + jitter) },
        'Retrying agent query',
      );

      onRetry?.(attempt + 1, err);
      await sleep(delayMs + jitter);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error('Retry loop exhausted');
}
