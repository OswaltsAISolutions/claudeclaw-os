import type { RawApi, Transformer } from 'grammy';

import { logger } from './logger.js';

// Outbound Telegram sends had NO transient-failure handling. On a 429 (flood
// control, reachable when Jarvis streams chunked/bursty output to its single
// chat) or a transient network blip (the exact grammy HttpError class observed
// on deleteWebhook and OAuth-alert sends), sendHtmlWithPlainFallback rethrows,
// the error propagates to bot.catch, and it is only LOGGED. So Jarvis could
// finish a full Opus turn and then silently drop the reply: the expensive work
// succeeds, the cheap final delivery is lost, and the operator hears nothing.
// This installs a grammy API transformer that transparently retries TRANSIENT
// send failures. The retry decision is split into a pure function so it can be
// unit-tested without grammy or a live network.

/** A normalized view of one failed Telegram API call, so the retry decision is
 *  a pure function of data (no grammy/network needed to test it). */
export interface TelegramFailure {
  /** 'network' = the HTTP call itself threw (fetch failed / reset / timeout);
   *  'api' = Telegram answered with ok:false and an error_code. */
  kind: 'network' | 'api';
  /** Telegram's error_code (present only when kind === 'api'). */
  errorCode?: number;
  /** Seconds Telegram asked us to wait (429 flood control), when provided. */
  retryAfter?: number;
}

export interface RetryDecision {
  retry: boolean;
  /** Wait before the next attempt, in ms (0 when retry is false). */
  delayMs: number;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Methods whose failure means a user-visible message did NOT reach the
 *  operator, so a transient retry is worth the small, documented at-least-once
 *  duplicate risk on a network blip. Deliberately EXCLUDES getUpdates (grammy
 *  owns polling retry + shutdown abort), sendChatAction (ephemeral typing
 *  indicator), and every read/admin call, to keep the retry blast radius on
 *  exactly the delivery path this exists to protect. */
export const RETRYABLE_SEND_METHODS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendVoice',
]);

/** Pure: given a failed send and how many retries already happened, decide
 *  whether to retry and after how long. Retries ONLY transient failures
 *  (network errors, 429 flood control honoring retry_after, and 5xx server
 *  errors); never permanent 4xx (bad request / blocked / unauthorized).
 *  Bounded by maxRetries and a delay ceiling so even a hostile retry_after
 *  cannot stall the send queue indefinitely. */
export function decideTelegramRetry(
  failure: TelegramFailure,
  retriesSoFar: number,
  opts: RetryOptions = {},
): RetryDecision {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;

  // Budget exhaustion beats transience: once we are out of retries, stop,
  // whatever the failure kind.
  if (retriesSoFar >= maxRetries) return { retry: false, delayMs: 0 };

  const backoff = Math.min(baseDelayMs * 2 ** retriesSoFar, maxDelayMs);

  if (failure.kind === 'network') {
    return { retry: true, delayMs: backoff };
  }

  const code = failure.errorCode ?? 0;
  if (code === 429) {
    const requested = failure.retryAfter != null ? failure.retryAfter * 1000 : backoff;
    // Honor Telegram's requested wait, but never below our own backoff and
    // never above the ceiling.
    return { retry: true, delayMs: Math.min(Math.max(requested, backoff), maxDelayMs) };
  }
  if (code >= 500) {
    return { retry: true, delayMs: backoff };
  }
  // 4xx and anything else: permanent. Surface immediately.
  return { retry: false, delayMs: 0 };
}

/** The slice of an AbortSignal we actually use. grammy types its transformer
 *  signal against the `abort-controller` polyfill, not the global DOM/Node
 *  AbortSignal; this structural type is satisfied by BOTH, so abortableSleep
 *  accepts either without a cast. */
interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Sleep that resolves after `ms`, or early if `signal` aborts, WITHOUT
 *  throwing. Resolves true if it slept the full duration, false if it was
 *  aborted, so the caller can stop retrying on a graceful shutdown rather than
 *  inventing an error. */
export function abortableSleep(ms: number, signal?: AbortLike): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/** Build a grammy API transformer that transparently retries TRANSIENT
 *  failures of user-visible send methods. Installed once on `bot.api.config`,
 *  it covers every send path (ctx.reply, the dashboard relay, war-room
 *  notifications) because they share one Api instance.
 *
 *  Contract care, because a transformer wraps EVERY API call:
 *  - on success the ApiResponse is returned verbatim;
 *  - on a PERMANENT api error the ok:false response is returned UNCHANGED so
 *    grammy's Api layer still throws the normal GrammyError (we never convert
 *    it to an HttpError by throwing here);
 *  - only transient cases loop, and a deliberate abort is never retried. */
export function createTelegramRetryTransformer(opts: RetryOptions = {}): Transformer<RawApi> {
  return async (prev, method, payload, signal) => {
    if (!RETRYABLE_SEND_METHODS.has(method)) {
      return prev(method, payload, signal);
    }
    let retries = 0;
    for (;;) {
      let response: Awaited<ReturnType<typeof prev>>;
      try {
        response = await prev(method, payload, signal);
      } catch (networkErr) {
        // prev threw => the HTTP call failed at the network layer, or the
        // signal aborted. Never retry a deliberate abort.
        if (signal?.aborted) throw networkErr;
        const decision = decideTelegramRetry({ kind: 'network' }, retries, opts);
        if (!decision.retry) throw networkErr;
        logger.warn(
          { method, attempt: retries + 1, delayMs: decision.delayMs, err: networkErr },
          'Telegram send network error; retrying',
        );
        const slept = await abortableSleep(decision.delayMs, signal);
        if (!slept) throw networkErr; // aborted mid-wait: give up cleanly
        retries++;
        continue;
      }
      if (response.ok) return response;
      const decision = decideTelegramRetry(
        { kind: 'api', errorCode: response.error_code, retryAfter: response.parameters?.retry_after },
        retries,
        opts,
      );
      if (!decision.retry) return response; // permanent: let grammy throw GrammyError
      logger.warn(
        { method, errorCode: response.error_code, attempt: retries + 1, delayMs: decision.delayMs },
        'Telegram send rejected (transient); retrying',
      );
      const slept = await abortableSleep(decision.delayMs, signal);
      if (!slept) return response; // aborted mid-wait: surface the original rejection
      retries++;
    }
  };
}
