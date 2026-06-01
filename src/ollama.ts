// Ollama client for ClaudeClaw — talks to the Ollama HTTP API.
//
// On WSL, Ollama typically runs on the Windows host. The Windows host IP
// is the default route gateway and can change between WSL boots, so we
// auto-detect it at runtime by parsing `ip route` and cache for 60s. If
// OLLAMA_HOST is explicitly set in .env we trust it and skip detection.
//
// All endpoints stream NDJSON for long-running operations (pull, generate).
// The dashboard relays these streams to the browser via SSE.
//
// Security note: this module only talks to the Ollama HTTP API; it does
// NOT execute shell commands or model output. Model outputs returned to
// callers must be treated as untrusted data by upstream code.

import { execSync } from 'child_process';
import { readEnvFile } from './env.js';

// Lazy-read once per process. The .env values are stable for a session;
// changes require a service restart which reloads this module.
let envCache: Record<string, string> | null = null;
function envVal(key: string): string | undefined {
  if (!envCache) envCache = readEnvFile(['OLLAMA_HOST', 'OLLAMA_PORT']);
  return envCache[key];
}

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model?: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

interface OllamaListResponse {
  models: OllamaModel[];
}

interface OllamaShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  details?: OllamaModel['details'];
  model_info?: Record<string, unknown>;
  capabilities?: string[];
}

interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

let cachedHost: { value: string; expiresAt: number } | null = null;

/**
 * Resolve the Ollama base URL.
 *
 * Priority:
 *   1. OLLAMA_HOST env var if set (assumed to be host[:port] without scheme,
 *      or a full URL).
 *   2. Linux only: the default route gateway from `ip route`. This is the
 *      Windows host when running under WSL2 NAT mode.
 *   3. Fallback to 127.0.0.1.
 *
 * Cached for 60s — gateway IP is stable within a boot.
 */
export function resolveOllamaBaseUrl(): string {
  const port = envVal('OLLAMA_PORT') || '11434';
  const explicit = envVal('OLLAMA_HOST')?.trim();
  if (explicit) {
    if (explicit.startsWith('http://') || explicit.startsWith('https://')) {
      return explicit.replace(/\/$/, '');
    }
    return `http://${explicit.includes(':') ? explicit : `${explicit}:${port}`}`;
  }

  const now = Date.now();
  if (cachedHost && cachedHost.expiresAt > now) {
    return `http://${cachedHost.value}:${port}`;
  }

  let host = '127.0.0.1';
  if (process.platform === 'linux') {
    try {
      const out = execSync('ip route show default', { encoding: 'utf8', timeout: 1500 });
      // `default via 172.30.192.1 dev eth0 proto kernel`
      const m = out.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
      if (m) host = m[1];
    } catch {
      // Fall through to localhost.
    }
  }

  cachedHost = { value: host, expiresAt: now + 60_000 };
  return `http://${host}:${port}`;
}

/**
 * Reset the host cache. Useful after the user toggles networking modes
 * or restarts WSL. Called by the dashboard's force-refresh button.
 */
export function clearOllamaHostCache(): void {
  cachedHost = null;
}

/**
 * Probe Ollama with a short timeout. Returns the resolved base URL plus
 * a version string if reachable, or an error message otherwise.
 */
export async function ollamaHealth(): Promise<
  | { ok: true; baseUrl: string; version: string }
  | { ok: false; baseUrl: string; error: string }
> {
  const baseUrl = resolveOllamaBaseUrl();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/version`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, baseUrl, error: `HTTP ${res.status}` };
    }
    const j = await res.json() as { version: string };
    return { ok: true, baseUrl, version: j.version };
  } catch (err) {
    return { ok: false, baseUrl, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List all installed local models.
 */
export async function ollamaListModels(): Promise<OllamaModel[]> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`ollama list failed: HTTP ${res.status}`);
  const data = await res.json() as OllamaListResponse;
  return data.models || [];
}

/**
 * Show detailed metadata for one model — parameter count, quantization,
 * template, capabilities (tools, vision, embedding).
 */
export async function ollamaShowModel(name: string): Promise<OllamaShowResponse> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`ollama show failed: HTTP ${res.status}`);
  return res.json() as Promise<OllamaShowResponse>;
}

/**
 * List models currently loaded into VRAM with their TTL and offload split.
 */
export async function ollamaRunningModels(): Promise<Array<{
  name: string;
  model: string;
  size: number;
  size_vram: number;
  expires_at: string;
}>> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/ps`);
  if (!res.ok) throw new Error(`ollama ps failed: HTTP ${res.status}`);
  const data = await res.json() as { models?: Array<{ name: string; model: string; size: number; size_vram: number; expires_at: string }> };
  return data.models || [];
}

