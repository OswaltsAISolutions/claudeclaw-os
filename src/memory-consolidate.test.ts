import { describe, it, expect, vi, beforeEach } from 'vitest';

// Consolidation generates JSON via the Anthropic SDK `query` (Haiku),
// then parses it with parseJsonResponse. We mock the SDK boundary so the
// test never spawns a real subprocess, and drive the parsed result through
// the parseJsonResponse mock.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('./gemini.js', () => ({
  parseJsonResponse: vi.fn(),
}));

vi.mock('./kill-switches.js', () => ({
  requireEnabled: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getUnconsolidatedMemories: vi.fn(),
  saveConsolidationAtomic: vi.fn(() => 1),
  saveConsolidationEmbedding: vi.fn(),
}));

vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { runConsolidation } from './memory-consolidate.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseJsonResponse } from './gemini.js';
import {
  getUnconsolidatedMemories,
  saveConsolidationAtomic,
} from './db.js';

const mockGetUnconsolidated = vi.mocked(getUnconsolidatedMemories);
const mockQuery = vi.mocked(query);
const mockParseJson = vi.mocked(parseJsonResponse);
const mockSaveAtomic = vi.mocked(saveConsolidationAtomic);

/** Async-iterable stand-in for the SDK: yields one assistant text event. */
function queryYielding(text: string) {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  })();
}

function makeMemory(id: number, summary: string) {
  return {
    id,
    chat_id: 'chat1',
    source: 'conversation',
    agent_id: 'main',
    raw_text: 'raw',
    summary,
    entities: '[]',
    topics: '[]',
    connections: '[]',
    importance: 0.6,
    salience: 1.0,
    consolidated: 0,
    pinned: 0,
    embedding: null,
    created_at: Math.floor(Date.now() / 1000) - 3600,
    accessed_at: Math.floor(Date.now() / 1000) - 3600,
  };
}

describe('runConsolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the SDK yields a JSON blob. parseJsonResponse (mocked per
    // test) decides what that blob deserializes to.
    mockQuery.mockImplementation(() => queryYielding('{}') as never);
  });

  // ── Skip conditions ───────────────────────────────────────────────

  it('skips when fewer than 2 unconsolidated memories', async () => {
    mockGetUnconsolidated.mockReturnValue([makeMemory(1, 'only one')]);
    await runConsolidation('chat1');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveAtomic).not.toHaveBeenCalled();
  });

  it('skips when zero unconsolidated memories', async () => {
    mockGetUnconsolidated.mockReturnValue([]);
    await runConsolidation('chat1');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── Successful consolidation ──────────────────────────────────────

  it('consolidates 2+ memories and saves the result atomically', async () => {
    const memories = [
      makeMemory(10, 'User prefers morning email triage'),
      makeMemory(20, 'User checks Slack after email'),
      makeMemory(30, 'User blocks 9-10am for admin tasks'),
    ];
    mockGetUnconsolidated.mockReturnValue(memories);

    const consolidationResult = {
      summary: 'User has a structured morning routine.',
      insight: 'User organizes mornings around a clear priority order.',
      connections: [
        { from_id: 10, to_id: 20, relationship: 'sequential workflow' },
        { from_id: 20, to_id: 30, relationship: 'part of morning routine' },
      ],
    };
    mockParseJson.mockReturnValue(consolidationResult);

    await runConsolidation('chat1');

    // Should call atomic save with all data bundled
    expect(mockSaveAtomic).toHaveBeenCalledTimes(1);
    expect(mockSaveAtomic).toHaveBeenCalledWith(
      'chat1',
      [10, 20, 30],
      consolidationResult.summary,
      consolidationResult.insight,
      // Valid connections passed through
      [
        { from_id: 10, to_id: 20, relationship: 'sequential workflow' },
        { from_id: 20, to_id: 30, relationship: 'part of morning routine' },
      ],
      // No contradictions
      [],
    );
  });

  // ── Connection filtering ──────────────────────────────────────────

  it('ignores connections with IDs outside the source set', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);

    const result = {
      summary: 'summary',
      insight: 'insight',
      connections: [
        { from_id: 10, to_id: 999, relationship: 'invalid target' },
        { from_id: 888, to_id: 20, relationship: 'invalid source' },
        { from_id: 10, to_id: 20, relationship: 'valid connection' },
      ],
    };
    mockParseJson.mockReturnValue(result);

    await runConsolidation('chat1');

    // Only the valid connection should be passed to atomic save
    expect(mockSaveAtomic).toHaveBeenCalledWith(
      'chat1',
      [10, 20],
      'summary',
      'insight',
      [{ from_id: 10, to_id: 20, relationship: 'valid connection' }],
      [],
    );
  });

  it('handles empty connections array', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);

    const result = {
      summary: 'These cover different topics',
      insight: 'No clear pattern between these memories',
      connections: [],
    };
    mockParseJson.mockReturnValue(result);

    await runConsolidation('chat1');

    expect(mockSaveAtomic).toHaveBeenCalledWith(
      'chat1',
      [10, 20],
      result.summary,
      result.insight,
      [],
      [],
    );
  });

  // ── Error handling ────────────────────────────────────────────────

  it('handles LLM call failure gracefully', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);
    mockQuery.mockImplementation(() => { throw new Error('API timeout'); });

    await expect(runConsolidation('chat1')).resolves.not.toThrow();
    expect(mockSaveAtomic).not.toHaveBeenCalled();
  });

  it('handles invalid LLM response (null parse)', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);
    mockParseJson.mockReturnValue(null);

    await runConsolidation('chat1');
    expect(mockSaveAtomic).not.toHaveBeenCalled();
  });

  it('handles missing summary in response', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);

    const result = { summary: '', insight: 'insight', connections: [] };
    mockParseJson.mockReturnValue(result);

    await runConsolidation('chat1');
    expect(mockSaveAtomic).not.toHaveBeenCalled();
  });

  it('handles missing insight in response', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);

    const result = { summary: 'summary', insight: '', connections: [] };
    mockParseJson.mockReturnValue(result);

    await runConsolidation('chat1');
    expect(mockSaveAtomic).not.toHaveBeenCalled();
  });

  // ── Overlap guard ─────────────────────────────────────────────────

  it('does not run concurrently (overlap guard)', async () => {
    const memories = [makeMemory(10, 'mem1'), makeMemory(20, 'mem2')];
    mockGetUnconsolidated.mockReturnValue(memories);

    // Hold the first SDK call open so the second runConsolidation overlaps
    // it. The second call must be rejected by the per-chat guard, so the
    // SDK is invoked exactly once.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mockQuery.mockImplementationOnce(() => (async function* () {
      await gate;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '{}' }] } };
    })() as never);

    const result = {
      summary: 'summary',
      insight: 'insight',
      connections: [],
    };
    mockParseJson.mockReturnValue(result);

    const run1 = runConsolidation('chat1');
    const run2 = runConsolidation('chat1');

    releaseFirst();

    await run1;
    await run2;

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
