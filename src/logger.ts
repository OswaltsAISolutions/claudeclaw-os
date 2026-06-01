import { writeSync } from 'node:fs';

import pino from 'pino';

// Secrets leak into logs two ways. The one we actually observed comes through
// THIRD-PARTY error objects: grammy's HttpError nests a FetchError whose
// `.message` is the full request URL, e.g.
// `https://api.telegram.org/bot<id>:<token>/deleteWebhook`, so a transient
// network blip prints the bot token to journald. The second is any of our own
// log calls that happen to interpolate a token-bearing URL into the message
// string (dashboard / API `?token=...` links). We cover both: the `err`
// serializer scrubs the whole error tree, and a logMethod hook scrubs string
// log arguments, so a log later pasted into an issue can't leak a credential.
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

/** Scrub secrets from the positional args of a pino log call. Only STRING
 *  args (the message and any printf-style extras) are redacted; object args
 *  are left untouched so we never mutate a caller's data on the log hot path
 *  (the `err` field is handled by its serializer). Pure: returns a new array. */
export function redactLogArgs(args: unknown[]): unknown[] {
  return args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a));
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

/** Last-gasp crash logging. An unhandled exception/rejection otherwise prints
 *  Node's RAW stack to stderr, which BYPASSES the `err` serializer's redaction —
 *  so a token-bearing error (e.g. grammy's HttpError, whose message is the full
 *  bot-token URL) would leak the credential to journald on crash, defeating the
 *  redaction this module exists for. We also can't trust the async pino transport
 *  here: this service runs without NODE_ENV set, so it uses the pino-pretty worker
 *  thread, which may be torn down before it flushes on exit. So write a REDACTED
 *  line SYNCHRONOUSLY to fd 2 (bypasses stream buffering, guaranteed before exit),
 *  then preserve fatal-crash semantics by exiting non-zero so systemd restarts
 *  clean. We do NOT swallow-and-continue: after an uncaughtException the process
 *  may be in an undefined state, and Node treats unhandledRejection as fatal by
 *  default, so exiting just makes the existing crash observable + secret-safe.
 *  `exit`/`write` are injectable purely for tests. */
export function handleFatal(
  kind: 'uncaughtException' | 'unhandledRejection',
  reason: unknown,
  opts: { exit?: (code: number) => void; write?: (msg: string) => void } = {},
): void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const write = opts.write ?? ((msg: string) => { writeSync(2, msg); });
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    write(`FATAL ${kind}: ${redactSecrets(err.stack || err.message || String(err))}\n`);
  } catch {
    // The crash handler must never throw.
  }
  exit(1);
}

let crashHandlersInstalled = false;
/** Register process-level crash handlers exactly once (idempotent). */
export function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: { err: scrubErrSerializer },
  hooks: {
    logMethod(inputArgs, method) {
      return method.apply(this, redactLogArgs(inputArgs as unknown[]) as Parameters<typeof method>);
    },
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
