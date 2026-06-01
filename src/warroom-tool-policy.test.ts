import { describe, it, expect } from 'vitest';
import { warRoomToolPolicy, filterMcpServers } from './warroom-tool-policy.js';

// The read-only built-ins that must ALWAYS be allowed (they're safe for
// "answer in chat" turns) and the side-effect built-ins that must be
// default-denied unless an agent explicitly opts in. These mirror the
// hardcoded sets in warroom-tool-policy.ts; the whole point of this module
// is that a misconfigured agent.yaml can't grant browser/file/M365 access,
// so the tests pin the security contract rather than the implementation.
const SAFE_READONLY = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const SIDE_EFFECT = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'ExitPlanMode', 'Skill'];

describe('warRoomToolPolicy', () => {
  it('default-denies every side-effect tool for an unknown agent', () => {
    const policy = warRoomToolPolicy('totally-unknown-agent');
    expect(policy.allowedTools.sort()).toEqual([...SAFE_READONLY].sort());
    expect(policy.disallowedTools.sort()).toEqual([...SIDE_EFFECT].sort());
    expect(policy.allowedMcpServers).toEqual([]);
  });

  it('treats main as read-only (route to a specialist, do not act)', () => {
    const policy = warRoomToolPolicy('main');
    expect(policy.allowedTools.sort()).toEqual([...SAFE_READONLY].sort());
    expect(policy.disallowedTools.sort()).toEqual([...SIDE_EFFECT].sort());
    expect(policy.allowedMcpServers).toEqual([]);
  });

  it('always exposes the full read-only set so chat answers work', () => {
    for (const agent of ['main', 'ops', 'comms', 'content', 'research', 'mystery']) {
      const policy = warRoomToolPolicy(agent);
      for (const tool of SAFE_READONLY) {
        expect(policy.allowedTools).toContain(tool);
      }
    }
  });

  it('never lists a read-only tool as disallowed', () => {
    for (const agent of ['main', 'ops', 'comms', 'content', 'research']) {
      const policy = warRoomToolPolicy(agent);
      for (const tool of SAFE_READONLY) {
        expect(policy.disallowedTools).not.toContain(tool);
      }
    }
  });

  it('gives ops its default Bash + Skill opt-ins', () => {
    const policy = warRoomToolPolicy('ops');
    expect(policy.allowedTools).toContain('Bash');
    expect(policy.allowedTools).toContain('Skill');
    expect(policy.disallowedTools).not.toContain('Bash');
    expect(policy.disallowedTools).not.toContain('Skill');
    // Everything it did NOT opt into is still denied.
    expect(policy.disallowedTools.sort()).toEqual(
      ['Write', 'Edit', 'NotebookEdit', 'ExitPlanMode'].sort(),
    );
  });

  it('gives content Skill + Write but not Bash', () => {
    const policy = warRoomToolPolicy('content');
    expect(policy.allowedTools).toContain('Skill');
    expect(policy.allowedTools).toContain('Write');
    expect(policy.allowedTools).not.toContain('Bash');
    expect(policy.disallowedTools).toContain('Bash');
  });

  it('keeps research read-only by default', () => {
    const policy = warRoomToolPolicy('research');
    expect(policy.allowedTools.sort()).toEqual([...SAFE_READONLY].sort());
    expect(policy.disallowedTools.sort()).toEqual([...SIDE_EFFECT].sort());
  });

  it('lets an explicit allowlist REPLACE the per-agent default', () => {
    // ops normally gets Bash + Skill; an explicit override drops those and
    // grants only what is named, so an operator can tighten an agent.
    const policy = warRoomToolPolicy('ops', ['Edit']);
    expect(policy.allowedTools).toContain('Edit');
    expect(policy.allowedTools).not.toContain('Bash');
    expect(policy.allowedTools).not.toContain('Skill');
    expect(policy.disallowedTools).toContain('Bash');
    expect(policy.disallowedTools).toContain('Skill');
  });

  it('treats an empty override array as "use the default"', () => {
    // overrides only kick in when length > 0, so [] must NOT silently strip
    // ops of its Bash/Skill defaults.
    const policy = warRoomToolPolicy('ops', []);
    expect(policy.allowedTools).toContain('Bash');
    expect(policy.allowedTools).toContain('Skill');
  });

  it('de-duplicates when an override repeats a read-only tool', () => {
    const policy = warRoomToolPolicy('main', ['Read', 'Bash']);
    const reads = policy.allowedTools.filter((t) => t === 'Read');
    expect(reads).toHaveLength(1);
    expect(policy.allowedTools).toContain('Bash');
  });

  it('partitions every side-effect tool into exactly one of allow/deny', () => {
    // For any agent, a side-effect tool is either opted-in (allowed) or
    // denied, never both and never missing. This is the invariant that keeps
    // the disallowedTools floor honest as the lists evolve.
    for (const agent of ['main', 'ops', 'comms', 'content', 'research', 'ghost']) {
      const policy = warRoomToolPolicy(agent);
      for (const tool of SIDE_EFFECT) {
        const inAllow = policy.allowedTools.includes(tool);
        const inDeny = policy.disallowedTools.includes(tool);
        expect(inAllow).not.toBe(inDeny);
      }
    }
  });

  it('always keeps allowedTools non-empty so the SDK never default-allows everything', () => {
    // A non-empty allowedTools is what restricts the SDK to the named set; an
    // empty list would let the model reach for anything.
    expect(warRoomToolPolicy('main').allowedTools.length).toBeGreaterThan(0);
    expect(warRoomToolPolicy('unknown').allowedTools.length).toBeGreaterThan(0);
  });

  describe('MCP exposure', () => {
    it('exposes no MCP servers for any default agent', () => {
      for (const agent of ['main', 'ops', 'comms', 'content', 'research', 'nobody']) {
        expect(warRoomToolPolicy(agent).allowedMcpServers).toEqual([]);
      }
    });

    it('opts an MCP server in only via an explicit mcp: override', () => {
      const policy = warRoomToolPolicy('ops', ['Bash', 'mcp:gmail']);
      expect(policy.allowedMcpServers).toEqual(['gmail']);
    });

    it('supports multiple mcp: entries', () => {
      const policy = warRoomToolPolicy('comms', ['mcp:gmail', 'mcp:slack']);
      expect(policy.allowedMcpServers.sort()).toEqual(['gmail', 'slack'].sort());
    });

    it('ignores mcp: entries that live only in a per-agent default', () => {
      // Defaults are scanned for tool names but NOT for mcp: exposure, so an
      // operator must opt MCPs in per meeting — they can't be baked into a
      // default and silently exposed.
      expect(warRoomToolPolicy('ops').allowedMcpServers).toEqual([]);
    });
  });
});

