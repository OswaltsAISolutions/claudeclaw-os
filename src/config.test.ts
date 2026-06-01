import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import * as config from './config.js';

const { expandHome } = config;

// expandHome resolves the leading ~ used by CLAUDECLAW_CONFIG and
// CLAUDECLAW_STORE_DIR. A bug here would relocate the entire store / config
// dir (SQLite DB, PID files, agent configs), so the expansion rules matter.
describe('expandHome', () => {
  const home = os.homedir();

  it('expands ~/sub to an absolute path under the home dir', () => {
    expect(expandHome('~/foo')).toBe(path.join(home, 'foo'));
    expect(expandHome('~/foo/bar')).toBe(path.join(home, 'foo', 'bar'));
  });

  it('expands a bare ~ to the home dir', () => {
    expect(expandHome('~')).toBe(home);
  });

  it('expands a trailing ~/ to the home dir, keeping the trailing slash', () => {
    // p.slice(1) is "/", and path.join(home, "/") retains the slash.
    expect(expandHome('~/')).toBe(path.join(home, '/'));
  });

  it('leaves absolute and relative paths untouched', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('relative/path')).toBe('relative/path');
    expect(expandHome('./rel')).toBe('./rel');
  });

  it('does not expand a tilde that is not a home prefix', () => {
    // Only "~" or "~/..." expand; "~foo" is left as-is.
    expect(expandHome('~foo')).toBe('~foo');
    expect(expandHome('')).toBe('');
  });
});

// setAgentOverrides feeds the --agent boot path: index.ts loads an agent's
// config then pushes it into these live module bindings so the rest of the
// process sees the right token / cwd / prompt. These tests mutate shared
// module state, but the file is isolated from the rest of the suite.
describe('setAgentOverrides / updateAgentSystemPrompt', () => {
  it('pushes every override into the exported live bindings', () => {
    config.setAgentOverrides({
      agentId: 'ops',
      botToken: 'tok-123',
      cwd: '/tmp/ops',
      model: 'claude-sonnet-4-6',
      obsidian: { vault: '/v', folders: ['a'], readOnly: ['b'] },
      systemPrompt: 'be helpful',
      mcpServers: ['gmail'],
    });

    expect(config.AGENT_ID).toBe('ops');
    expect(config.activeBotToken).toBe('tok-123');
    expect(config.agentCwd).toBe('/tmp/ops');
    expect(config.agentDefaultModel).toBe('claude-sonnet-4-6');
    expect(config.agentObsidianConfig).toEqual({ vault: '/v', folders: ['a'], readOnly: ['b'] });
    expect(config.agentSystemPrompt).toBe('be helpful');
    expect(config.agentMcpAllowlist).toEqual(['gmail']);
  });

  it('updateAgentSystemPrompt swaps only the system prompt', () => {
    config.updateAgentSystemPrompt('new prompt');
    expect(config.agentSystemPrompt).toBe('new prompt');
    // The other overrides set above are untouched.
    expect(config.AGENT_ID).toBe('ops');

    config.updateAgentSystemPrompt(undefined);
    expect(config.agentSystemPrompt).toBeUndefined();
  });
});
