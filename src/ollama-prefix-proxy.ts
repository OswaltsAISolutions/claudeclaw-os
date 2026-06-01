// Tiny HTTP proxy that sits between full `claw` and Windows-host Ollama.
//
// Background: claw-code 0.1.3 requires a `provider/model` slug to validate
// the model argument (e.g. `openai/qwen3-coder:30b`). When the configured
// `OPENAI_BASE_URL` is a custom gateway, claw forwards the FULL slug —
// prefix included — to the API. Ollama's OpenAI-compat endpoint doesn't
// recognize `openai/qwen3-coder:30b` (it only knows `qwen3-coder:30b`),
// so it returns 404 and the agent loop dies before it can do anything.
//
// claw has a `strip_routing_prefix` function in its source that documents
// exactly this case ("the backend expects the bare model id"), but the
// path that calls it is gated behind a condition that doesn't fire for
// custom base URLs. Rather than patch claw upstream, we slot this thin
// proxy in between: claw points at us, we strip the prefix, we forward
// to Ollama. Result: full-claw specialists (atlas, mercury, sentinel)
// can talk to local Ollama without any source patches.
//
// Lifecycle: started from src/index.ts when the service boots, killed
// when the service stops. Listens on 127.0.0.1 only (no external auth
// because there's no external surface).

import http from 'node:http';
import { logger } from './logger.js';
import { resolveOllamaBaseUrl } from './ollama.js';

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = parseInt(process.env.OLLAMA_PROXY_PORT || '11435', 10);

/** Known routing prefixes that claw injects but Ollama doesn't want.
 *  Keep in sync with claw's `strip_routing_prefix` in
 *  rust/crates/api/src/providers/openai_compat.rs. */
const ROUTING_PREFIXES = new Set(['openai', 'xai', 'grok', 'qwen', 'kimi']);

export function stripRoutingPrefix(model: string): string {
  if (!model) return model;
  const slash = model.indexOf('/');
  if (slash < 0) return model;
  const prefix = model.slice(0, slash).toLowerCase();
  if (ROUTING_PREFIXES.has(prefix)) return model.slice(slash + 1);
  return model;
}

/** Qwen3-family models emit `<think>...</think>` reasoning blocks that
 *  sometimes fill the response without ever closing into a real answer.
 *  Ollama exposes a `think: false` request parameter that disables this
 *  behavior at the model level. We inject it for Qwen3 models so atlas
 *  / mercury / coder produce direct answers instead of dying inside a
 *  thinking buffer. Recognises both `qwen3-coder:30b` and prefix-stripped
 *  abliterated variants like `huihui_ai/Qwen3.6-abliterated:35b`. */
export function isQwen3Family(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('qwen3');
}

/** Strip any unclosed or closed <think>...</think> blocks from the
 *  assistant's content. Belt-and-suspenders for the case where
 *  `think: false` isn't honored upstream — the user sees the final
 *  answer cleanly even if the model emits a stray thinking tag. */
export function stripThinkingTags(text: string): string {
  if (!text) return text;
  // Closed pairs: <think>...</think>
  let out = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  // Unclosed prefix: starts with <think> but no </think> ever
  out = out.replace(/^<think>[\s\S]*$/i, '').trim();
  return out;
}

/** Process a single SSE line, stripping content that falls inside a
 *  <think>...</think> region. Used for the streaming path where the
 *  full response arrives as `data: {...}` chunks and a Qwen3 model
 *  may split a single thinking block across many chunks.
 *
 *  Strategy: for each `data: {...}` line, parse the JSON, look at
 *  choices[0].delta.content, walk through it character-by-character
 *  tracking <think> open/close. Drop content while inside. Re-emit
 *  the chunk with cleaned content. Pass-through non-data lines
 *  (comments, [DONE] markers, blank lines) verbatim.
 *
 *  State is held by the caller across chunks via getInside/setInside
 *  closures, so a thinking block split across two HTTP packets still
 *  closes cleanly.
 */
export function processSseLine(
  line: string,
  getInside: () => boolean,
  setInside: (v: boolean) => void,
): string {
  // SSE non-data lines pass through unchanged.
  if (!line.startsWith('data:')) return line;
  const payload = line.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return line;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(payload) as Record<string, unknown>; }
  catch { return line; }

  // OpenAI-compat streaming: choices[].delta.content
  const choices = obj['choices'] as Array<{ delta?: { content?: string } }> | undefined;
  if (Array.isArray(choices)) {
    let modified = false;
    for (const ch of choices) {
      if (ch?.delta && typeof ch.delta.content === 'string') {
        const cleaned = stripFromContent(ch.delta.content, getInside, setInside);
        if (cleaned !== ch.delta.content) {
          ch.delta.content = cleaned;
          modified = true;
        }
      }
    }
    if (modified) return `data: ${JSON.stringify(obj)}`;
  }

  // Ollama native streaming: message.content
  const msg = obj['message'] as { content?: string } | undefined;
  if (msg && typeof msg.content === 'string') {
    const cleaned = stripFromContent(msg.content, getInside, setInside);
    if (cleaned !== msg.content) {
      msg.content = cleaned;
      return `data: ${JSON.stringify(obj)}`;
    }
  }
  return line;
}

