import { describe, it, expect } from 'vitest';
import path from 'path';
import { AGENT_ID_RE, agentExists, resolveAgentDir } from './agent-config.js';

// AGENT_ID_RE is the single guard the dashboard HTTP layer runs on the
// untrusted :agentId path param before it ever touches the filesystem.
// If it ever loosened to admit a separator or a dot, an attacker could
// walk out of agents/ (path traversal), so these cases are load-bearing.
describe('AGENT_ID_RE', () => {
  it('accepts well-formed ids (alnum, underscore, hyphen)', () => {
    for (const id of ['main', 'ops', 'agent_1', 'my-agent', 'a', 'a1_b-2']) {
      expect(AGENT_ID_RE.test(id)).toBe(true);
    }
  });

  it('accepts uppercase too (the historical i flag is intentional)', () => {
    expect(AGENT_ID_RE.test('Main')).toBe(true);
    expect(AGENT_ID_RE.test('OPS')).toBe(true);
  });

  it('rejects the empty string (at least one char required)', () => {
    expect(AGENT_ID_RE.test('')).toBe(false);
  });

  it('rejects path-traversal and separator attempts', () => {
    for (const id of ['..', '../etc/passwd', 'foo/bar', 'foo\\bar', '/abs', '.']) {
      expect(AGENT_ID_RE.test(id)).toBe(false);
    }
  });

  it('rejects dots, spaces, and other punctuation', () => {
    for (const id of ['foo.bar', 'foo bar', 'foo@bar', 'a.b', 'a b', 'a!', '%2e%2e']) {
      expect(AGENT_ID_RE.test(id)).toBe(false);
    }
  });
});

describe('agentExists', () => {
  it('always reports main as existing (it is the root process)', () => {
    expect(agentExists('main')).toBe(true);
  });

  it('rejects syntactically invalid ids before touching the filesystem', () => {
    expect(agentExists('../etc')).toBe(false);
    expect(agentExists('foo/bar')).toBe(false);
    expect(agentExists('')).toBe(false);
  });

  it('returns false for a syntactically valid id that has no agent.yaml on disk', () => {
    expect(agentExists('zzz-no-such-agent-98765')).toBe(false);
  });
});

describe('resolveAgentDir', () => {
  it('falls back to the repo agents/<id> dir for an unknown agent', () => {
    const dir = resolveAgentDir('zzz-no-such-agent-98765');
    expect(dir.endsWith(path.join('agents', 'zzz-no-such-agent-98765'))).toBe(true);
  });
});
