import { describe, it, expect, beforeEach, vi } from 'vitest';

// theme.ts initializes five localStorage-backed signals (theme, custom
// accent, UI scale, show-costs, boot-audio) and validates every input so a
// corrupt or hostile stored value can't break layout or flip a product
// default. Two contracts worth pinning:
//   1. the load* initializers reject out-of-range / malformed stored values
//      and fall back to the intended default (ios-dark, accent null, scale
//      1.0, costs OFF, boot-audio ON);
//   2. the setters guard their input (accent must be #rrggbb, scale clamps
//      to [0.8, 1.6]).
// The signals are created at module load and effects fire on import, so we
// reset the module and seed localStorage per case to observe each branch.

const KEY = {
  theme: 'claudeclaw.theme',
  accent: 'claudeclaw.theme.customAccent',
  scale: 'claudeclaw.uiScale',
  costs: 'claudeclaw.showCosts',
  boot: 'claudeclaw.bootAudio',
};

async function withStorage(entries: Record<string, string>) {
  localStorage.clear();
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  vi.resetModules();
  return import('./theme');
}

beforeEach(() => {
  localStorage.clear();
});

describe('theme initial load', () => {
  it('defaults to ios-dark, restores a saved valid theme, ignores junk', async () => {
    expect((await withStorage({})).theme.value).toBe('ios-dark');
    expect((await withStorage({ [KEY.theme]: 'midnight' })).theme.value).toBe('midnight');
    expect((await withStorage({ [KEY.theme]: 'crimson' })).theme.value).toBe('crimson');
    expect((await withStorage({ [KEY.theme]: 'rainbow' })).theme.value).toBe('ios-dark');
  });
});

describe('custom accent load', () => {
  it('loads a valid lowercased hex, else null', async () => {
    expect((await withStorage({})).customAccent.value).toBeNull();
    expect((await withStorage({ [KEY.accent]: '#AABBCC' })).customAccent.value).toBe('#aabbcc');
    expect((await withStorage({ [KEY.accent]: '#abc' })).customAccent.value).toBeNull();
    expect((await withStorage({ [KEY.accent]: 'red' })).customAccent.value).toBeNull();
  });
});

describe('ui scale load', () => {
  it('accepts an in-range scale, else falls back to 1.0', async () => {
    expect((await withStorage({})).uiScale.value).toBe(1.0);
    expect((await withStorage({ [KEY.scale]: '1.25' })).uiScale.value).toBe(1.25);
    expect((await withStorage({ [KEY.scale]: '2.0' })).uiScale.value).toBe(1.0);
    expect((await withStorage({ [KEY.scale]: '0.5' })).uiScale.value).toBe(1.0);
    expect((await withStorage({ [KEY.scale]: 'abc' })).uiScale.value).toBe(1.0);
  });
});

describe('showCosts load', () => {
  it('reads on/off and defaults OFF', async () => {
    expect((await withStorage({})).showCosts.value).toBe(false);
    expect((await withStorage({ [KEY.costs]: 'on' })).showCosts.value).toBe(true);
    expect((await withStorage({ [KEY.costs]: 'off' })).showCosts.value).toBe(false);
  });
});

describe('bootAudio load', () => {
  it('reads on/off and defaults ON', async () => {
    expect((await withStorage({})).bootAudioEnabled.value).toBe(true);
    expect((await withStorage({ [KEY.boot]: 'off' })).bootAudioEnabled.value).toBe(false);
    expect((await withStorage({ [KEY.boot]: 'on' })).bootAudioEnabled.value).toBe(true);
  });
});

describe('setCustomAccent', () => {
  it('accepts valid hex lowercased, rejects junk, clears on null', async () => {
    const m = await withStorage({});
    m.setCustomAccent('#ABCDEF');
    expect(m.customAccent.value).toBe('#abcdef');
    m.setCustomAccent('not-a-color');
    expect(m.customAccent.value).toBe('#abcdef'); // rejected, unchanged
    m.setCustomAccent(null);
    expect(m.customAccent.value).toBeNull();
  });
});

describe('setUiScale', () => {
  it('clamps to [0.8, 1.6]', async () => {
    const m = await withStorage({});
    m.setUiScale(5);
    expect(m.uiScale.value).toBe(1.6);
    m.setUiScale(0.1);
    expect(m.uiScale.value).toBe(0.8);
    m.setUiScale(1.25);
    expect(m.uiScale.value).toBe(1.25);
  });
});