/** Strip <think>...</think> regions from a content fragment that may
 *  enter/exit a thinking block mid-fragment. Tracks open/close state
 *  across calls via getInside/setInside so a thinking block split
 *  across many SSE chunks resolves cleanly. */
export function stripFromContent(
  content: string,
  getInside: () => boolean,
  setInside: (v: boolean) => void,
): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (getInside()) {
      // Look for </think>
      const closeIdx = content.indexOf('</think>', i);
      if (closeIdx < 0) {
        // Stays inside; emit nothing and we're done with this chunk.
        return out;
      }
      // Skip the </think> tag and clear state.
      i = closeIdx + '</think>'.length;
      setInside(false);
    } else {
      const openIdx = content.indexOf('<think>', i);
      if (openIdx < 0) {
        // No more thinking openers — append remainder and done.
        out += content.slice(i);
        return out;
      }
      // Emit up to the <think> opener; flip state.
      out += content.slice(i, openIdx);
      i = openIdx + '<think>'.length;
      setInside(true);
    }
  }
  return out;
}

let serverInstance: http.Server | null = null;

/** Start the proxy. Idempotent: a second call is a no-op. */
export function startOllamaPrefixProxy(): void {
  if (serverInstance) {
    logger.debug({ port: PROXY_PORT }, '[ollama-proxy] already running');
    return;
  }

  const server = http.createServer((req, res) => {
    // We only proxy /v1/* paths. Everything else is a 404 (e.g. a stray
    // health probe). Strict so misrouted traffic fails loud.
    if (!req.url || !req.url.startsWith('/v1/')) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // Read the request body so we can rewrite the `model` field on
    // POST /v1/chat/completions. GET /v1/models and similar pass through
    // unchanged. The body is JSON (OpenAI-compat) so we parse, mutate,
    // and re-serialize.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      let bodyBuf = Buffer.concat(chunks);
      let isQwen3 = false;
      if (req.method === 'POST' && bodyBuf.length > 0) {
        try {
          const obj = JSON.parse(bodyBuf.toString('utf8')) as Record<string, unknown>;
          let mutated = false;
          if (typeof obj['model'] === 'string') {
            const original = obj['model'] as string;
            const stripped = stripRoutingPrefix(original);
            if (stripped !== original) {
              obj['model'] = stripped;
              mutated = true;
              logger.debug({ original, stripped }, '[ollama-proxy] stripped prefix');
            }
            // Detect Qwen3 on the final (stripped) name and disable
            // thinking. Ollama 0.24+ honors `think: false` to make the
            // model emit content directly instead of <think> blocks.
            isQwen3 = isQwen3Family(stripped);
            if (isQwen3 && obj['think'] === undefined) {
              obj['think'] = false;
              mutated = true;
              logger.debug({ model: stripped }, '[ollama-proxy] injected think:false for Qwen3');
            }
          }
          if (mutated) {
            bodyBuf = Buffer.from(JSON.stringify(obj), 'utf8');
          }
        } catch (err) {
          // Body wasn't JSON — pass through unchanged. Ollama will reject it
          // if it's actually malformed, which we relay to the caller.
          logger.debug({ err: (err as Error).message }, '[ollama-proxy] non-JSON body, passing through');
        }
      }

      // Build the upstream URL by stripping our `/v1` mount and appending
      // to the resolved Ollama base. The base URL helper handles WSL2 →
      // Windows-host gateway-IP detection.
      const upstreamBase = resolveOllamaBaseUrl();
      const upstreamUrl = `${upstreamBase}${req.url}`;

      // Forward headers minus host/content-length (let fetch redo those).
      const fwdHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'content-length') continue;
        if (typeof v === 'string') fwdHeaders[k] = v;
        else if (Array.isArray(v)) fwdHeaders[k] = v.join(', ');
      }

      try {
        const upstream = await fetch(upstreamUrl, {
          method: req.method,
          headers: fwdHeaders,
          body: bodyBuf.length > 0 ? bodyBuf : undefined,
        });
        // Mirror status + headers.
        res.statusCode = upstream.status;
        upstream.headers.forEach((value, name) => {
          // Skip transfer-encoding; Node sets it for us based on the
          // streaming body.
          if (name.toLowerCase() === 'transfer-encoding') return;
          res.setHeader(name, value);
        });
        if (upstream.body) {
          const upstreamCt = (upstream.headers.get('content-type') || '').toLowerCase();
          const isJsonResponse = upstreamCt.includes('application/json');
          // For Qwen3 non-streaming responses, buffer + strip <think>
          // blocks from the assistant content before re-emitting. This
          // catches the case where Ollama ignores `think: false` and
          // emits thinking tags inline. Streaming SSE passes through
          // unchanged (handled by the model's own `think: false` honor).
          if (isQwen3 && isJsonResponse) {
            const reader = upstream.body.getReader();
            const parts: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) parts.push(value);
            }
            const full = Buffer.concat(parts.map((p) => Buffer.from(p)));
            let outBuf: Buffer = full;
            try {
              const parsed = JSON.parse(full.toString('utf8')) as {
                choices?: Array<{ message?: { content?: string } }>;
                message?: { content?: string };
              };
              let touched = false;
              // OpenAI-compat shape: choices[].message.content
              if (Array.isArray(parsed.choices)) {
                for (const ch of parsed.choices) {
                  if (ch?.message && typeof ch.message.content === 'string') {
                    const before = ch.message.content;
                    const after = stripThinkingTags(before);
                    if (after !== before) {
                      ch.message.content = after;
                      touched = true;
                    }
                  }
                }
              }
              // Ollama native shape: message.content
              if (parsed.message && typeof parsed.message.content === 'string') {
                const before = parsed.message.content;
                const after = stripThinkingTags(before);
                if (after !== before) {
                  parsed.message.content = after;
                  touched = true;
                }
              }
              if (touched) {
                outBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
                logger.info(
                  { delta: full.length - outBuf.length },
                  '[ollama-proxy] stripped <think> tags from response',
                );
                // Update content-length so claw doesn't bail on mismatch.
                res.setHeader('content-length', String(outBuf.length));
              }
            } catch {
              // Couldn't parse — pass through unchanged.
            }
            res.write(outBuf);
          } else if (isQwen3 && upstreamCt.includes('text/event-stream')) {
            // For Qwen3 SSE responses (the path full claw uses), parse
            // each `data: {...}` chunk, drop any content emitted while
            // we're inside a <think>...</think> region. This is the
            // critical fix: claw streams + Qwen3 + thinking ⇒ assembled
            // text is all `<think>` content with no actual answer.
            // Stripping per-chunk means claw's assembled text contains
            // only the real assistant output.
            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            let textBuf = '';                // unparsed SSE accumulator
            let insideThink = false;          // state across chunks
            let lineBuf = '';                 // unfinished SSE line
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              lineBuf += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl);
                lineBuf = lineBuf.slice(nl + 1);
                textBuf += processSseLine(line, () => insideThink, (v) => { insideThink = v; }) + '\n';
              }
              // Flush whole completed lines to the downstream client.
              if (textBuf) {
                res.write(Buffer.from(textBuf, 'utf8'));
                textBuf = '';
              }
            }
            // Drain any trailing line (rare with SSE which usually ends in \n).
            if (lineBuf) {
              res.write(Buffer.from(processSseLine(lineBuf, () => insideThink, (v) => { insideThink = v; }), 'utf8'));
            }
          } else {
            // Stream the response body so SSE / chat-completion streams
            // pass through with proper chunking. Node 18+ has Response.body
            // as a Web ReadableStream; pipe it via for-await.
            const reader = upstream.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
        }
        res.end();
      } catch (err) {
        logger.error({ err: (err as Error).message, upstreamUrl }, '[ollama-proxy] upstream fetch failed');
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          error: 'upstream fetch failed',
          message: (err as Error).message,
        }));
      }
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message }, '[ollama-proxy] request error');
    });
  });

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    logger.info(
      { host: PROXY_HOST, port: PROXY_PORT, upstream: resolveOllamaBaseUrl() },
      '[ollama-proxy] listening',
    );
  });

  server.on('error', (err) => {
    logger.error({ err: err.message }, '[ollama-proxy] server error');
  });

  serverInstance = server;
}

/** Stop the proxy. Idempotent. */
export function stopOllamaPrefixProxy(): void {
  if (!serverInstance) return;
  serverInstance.close();
  serverInstance = null;
}

/** Base URL to hand to claw subprocesses via OPENAI_BASE_URL. Includes
 *  the /v1 mount that OpenAI-compatible clients expect. */
export const PROXY_BASE_URL_V1 = `http://${PROXY_HOST}:${PROXY_PORT}/v1`;
