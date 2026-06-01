import { describe, it, expect, vi } from 'vitest';

import {
  decideTelegramRetry,
  abortableSleep,
  createTelegramRetryTransformer,
  RETRYABLE_SEND_METHODS,
} from './telegram-retry.js';

// The transformer is generic over the Telegram method; in tests we call it with
// fake `prev` functions and plain response literals, so cast it to a loose
// callable once rather than satisfying the full grammy generic at each call.
type LoosePrev = (...a: unknown[]) => Promise<unknown>;
function asRunner(opts?: Parameters<typeof createTelegramRetryTransformer>[0]) {
  const t = createTelegramRetryTransformer(opts);
  return t as unknown as (
    prev: LoosePrev,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

const OK = (id = 1) => ({ ok: true as const, result: { message_id: id } });
const API_ERR = (error_code: number, parameters?: { retry_after?: number }) => ({
  ok: false as const,
  error_code,
  description: `code ${error_code}`,
  ...(parameters ? { parameters } : {}),
});

describe('decideTelegramRetry (pure decision)', () => {
  it('retries network failures with exponential backoff until the budget runs out', () => {
    expect(decideTelegramRetry({ kind: 'network' }, 0)).toEqual({ retry: true, delayMs: 500 });
    expect(decideTelegramRetry({ kind: 'network' }, 1)).toEqual({ retry: true, delayMs: 1000 });
    expect(decideTelegramRetry({ kind: 'network' }, 2)).toEqual({ retry: true, delayMs: 2000 });
    // 4th attempt (retriesSoFar === maxRetries default 3): give up.
    expect(decideTelegramRetry({ kind: 'network' }, 3)).toEqual({ retry: false, delayMs: 0 });
  });

  it('honors a 429 retry_after (seconds -> ms), never below backoff, never above the cap', () => {
    expect(decideTelegramRetry({ kind: 'api', errorCode: 429, retryAfter: 5 }, 0)).toEqual({
      retry: true,
      delayMs: 5000,
    });
    // A hostile/huge retry_after is clamped to the 30s ceiling.
    expect(decideTelegramRetry({ kind: 'api', errorCode: 429, retryAfter: 100 }, 0)).toEqual({
      retry: true,
      delayMs: 30_000,
    });
    // No retry_after provided -> fall back to backoff for the attempt.
    expect(decideTelegramRetry({ kind: 'api', errorCode: 429 }, 1)).toEqual({
      retry: true,
      delayMs: 1000,
    });
  });

  it('retries 5xx server errors but never permanent 4xx', () => {
    expect(decideTelegramRetry({ kind: 'api', errorCode: 500 }, 0)).toEqual({ retry: true, delayMs: 500 });
    expect(decideTelegramRetry({ kind: 'api', errorCode: 503 }, 2)).toEqual({ retry: true, delayMs: 2000 });
    for (const code of [400, 401, 403, 404, 409]) {
      expect(decideTelegramRetry({ kind: 'api', errorCode: code }, 0)).toEqual({ retry: false, delayMs: 0 });
    }
  });

  it('lets the retry budget override transience (exhausted 429 does not retry)', () => {
    expect(decideTelegramRetry({ kind: 'api', errorCode: 429, retryAfter: 1 }, 3)).toEqual({
      retry: false,
      delayMs: 0,
    });
    // Custom tighter budget.
    expect(decideTelegramRetry({ kind: 'network' }, 1, { maxRetries: 1 })).toEqual({
      retry: false,
      delayMs: 0,
    });
  });
});

describe('abortableSleep', () => {
  it('resolves true after sleeping the full duration', async () => {
    await expect(abortableSleep(1)).resolves.toBe(true);
  });

  it('resolves false immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(10_000, ac.signal)).resolves.toBe(false);
  });

  it('resolves false (not throw) when aborted mid-wait', async () => {
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBe(false);
  });
});

describe('createTelegramRetryTransformer (grammy transformer contract)', () => {
  // 0-delay so retries don't actually wait in tests.
  const fast = { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 3 };

  it('passes a successful response through verbatim (same reference, called once)', async () => {
    const run = asRunner(fast);
    const ok = OK();
    const prev = vi.fn<LoosePrev>().mockResolvedValue(ok);
    const out = await run(prev, 'sendMessage', { chat_id: 1, text: 'hi' });
    expect(out).toBe(ok);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('does NOT touch non-send methods, even on a retryable-looking error', async () => {
    const run = asRunner(fast);
    const err = API_ERR(500);
    const prev = vi.fn<LoosePrev>().mockResolvedValue(err);
    const out = await run(prev, 'getMe', {});
    expect(out).toBe(err); // returned untouched
    expect(prev).toHaveBeenCalledTimes(1); // 500 would retry IF it were a send; it is not
    expect(RETRYABLE_SEND_METHODS.has('getMe')).toBe(false);
  });

  it('retries a 429 then returns the eventual success', async () => {
    const run = asRunner(fast);
    const prev = vi
      .fn<LoosePrev>()
      .mockResolvedValueOnce(API_ERR(429, { retry_after: 0 }))
      .mockResolvedValueOnce(OK(2));
    const out = await run(prev, 'sendMessage', { chat_id: 1, text: 'hi' });
    expect(out).toEqual(OK(2));
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('returns a permanent 4xx response UNCHANGED without retrying (grammy still throws GrammyError)', async () => {
    const run = asRunner(fast);
    const err = API_ERR(400);
    const prev = vi.fn<LoosePrev>().mockResolvedValue(err);
    const out = await run(prev, 'sendMessage', { chat_id: 1, text: 'hi' });
    expect(out).toBe(err);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown network error then succeeds', async () => {
    const run = asRunner(fast);
    const prev = vi
      .fn<LoosePrev>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(OK(3));
    const out = await run(prev, 'sendDocument', { chat_id: 1 });
    expect(out).toEqual(OK(3));
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original error after exhausting the retry budget', async () => {
    const run = asRunner(fast);
    const boom = new Error('network down');
    const prev = vi.fn<LoosePrev>().mockRejectedValue(boom);
    await expect(run(prev, 'sendMessage', { chat_id: 1, text: 'x' })).rejects.toBe(boom);
    expect(prev).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('never retries when the signal is already aborted (graceful shutdown)', async () => {
    const run = asRunner(fast);
    const ac = new AbortController();
    ac.abort();
    const boom = new Error('aborted send');
    const prev = vi.fn<LoosePrev>().mockRejectedValue(boom);
    await expect(run(prev, 'sendMessage', { chat_id: 1, text: 'x' }, ac.signal)).rejects.toBe(boom);
    expect(prev).toHaveBeenCalledTimes(1);
  });
});
