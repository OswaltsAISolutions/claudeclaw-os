import { describe, it, expect, vi, beforeEach } from 'vitest';

// We exercise the public dispatch entry (`delegate`) end-to-end for the claw
// tier, mocking only the process boundary (runClaw), the Ollama client, and
// the persistence layer. The goal is to lock down the 2026-05-31 honesty
// labeling: unverified no-tools fallbacks (#6) and ungrounded zero-tool-call
// answers from tool-required specialists (#7).
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('./ollama.js', () => ({
  ollamaChat: vi.fn(),
  ollamaListModels: vi.fn(async () => []),
}));
vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(async () => ({
    contextText: '',
    surfacedMemoryIds: [],
    surfacedMemorySummaries: new Map(),
  })),
}));
vi.mock('./db.js', () => ({
  getSpecialistTierOverride: vi.fn(() => null),
  logConversationTurn: vi.fn(),
  logToHiveMind: vi.fn(),
}));
vi.mock('./config.js', () => ({
  ALLOWED_CHAT_ID: 'chat-test',
  DASHBOARD_TOKEN: 'test-token',
  PROJECT_ROOT: '/tmp/project',
  AGENT_MAX_TURNS: 24,
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./tool-labels.js', () => ({ toolLabel: vi.fn(() => '') }));
vi.mock('./claw-runner.js', () => ({ runClaw: vi.fn() }));

import {
  delegate,
  resolveSpecialistModel,
  NO_TOOLS_FALLBACK_NOTICE,
  UNGROUNDED_NOTICE,
} from './specialists.js';
import { ollamaChat, ollamaListModels } from './ollama.js';
import { runClaw } from './claw-runner.js';
import { getSpecialistTierOverride } from './db.js';

const mockRunClaw = vi.mocked(runClaw);
const mockOllamaChat = vi.mocked(ollamaChat);
const mockListModels = vi.mocked(ollamaListModels);
const mockTierOverride = vi.mocked(getSpecialistTierOverride);

function clawResult(over: Record<string, unknown> = {}) {
  return {
    text: '',
    toolCalls: 0,
    turns: 0,
    durationMs: 100,
    workspace: '/tmp/project',
    ...over,
  } as Awaited<ReturnType<typeof runClaw>>;
}

describe('delegate (claw tier) honesty labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The 2026-06-01 cloud rebalance moved sentinel (and the other
    // tool-required specialists) to the cloud tier. These tests exercise the
    // CLAW path + ungrounded labeling, so put sentinel back on claw via a
    // runtime tier override. cloud->claw is a supported transition:
    // applyTierOverride swaps preferredModel to localFallbackModel
    // (qwen3-coder:30b) and preserves expectsToolUse, recreating the exact
    // claw scenario these assertions were written against. scribe stays claw
    // statically, so its override is a no-op.
    mockTierOverride.mockImplementation((cs) => (cs === 'sentinel' ? 'claw' : null));
    mockListModels.mockResolvedValue([
      { name: 'qwen3-coder:30b' },
      { name: 'mistral-small:24b' },
      { name: 'huihui_ai/Qwen3.6-abliterated:27b' },
    ] as Awaited<ReturnType<typeof ollamaListModels>>);
  });

  it('labels a tool-required specialist (sentinel) as ungrounded when it returns zero tool calls', async () => {
    mockRunClaw.mockResolvedValue(clawResult({
      text: 'Open ports: 22, 3000, 5432',
      toolCalls: 0,
      turns: 1,
      stopReason: 'end_turn',
    }));
    const res = await delegate('sentinel', 'list open ports');
    expect(res.output.startsWith(UNGROUNDED_NOTICE)).toBe(true);
    expect(res.output).toContain('Open ports: 22, 3000, 5432');
  });

  it('does NOT label a tool-required specialist when it actually used tools', async () => {
    mockRunClaw.mockResolvedValue(clawResult({
      text: 'Open ports: 11435, 3141',
      toolCalls: 3,
      turns: 2,
      stopReason: 'end_turn',
    }));
    const res = await delegate('sentinel', 'list open ports');
    expect(res.output).toBe('Open ports: 11435, 3141');
    expect(res.output).not.toContain('unverified');
  });

  it('does NOT label a prose specialist (scribe) for a legitimately tool-less answer', async () => {
    mockRunClaw.mockResolvedValue(clawResult({
      text: 'A polished paragraph.',
      toolCalls: 0,
      turns: 1,
      stopReason: 'end_turn',
    }));
    const res = await delegate('scribe', 'write a paragraph');
    expect(res.output).toBe('A polished paragraph.');
    expect(res.output).not.toContain('unverified');
  });

  it('labels the no-tools fallback output when claw errors and a fallback model answers', async () => {
    mockRunClaw.mockResolvedValue(clawResult({ error: 'claw subprocess died' }));
    mockOllamaChat.mockImplementation((async (
      _model: string,
      _msgs: unknown,
      onEvent: (e: { delta?: string }) => void,
    ) => {
      onEvent({ delta: 'best-effort fallback answer' });
    }) as unknown as typeof ollamaChat);

    const res = await delegate('sentinel', 'list open ports');
    expect(res.output.startsWith(NO_TOOLS_FALLBACK_NOTICE)).toBe(true);
    expect(res.output).toContain('best-effort fallback answer');
    expect(res.fellBackFrom).toBe('qwen3-coder:30b');
    expect(mockOllamaChat).toHaveBeenCalledTimes(1);
  });

  it('surfaces a bare [claw error] when claw fails and there is no usable fallback', async () => {
    mockRunClaw.mockResolvedValue(clawResult({ error: 'claw subprocess died' }));
    // Fallback model not installed, so the direct-ollama path is skipped.
    mockOllamaChat.mockImplementation((async (
      _model: string,
      _msgs: unknown,
      onEvent: (e: { delta?: string }) => void,
    ) => {
      onEvent({ delta: '' });
    }) as unknown as typeof ollamaChat);

    const res = await delegate('sentinel', 'list open ports');
    expect(res.output).toContain('[claw error]');
    expect(res.output).toContain('claw subprocess died');
  });
});

