import { describe, it, expect } from 'vitest';
import { validateAgentId, suggestBotNames, pickAgentColor } from './agent-create.js';

// validateAgentId is the agent-creation wizard's first gate. It is stricter
// than AGENT_ID_RE: lowercase only, must start with a letter, max 30 chars.
// The cases below also pin a quirk worth knowing — the leading-underscore
// branch is unreachable because the regex already requires a leading [a-z],
// so "_foo" fails with the regex error, not the "reserved for templates" one.
describe('validateAgentId', () => {
  it('requires a non-empty id', () => {
    expect(validateAgentId('')).toEqual({ ok: false, error: 'Agent ID is required' });
  });

  it('rejects ids that violate the format rule', () => {
    for (const bad of ['Ops', '1abc', 'foo bar', 'foo.bar', '..', 'a/b', 'a@b', '_foo', 'a'.repeat(31)]) {
      const res = validateAgentId(bad);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/lowercase/);
    }
  });

  it('reserves "main" for the primary bot', () => {
    expect(validateAgentId('main')).toEqual({
      ok: false,
      error: '"main" is reserved for the primary bot',
    });
  });

  it('accepts well-formed, unused ids (including the 30-char boundary)', () => {
    // These are syntactically valid and will not collide with a real agent.
    expect(validateAgentId('zzztestagent')).toEqual({ ok: true });
    expect(validateAgentId('my-agent_2')).toEqual({ ok: true });
    expect(validateAgentId('a'.repeat(30))).toEqual({ ok: true });
  });
});

describe('suggestBotNames', () => {
  it('title-cases a single-word id', () => {
    expect(suggestBotNames('ops')).toEqual({
      displayName: 'ClaudeClaw Ops',
      username: 'claudeclaw_ops_bot',
    });
  });

  it('turns hyphens into spaced, title-cased words and underscores in the username', () => {
    expect(suggestBotNames('my-agent')).toEqual({
      displayName: 'ClaudeClaw My Agent',
      username: 'claudeclaw_my_agent_bot',
    });
  });

  it('handles underscore-separated ids', () => {
    expect(suggestBotNames('data_pipe')).toEqual({
      displayName: 'ClaudeClaw Data Pipe',
      username: 'claudeclaw_data_pipe_bot',
    });
  });
});

describe('pickAgentColor', () => {
  it('returns the first palette color for the first agent', () => {
    expect(pickAgentColor(0)).toBe('#4f46e5');
  });

  it('wraps around the palette via modulo (15-color palette)', () => {
    expect(pickAgentColor(15)).toBe(pickAgentColor(0));
    expect(pickAgentColor(16)).toBe(pickAgentColor(1));
  });

  it('always returns a 7-char hex color', () => {
    for (const n of [0, 1, 7, 14, 15, 99]) {
      expect(pickAgentColor(n)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