/**
 * Delete a model from local storage.
 */
export async function ollamaDeleteModel(name: string): Promise<void> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama delete failed: HTTP ${res.status} ${body}`);
  }
}

/**
 * Pull a model from a registry. Streams NDJSON progress events.
 * The caller passes an onProgress callback that gets every event;
 * the promise resolves when the stream closes successfully (or rejects
 * on a non-2xx response). Errors emitted via `error` in the stream
 * are passed to onProgress as-is — the caller decides whether to abort.
 *
 * Abort by calling signal.abort() — the fetch aborts and so does the pull.
 */
export async function ollamaPullModel(
  name: string,
  onProgress: (ev: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, stream: true }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama pull failed: HTTP ${res.status} ${body}`);
  }
  if (!res.body) throw new Error('ollama pull: no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // NDJSON: split on newlines. The server sends one JSON object per line.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as PullProgress;
        onProgress(ev);
      } catch {
        // Bad line — emit as opaque status so the UI shows it.
        onProgress({ status: line });
      }
    }
  }
  // Flush any final partial line.
  if (buf.trim()) {
    try {
      onProgress(JSON.parse(buf) as PullProgress);
    } catch { /* ignore */ }
  }
}

/**
 * Non-streaming generate — for quick smoke tests. The main bot does NOT
 * use this in production paths; local models are exposed as a tool, not
 * as the bot's brain.
 */
export async function ollamaGenerate(
  model: string,
  prompt: string,
  options?: { temperature?: number; num_predict?: number },
): Promise<string> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama generate failed: HTTP ${res.status} ${body}`);
  }
  const data = await res.json() as { response: string };
  return data.response;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatStreamEvent {
  delta?: string;
  thinkingDelta?: string;
  done?: boolean;
  evalCount?: number;
  promptEvalCount?: number;
  totalDurationNs?: number;
}

/**
 * Streaming chat. Sends messages to `/api/chat` and emits each token delta
 * via onEvent. Resolves when the stream ends. Caller can abort via signal.
 */
export async function ollamaChat(
  model: string,
  messages: ChatMessage[],
  onEvent: (ev: ChatStreamEvent) => void,
  options?: { temperature?: number; num_predict?: number; num_ctx?: number },
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = resolveOllamaBaseUrl();
  // Disable Qwen3 thinking mode at the /api/chat layer. Per Ollama docs
  // (ollama.com/blog/thinking), `think: false` makes the model emit its
  // final answer directly instead of wrapping reasoning in <think> blocks
  // that can eat the entire output budget. Native /api/chat honors this;
  // OpenAI-compat /v1/chat/completions doesn't always, which is why we
  // route Qwen3 work through direct Ollama instead of via claw.
  const isQwen3 = /qwen3/i.test(model);
  const body: Record<string, unknown> = { model, messages, stream: true, options };
  if (isQwen3) {
    body.think = false;
  }
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama chat failed: HTTP ${res.status} ${body}`);
  }
  if (!res.body) throw new Error('ollama chat: no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as {
          message?: { content?: string; thinking?: string };
          done?: boolean;
          eval_count?: number;
          prompt_eval_count?: number;
          total_duration?: number;
        };
        onEvent({
          delta: ev.message?.content,
          thinkingDelta: ev.message?.thinking,
          done: ev.done,
          evalCount: ev.eval_count,
          promptEvalCount: ev.prompt_eval_count,
          totalDurationNs: ev.total_duration,
        });
      } catch {
        // Skip malformed lines.
      }
    }
  }
}

/**
 * Generate an embedding vector for a text string using a local Ollama
 * embedding model (e.g. `bge-m3:latest`, 1024 dimensions). Non-streaming.
 *
 * Used by the embeddings module after the 2026-05-23 swap away from
 * Gemini (which kept returning 403 PERMISSION_DENIED) toward the
 * already-installed local bge-m3 model. Local embeddings keep memory
 * consolidation insights+summaries searchable without a third-party API.
 */
export async function ollamaEmbed(
  model: string,
  input: string,
): Promise<number[]> {
  const baseUrl = resolveOllamaBaseUrl();
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama embed failed: HTTP ${res.status} ${body}`);
  }
  const data = await res.json() as { embeddings?: number[][] };
  return data.embeddings?.[0] ?? [];
}

export type { OllamaModel, OllamaShowResponse, PullProgress, ChatMessage, ChatStreamEvent };