describe('filterMcpServers', () => {
  const servers = {
    gmail: { command: 'gmail-mcp' },
    slack: { command: 'slack-mcp' },
    chrome: { command: 'chrome-mcp' },
  };

  it('drops every server when the policy allows none', () => {
    const policy = warRoomToolPolicy('main'); // allowedMcpServers: []
    expect(filterMcpServers(servers, policy)).toEqual({});
  });

  it('keeps only the servers the policy names', () => {
    const policy = warRoomToolPolicy('ops', ['mcp:gmail']);
    expect(filterMcpServers(servers, policy)).toEqual({ gmail: { command: 'gmail-mcp' } });
  });

  it('preserves the config object for an allowed server', () => {
    const policy = warRoomToolPolicy('ops', ['mcp:slack']);
    const out = filterMcpServers(servers, policy);
    expect(out.slack).toBe(servers.slack);
  });

  it('drops a named server that is not actually installed', () => {
    const policy = warRoomToolPolicy('ops', ['mcp:gmail', 'mcp:notinstalled']);
    expect(Object.keys(filterMcpServers(servers, policy))).toEqual(['gmail']);
  });

  it('returns an empty map when there are no servers to begin with', () => {
    const policy = warRoomToolPolicy('ops', ['mcp:gmail']);
    expect(filterMcpServers({}, policy)).toEqual({});
  });
});
