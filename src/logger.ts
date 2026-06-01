import pino from 'pino';

// Secrets leak into logs through THIRD-PARTY error objects, not our own log
// calls: grammy's HttpError nests a FetchError whose `.message` is the full
// request URL, e.g. `https://api.telegram.org/bot<id>:<token>/deleteWebhook`,
// so a transient network blip prints the bot token to journald. Dashboard /
// API tokens ride the same way through any `?token=...` URL in an error. We
// scrub these patterns before pino writes them so a log that later gets pasted
// into an issue or shared for debugging can't leak a live credential.
const REDACTIONS: Array<[RegExp, string]> = [
  // Telegram bot token: `bot<numeric-id>:<token>` (token is ~35 url-safe chars).
  [/bot(\d+):[A-Za-z0-9_-]{20,}/g, 'bot$1:<redacted>'],
  // Secret-bearing query params (dashboard token, api keys) in any logged URL.
  [/([?&](?:token|api_key|apikey|access_token|key)=)[^&\s"']+/gi, '$1<redacted>'],
];

/** Scrub known secret patterns from a string. Pure + idempotent. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
  return out;
}

/** Recursively redact secret strings anywhere in a serialized value. Depth-
 *  capped and defensive: logging must never throw, so any failure falls back
 *  to the original value. */
function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      (value as Record<string, unknown>)[k] = deepRedact((value as Record<string, unknown>)[k], depth + 1);
    }
  }
  return value;
}

/** pino `err` serializer that scrubs secrets from the whole error tree
 *  (message, stack, and nested causes like grammy's HttpError.error). Falls
 *  back to the standard serializer if anything goes wrong. */
export function scrubErrSerializer(err: Error): unknown {
  const serialized = pino.stdSerializers.err(err);
  try {
    return deepRedact(serialized);
  } catch {
    return serialized;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: { err: scrubErrSerializer },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
