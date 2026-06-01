import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  initSecurity,
  isSecurityEnabled,
  isLocked,
  lock,
  unlock,
  touchActivity,
  hashPin,
  checkKillPhrase,
  audit,
  setAuditCallback,
  getScrubbedSdkEnv,
  getSecurityStatus,
  resetSecurity,
  type AuditEntry,
} from './security.js';

beforeEach(() => {
  resetSecurity();
});

describe('hashPin', () => {
  it('returns a salt:hash pair', () => {
    const out = hashPin('1234');
    const parts = out.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes hex
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
  });

  it('uses a fresh random salt each call (no two hashes collide)', () => {
    expect(hashPin('1234')).not.toBe(hashPin('1234'));
  });

  it('trims the PIN before hashing so whitespace does not matter', () => {
    // We can only observe this through unlock, which also trims.
    const stored = hashPin('  4321  ');
    initSecurity({ pinHash: stored });
    expect(unlock('4321')).toBe(true);
  });
});

describe('PIN lock state machine', () => {
  it('is disabled (never locked) when no PIN is configured', () => {
    expect(isSecurityEnabled()).toBe(false);
    expect(isLocked()).toBe(false);
    // With no PIN, unlock is a no-op success and lock does nothing.
    expect(unlock('anything')).toBe(true);
    lock();
    expect(isLocked()).toBe(false);
  });

  it('starts locked once a PIN is configured', () => {
    initSecurity({ pinHash: hashPin('1234') });
    expect(isSecurityEnabled()).toBe(true);
    expect(isLocked()).toBe(true);
  });

  it('unlocks with the correct PIN and rejects the wrong one', () => {
    initSecurity({ pinHash: hashPin('1234') });
    expect(unlock('0000')).toBe(false);
    expect(isLocked()).toBe(true);
    expect(unlock('1234')).toBe(true);
    expect(isLocked()).toBe(false);
  });

  it('re-locks on demand after unlocking', () => {
    initSecurity({ pinHash: hashPin('1234') });
    unlock('1234');
    expect(isLocked()).toBe(false);
    lock();
    expect(isLocked()).toBe(true);
  });

  it('verifies a legacy bare-hash PIN (no salt prefix)', () => {
    // Pre-salt installs stored a bare sha-256 of the PIN. Still accepted.
    const bare = crypto.createHash('sha256').update('9999').digest('hex');
    initSecurity({ pinHash: bare });
    expect(unlock('0000')).toBe(false);
    expect(unlock('9999')).toBe(true);
  });
});

describe('idle auto-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-locks after the idle window elapses', () => {
    initSecurity({ pinHash: hashPin('1234'), idleLockMinutes: 30 });
    unlock('1234');
    expect(isLocked()).toBe(false);

    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(isLocked()).toBe(false); // still inside the window

    vi.advanceTimersByTime(2 * 60 * 1000); // now 31 min idle
    expect(isLocked()).toBe(true);
  });

  it('touchActivity resets the idle countdown', () => {
    initSecurity({ pinHash: hashPin('1234'), idleLockMinutes: 30 });
    unlock('1234');

    vi.advanceTimersByTime(25 * 60 * 1000);
    touchActivity();
    vi.advanceTimersByTime(25 * 60 * 1000); // 50 min total, but 25 since touch
    expect(isLocked()).toBe(false);
  });

  it('does not auto-lock when idle lock is disabled (0 minutes)', () => {
    initSecurity({ pinHash: hashPin('1234'), idleLockMinutes: 0 });
    unlock('1234');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000); // a full day
    expect(isLocked()).toBe(false);
  });
});

describe('checkKillPhrase', () => {
  it('returns false when no kill phrase is configured', () => {
    expect(checkKillPhrase('shut it down')).toBe(false);
  });

  it('matches the phrase case-insensitively and ignores surrounding space', () => {
    initSecurity({ killPhrase: 'Red Dawn' });
    expect(checkKillPhrase('red dawn')).toBe(true);
    expect(checkKillPhrase('  RED DAWN  ')).toBe(true);
  });

  it('does not match a different message', () => {
    initSecurity({ killPhrase: 'Red Dawn' });
    expect(checkKillPhrase('red')).toBe(false);
    expect(checkKillPhrase('red dawn now')).toBe(false);
  });
});