describe('resolveSpecialistModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTierOverride.mockReturnValue(null);
  });

  // resolveSpecialistModel only walks the Ollama tag chain for local/claw
  // specialists (cloud tiers short-circuit to preferredModel). After the
  // 2026-06-01 rebalance, reaper is the canonical statically-claw specialist,
  // so it exercises the installed-tag resolution + fallback logic.
  it('returns the preferred tag when it is installed', async () => {
    mockListModels.mockResolvedValue([{ name: 'huihui_ai/Qwen3.6-abliterated:35b' }] as Awaited<ReturnType<typeof ollamaListModels>>);
    const r = await resolveSpecialistModel('reaper');
    expect(r).toEqual({ model: 'huihui_ai/Qwen3.6-abliterated:35b' });
  });

  it('falls back to the next installed tag when the preferred one is missing', async () => {
    mockListModels.mockResolvedValue([{ name: 'huihui_ai/Qwen3.6-abliterated:27b' }] as Awaited<ReturnType<typeof ollamaListModels>>);
    const r = await resolveSpecialistModel('reaper');
    expect(r?.model).toBe('huihui_ai/Qwen3.6-abliterated:27b');
    expect(r?.fellBackFrom).toBe('huihui_ai/Qwen3.6-abliterated:35b');
  });

  it('returns null when nothing in the chain is installed', async () => {
    mockListModels.mockResolvedValue([{ name: 'some-unrelated-model:1b' }] as Awaited<ReturnType<typeof ollamaListModels>>);
    const r = await resolveSpecialistModel('reaper');
    expect(r).toBeNull();
  });
});
