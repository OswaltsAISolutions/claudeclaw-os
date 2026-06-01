import { describe, it, expect, beforeEach, vi } from 'vitest';

// privacy.ts persists a per-section screenshot-blur preference in
// localStorage (memories / hive / scheduled). The data-safety contract is:
// unblurred is the default ONLY when nothing is stored, the explicit
// on/off key wins over the legacy blurred/revealed key, and a toggle both
// flips the signal and writes it back. A regression that defaults to
// unblurred when a preference exists, or fails to persist, silently leaks
// sensitive content on screen — so we pin it.
//
// The module memoizes one signal per section, so loadInitial only runs the
// first time a section is read. To exercise every initial state we reset
// the module (fresh signal cache) and seed localStorage before importing.

async function fresh() {
  vi.resetModules();
  return import('./privacy');
}

beforeEach(() => {
  localStorage.clear();
});

describe('privacyBlur initial state', () => {
  it('defaults to unblurred when nothing is stored', async () => {
    const { privacyBlur } = await fresh();
    expect(privacyBlur('memories').value).toBe(false);
  });

  it('reads the explicit on/off preference', async () => {
    localStorage.setItem('claudeclaw.privacy.memories', 'on');
    localStorage.setItem('claudeclaw.privacy.hive', 'off');
    const { privacyBlur } = await fresh();
    expect(privacyBlur('memories').value).toBe(true);
    expect(privacyBlur('hive').value).toBe(false);
  });

  it('falls back to the legacy blurred/revealed keys', async () => {
    localStorage.setItem('privacyBlur_memories_all', 'blurred');
    localStorage.setItem('privacyBlur_hive_all', 'revealed');
    const { privacyBlur } = await fresh();
    expect(privacyBlur('memories').value).toBe(true);
    expect(privacyBlur('hive').value).toBe(false);
  });

  it('prefers the new key over the legacy key', async () => {
    localStorage.setItem('claudeclaw.privacy.memories', 'off');
    localStorage.setItem('privacyBlur_memories_all', 'blurred');
    const { privacyBlur } = await fresh();
    expect(privacyBlur('memories').value).toBe(false);
  });

  it('returns the same signal instance per section', async () => {
    const { privacyBlur } = await fresh();
    expect(privacyBlur('scheduled')).toBe(privacyBlur('scheduled'));
  });
});

describe('togglePrivacyBlur', () => {
  it('flips the value and persists on/off', async () => {
    const { privacyBlur, togglePrivacyBlur } = await fresh();
    expect(privacyBlur('memories').value).toBe(false);

    togglePrivacyBlur('memories');
    expect(privacyBlur('memories').value).toBe(true);
    expect(localStorage.getItem('claudeclaw.privacy.memories')).toBe('on');

    togglePrivacyBlur('memories');
    expect(privacyBlur('memories').value).toBe(false);
    expect(localStorage.getItem('claudeclaw.privacy.memories')).toBe('off');
  });

  it('keeps sections independent', async () => {
    const { privacyBlur, togglePrivacyBlur } = await fresh();
    togglePrivacyBlur('memories');
    expect(privacyBlur('memories').value).toBe(true);
    expect(privacyBlur('hive').value).toBe(false);
    expect(localStorage.getItem('claudeclaw.privacy.hive')).toBeNull();
  });
});