describe('audit', () => {
  const entry: AuditEntry = {
    agentId: 'main',
    chatId: '123',
    action: 'command',
    detail: 'did a thing',
    blocked: false,
  };

  it('forwards the entry to a registered callback', () => {
    const cb = vi.fn();
    setAuditCallback(cb);
    audit(entry);
    expect(cb).toHaveBeenCalledWith(entry);
  });

  it('swallows callback errors so audit never blocks an operation', () => {
    setAuditCallback(() => {
      throw new Error('audit sink is down');
    });
    expect(() => audit(entry)).not.toThrow();
  });

  it('is a no-op (no throw) when no callback is registered', () => {
    expect(() => audit(entry)).not.toThrow();
  });
});

describe('getScrubbedSdkEnv', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Work on a copy so each test's mutations are isolated.
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('drops enumerated secret env vars', () => {
    process.env.DASHBOARD_TOKEN = 'dash';
    process.env.DB_ENCRYPTION_KEY = 'dbkey';
    process.env.TELEGRAM_BOT_TOKEN = 'tg';
    process.env.PIN_HASH = 'salt:hash';
    const env = getScrubbedSdkEnv();
    expect(env.DASHBOARD_TOKEN).toBeUndefined();
    expect(env.DB_ENCRYPTION_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PIN_HASH).toBeUndefined();
  });

  it('drops nested Claude-Code session vars so the child SDK does not attach to our IPC', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_IPC_PORT = '4567';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const env = getScrubbedSdkEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_IPC_PORT).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('drops un-enumerated secrets by name pattern (defense in depth)', () => {
    process.env.SOME_VENDOR_API_KEY = 'k';
    process.env.WEBHOOK_TOKEN = 't';
    process.env.SIGNING_SECRET = 's';
    process.env.SECRET_BACKDOOR = 'b';
    const env = getScrubbedSdkEnv();
    expect(env.SOME_VENDOR_API_KEY).toBeUndefined();
    expect(env.WEBHOOK_TOKEN).toBeUndefined();
    expect(env.SIGNING_SECRET).toBeUndefined();
    expect(env.SECRET_BACKDOOR).toBeUndefined();
  });

  it('preserves the SDK auth vars even though they look secret-shaped', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth';
    const env = getScrubbedSdkEnv();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
  });

  it('preserves benign non-secret vars', () => {
    process.env.SOME_PUBLIC_FLAG = 'on';
    const env = getScrubbedSdkEnv();
    expect(env.SOME_PUBLIC_FLAG).toBe('on');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('re-injects auth secrets supplied by the caller', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const env = getScrubbedSdkEnv({ ANTHROPIC_API_KEY: 'injected-key' });
    expect(env.ANTHROPIC_API_KEY).toBe('injected-key');
  });

  it('lets a supplied auth secret override whatever was in the environment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'from-env';
    const env = getScrubbedSdkEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'override' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('override');
  });
});

describe('getSecurityStatus', () => {
  it('reports defaults when nothing is configured', () => {
    const s = getSecurityStatus();
    expect(s.pinEnabled).toBe(false);
    expect(s.locked).toBe(false);
    expect(s.killPhraseEnabled).toBe(false);
    expect(s.idleLockMinutes).toBe(0);
  });

  it('reflects a configured PIN + kill phrase', () => {
    initSecurity({ pinHash: hashPin('1234'), idleLockMinutes: 15, killPhrase: 'boom' });
    const s = getSecurityStatus();
    expect(s.pinEnabled).toBe(true);
    expect(s.locked).toBe(true); // starts locked
    expect(s.killPhraseEnabled).toBe(true);
    expect(s.idleLockMinutes).toBe(15);
  });
});
