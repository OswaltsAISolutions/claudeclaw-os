import { describe, it, expect, vi } from 'vitest';

// logger.ts builds a pino instance at import time. In dev (NODE_ENV !==
// 'production') that attaches a pino-pretty transport, which thread-stream
// spawns as a worker thread on construction. We only exercise the pure
// redaction helpers here and never call logger.x(), but forcing production
// mode before the module evaluates keeps a stray worker out of the runner.
vi.hoisted(() => {
  process.env.NODE_ENV = 'production';
});

import { redactSecrets, scrubErrSerializer } from './logger.js';

// A clearly-fake, correctly-shaped Telegram bot token: numeric id, colon,
// then >=20 url-safe chars. Never a real credential.
const FAKE_TOKEN = 'bot7654321:AAH-FAKE_token_value_1234567890abcDEF';

describe('redactSecrets', () => {
  it('redacts a Telegram bot token while keeping the numeric bot id', () => {
    const out = redactSecrets(`request to https://api.telegram.org/${FAKE_TOKEN}/deleteWebhook failed`);
    expect(out).toContain('bot7654321:<redacted>');
    expect(out).not.toContain('AAH-FAKE_token_value_1234567890abcDEF');
  });

  it('redacts every secret-bearing query param name (token, api_key, apikey, access_token, key)', () => {
    for (const name of ['token', 'api_key', 'apikey', 'access_token', 'key']) {
      const out = redactSecrets(`https://dash.local/api?${name}=supersecretvalue123`);
      expect(out).toBe(`https://dash.local/api?${name}=<redacted>`);
    }
  });

  it('is case-insensitive on the query-param name', () => {
    expect(redactSecrets('https://x/?TOKEN=abc123')).toBe('https://x/?TOKEN=<redacted>');
    expect(redactSecrets('https://x/?Api_Key=abc123')).toBe('https://x/?Api_Key=<redacted>');
  });

  it('redacts a param mid-query without eating the following params', () => {
    expect(redactSecrets('https://x/?token=abc123&next=/home&page=2')).toBe(
      'https://x/?token=<redacted>&next=/home&page=2',
    );
  });

  it('redacts a secret on the first query param (& form) too', () => {
    expect(redactSecrets('https://x/?a=1&access_token=zzz999&b=2')).toBe(
      'https://x/?a=1&access_token=<redacted>&b=2',
    );
  });

  it('redacts multiple distinct secrets in one string', () => {
    const out = redactSecrets(`${FAKE_TOKEN} and https://x/?key=othersecret`);
    expect(out).toContain('bot7654321:<redacted>');
    expect(out).toContain('?key=<redacted>');
    expect(out).not.toContain('AAH-FAKE_token_value_1234567890abcDEF');
    expect(out).not.toContain('othersecret');
  });

  it('is idempotent (re-running over already-redacted text is a no-op)', () => {
    const once = redactSecrets(`${FAKE_TOKEN} https://x/?token=abc123`);
    expect(redactSecrets(once)).toBe(once);
  });

  it('leaves benign strings untouched (no false positives)', () => {
    for (const benign of [
      'the token bucket algorithm refills steadily',
      'GET https://api.telegram.org/file/photo.jpg 200 OK',
      'restarting com.claudeclaw.main.service',
      'bot crashed: see stack above',
      '',
    ]) {
      expect(redactSecrets(benign)).toBe(benign);
    }
  });
});

describe('scrubErrSerializer', () => {
  it('scrubs a leaked bot token from a top-level error message', () => {
    const err = new Error(`Network request failed for ${FAKE_TOKEN}`);
    const out = JSON.stringify(scrubErrSerializer(err));
    expect(out).toContain('bot7654321:<redacted>');
    expect(out).not.toContain('AAH-FAKE_token_value_1234567890abcDEF');
  });

  it('scrubs a token leaked through a nested cause (grammy HttpError shape)', () => {
    // grammy wraps the underlying network failure; the full token-bearing URL
    // rides in the inner error's message.
    const inner = new Error(
      `request to https://api.telegram.org/${FAKE_TOKEN}/deleteWebhook failed`,
    );
    const outer = new Error('Network request for "deleteWebhook" failed!') as Error & { cause?: unknown };
    outer.cause = inner;
    const out = JSON.stringify(scrubErrSerializer(outer));
    expect(out).not.toContain('AAH-FAKE_token_value_1234567890abcDEF');
    expect(out).toContain('<redacted>');
    // The non-secret framing survives so the log is still useful.
    expect(out).toContain('deleteWebhook');
  });

  it('preserves the error type/message structure for a clean error', () => {
    const serialized = scrubErrSerializer(new Error('plain boom')) as { type?: string; message?: string };
    expect(serialized.message).toBe('plain boom');
    expect(serialized.type).toBe('Error');
  });

  it('does not hang or throw on a circular object and still scrubs the message', () => {
    // The depth cap in deepRedact must keep a self-referential error from
    // looping forever. Assert on the lifted message field rather than
    // JSON.stringify, which would choke on the cycle itself.
    const cyclic = new Error(`boom ${FAKE_TOKEN}`) as Error & { self?: unknown };
    cyclic.self = cyclic;
    const serialized = scrubErrSerializer(cyclic) as { message?: string };
    expect(serialized.message).toContain('bot7654321:<redacted>');
    expect(serialized.message).not.toContain('AAH-FAKE_token_value_1234567890abcDEF');
  });
});
