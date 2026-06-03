import { describe, it, expect, vi, beforeEach } from 'vitest';

// team-tools builds an in-process MCP server whose tool handlers route through
// specialists.delegate(). We unit-test the handler LOGIC (formatting, context
// prepend, output clipping, parallel error isolation + ordering, roster
// rendering) by mocking only the boundaries:
//   - the SDK's tool()/createSdkMcpServer() so we can capture each tool's
//     handler and invoke it directly without standing up MCP transport,
//   - specialists.js so delegate() is a stub and SPECIALISTS/ALL_CALLSIGNS are
//     a small stable roster (keeps the heavy specialists import tree out),
//   - db.logToHiveMind (best-effort logging) and the logger.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  }),
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => ({
    type: 'sdk',
    name: opts.name,
    version: opts.version,
    instance: {},
    tools: opts.tools,
  }),
}));

vi.mock('./specialists.js', () => {
  const ALL_CALLSIGNS = [
    'scribe', 'coder', 'eye', 'sleuth', 'reaper',
    'archivist', 'sentinel', 'cipher', 'atlas', 'mercury',
  ];
  const SPECIALISTS = Object.fromEntries(
    ALL_CALLSIGNS.map((cs) => [cs, {
      callsign: cs,
      tier: 'cloud',
      preferredModel: `model-${cs}`,
      role: `${cs} handles ${cs} work`,
      capabilities: [`${cs}-a`, `${cs}-b`],
    }]),
  );
  return { delegate: vi.fn(), SPECIALISTS, ALL_CALLSIGNS };
});

vi.mock('./db.js', () => ({ logToHiveMind: vi.fn() }));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createTeamMcpServer } from './team-tools.js';
import { delegate } from './specialists.js';
import { logToHiveMind } from './db.js';
import type { DelegateResult } from './specialists.js';

const mockDelegate = vi.mocked(delegate);
const mockHive = vi.mocked(logToHiveMind);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Build the server for a fixed chatId and pull one tool's handler out. */
function getTool(name: string): ToolHandler {
  const server = createTeamMcpServer('chat-xyz') as unknown as {
    tools: Array<{ name: string; handler: ToolHandler }>;
  };
  const found = server.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found.handler;
}

function mkResult(over: Partial<DelegateResult> = {}): DelegateResult {
  return {
    callsign: 'coder',
    modelUsed: 'claude-sonnet-4-6',
    output: 'done',
    durationMs: 1500,
    tokenEstimate: 0,
    ...over,
  } as DelegateResult;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('team: delegate (single sub-task)', () => {
  it('routes through delegate() and formats the labeled result block', async () => {
    mockDelegate.mockResolvedValue(
      mkResult({ callsign: 'coder', output: 'refactored ok', modelUsed: 'claude-sonnet-4-6', durationMs: 2000 }),
    );
    const handler = getTool('delegate');
    const res = await handler({ callsign: 'coder', task: 'refactor the parser' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('=== @coder');
    expect(res.content[0].text).toContain('claude-sonnet-4-6');
    expect(res.content[0].text).toContain('refactored ok');
    // chatId from the closure + shareMemory are threaded through.
    expect(mockDelegate).toHaveBeenCalledTimes(1);
    expect(mockDelegate).toHaveBeenCalledWith('coder', 'refactor the parser', {
      chatId: 'chat-xyz',
      shareMemory: true,
    });
    // Best-effort hive_mind orchestrate log fired once.
    expect(mockHive).toHaveBeenCalledTimes(1);
  });

  it('prepends optional context as a labeled block', async () => {
    mockDelegate.mockResolvedValue(mkResult());
    const handler = getTool('delegate');
    await handler({ callsign: 'coder', task: 'do the thing', context: 'repo is TypeScript' });

    const taskArg = mockDelegate.mock.calls[0][1] as string;
    expect(taskArg).toContain('[Context from Jarvis]');
    expect(taskArg).toContain('repo is TypeScript');
    expect(taskArg).toContain('do the thing');
  });

  it('clips very long specialist output and notes the truncation', async () => {
    mockDelegate.mockResolvedValue(mkResult({ output: 'x'.repeat(13_000) }));
    const handler = getTool('delegate');
    const res = await handler({ callsign: 'scribe', task: 'write a long thing' });
    expect(res.content[0].text).toContain('output truncated at 12000 chars');
  });

  it('returns an error result (not a throw) when the specialist fails', async () => {
    mockDelegate.mockRejectedValue(new Error('model unreachable'));
    const handler = getTool('delegate');
    const res = await handler({ callsign: 'coder', task: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('could not complete');
    expect(res.content[0].text).toContain('model unreachable');
  });
});

describe('team: delegate_parallel (concurrent fan-out)', () => {
  it('preserves listed order and isolates a single failure', async () => {
    mockDelegate.mockImplementation((async (cs: string) => {
      if (cs === 'sleuth') throw new Error('sleuth timed out');
      return mkResult({ callsign: cs as DelegateResult['callsign'], output: `${cs} output`, modelUsed: `model-${cs}` });
    }) as unknown as typeof delegate);

    const handler = getTool('delegate_parallel');
    const res = await handler({
      tasks: [
        { callsign: 'coder', task: 'a' },
        { callsign: 'sleuth', task: 'b' },
        { callsign: 'scribe', task: 'c' },
      ],
    });

    const text = res.content[0].text;
    expect(text).toContain('3 sub-task(s) in parallel: 2 succeeded, 1 failed');
    // Blocks appear in the order the caller listed them.
    const iCoder = text.indexOf('@coder');
    const iSleuth = text.indexOf('@sleuth (FAILED)');
    const iScribe = text.indexOf('@scribe');
    expect(iCoder).toBeGreaterThanOrEqual(0);
    expect(iSleuth).toBeGreaterThan(iCoder);
    expect(iScribe).toBeGreaterThan(iSleuth);
    expect(text).toContain('sleuth timed out');
    // All three were dispatched even though one rejected.
    expect(mockDelegate).toHaveBeenCalledTimes(3);
  });

  it('logs one hive_mind orchestrate entry for the whole batch', async () => {
    mockDelegate.mockResolvedValue(mkResult());
    const handler = getTool('delegate_parallel');
    await handler({ tasks: [{ callsign: 'coder', task: 'a' }, { callsign: 'scribe', task: 'b' }] });
    expect(mockHive).toHaveBeenCalledTimes(1);
  });
});

describe('team: team_roster', () => {
  it('lists every callsign with its tier, model, and role', async () => {
    const handler = getTool('team_roster');
    const res = await handler({});
    const text = res.content[0].text;
    for (const cs of ['scribe', 'coder', 'eye', 'sleuth', 'reaper', 'archivist', 'sentinel', 'cipher', 'atlas', 'mercury']) {
      expect(text).toContain(`@${cs}`);
    }
    expect(text).toContain('model-atlas');
    expect(text).toContain('cloud');
  });
});
