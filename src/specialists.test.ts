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
  PRIMARY_MODEL: 'claude-opus-4-8',
  PRIMARY_MODEL_DISPLAY: 'Opus 4.8',
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./tool-labels.js', () => ({ toolLabel: vi.fn(() => '') }));
vi.mock('./claw-runner.js', () => ({ runClaw: vi.fn() }));

import {
  delegate,
  resolveSpecialistModel,
  suggestRoute,
  matchedSpecialists,
  intelligentRoute,
  SPECIALISTS,
  ALL_CALLSIGNS,
  NO_TOOLS_FALLBACK_NOTICE,
  UNGROUNDED_NOTICE,
  CLOUD_FALLBACK_NOTICE,
} from './specialists.js';
import { ollamaChat, ollamaListModels } from './ollama.js';
import { runClaw } from './claw-runner.js';
import { getSpecialistTierOverride } from './db.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockRunClaw = vi.mocked(runClaw);
const mockOllamaChat = vi.mocked(ollamaChat);
const mockListModels = vi.mocked(ollamaListModels);
const mockTierOverride = vi.mocked(getSpecialistTierOverride);
const mockQuery = vi.mocked(query);

// Async-iterable whose first `next()` rejects, simulating the cloud SDK
// stream throwing a rate-limit error part-way through delegateCloud's
// `for await`. Hand-rolled (not an async generator) so there is no unused
// `yield` and the rejection surfaces exactly where the real SDK's would.
function rateLimitedStream(message: string) {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(new Error(message)) };
    },
  } as unknown as ReturnType<typeof query>;
}

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
    // The 2026-06-01 cloud rebalance moved sentinel, and the 2026-06-02 hybrid
    // moved scribe, to the cloud tier. These tests exercise the CLAW path +
    // ungrounded labeling, so push BOTH back to claw via a runtime tier
    // override. cloud->claw is a supported transition: applyTierOverride swaps
    // preferredModel to localFallbackModel (sentinel -> qwen3-coder:30b,
    // scribe -> huihui_ai/Qwen3.6-abliterated:27b) and preserves expectsToolUse,
    // recreating the exact claw scenario these assertions were written against.
    mockTierOverride.mockImplementation((cs) =>
      cs === 'sentinel' || cs === 'scribe' ? 'claw' : null,
    );
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

// The 2026-06-01 rebalance moved 7 tool/reasoning specialists to the cloud
// tier, which activated delegateCloud's previously-dormant cloud->local
// quota-degrade path. That local model runs with no tool loop, so (like the
// claw no-tools fallback) its answer must be labeled unverified before it
// reaches the user or Jarvis. These lock that honesty contract.
describe('delegateCloud rate-limit → local fallback honesty labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No tier override: exercise the real cloud tier so a rate-limit error
    // drives the cloud->local fallback rather than the claw path.
    mockTierOverride.mockReturnValue(null);
  });

  it('labels the cloud→local quota fallback output as unverified', async () => {
    mockQuery.mockImplementation(() => rateLimitedStream('429 rate limit exceeded'));
    mockOllamaChat.mockImplementation((async (
      _model: string,
      _msgs: unknown,
      onEvent: (e: { delta?: string }) => void,
    ) => {
      onEvent({ delta: 'Open ports: 22, 3000' });
    }) as unknown as typeof ollamaChat);

    const res = await delegate('sentinel', 'list open ports');
    expect(res.output.startsWith(CLOUD_FALLBACK_NOTICE)).toBe(true);
    expect(res.output).toContain('Open ports: 22, 3000');
    expect(res.modelUsed).toBe('qwen3-coder:30b');
    expect(res.fellBackFrom).toBe('claude-sonnet-4-6');
  });

  it('does NOT prepend the notice when the local fallback yields no output', async () => {
    mockQuery.mockImplementation(() => rateLimitedStream('429 rate limit exceeded'));
    mockOllamaChat.mockImplementation((async (
      _model: string,
      _msgs: unknown,
      onEvent: (e: { delta?: string }) => void,
    ) => {
      onEvent({ delta: '' });
    }) as unknown as typeof ollamaChat);

    const res = await delegate('sentinel', 'list open ports');
    expect(res.output).toBe('[local fallback produced no output]');
    expect(res.output).not.toContain('unverified');
  });
});

// The orchestration upgrade makes Jarvis a planner, not a switchboard: a task
// that spans 2+ specialist domains is handed to 'self' so the main agent can
// decompose it and fan the parts out (team.delegate_parallel) instead of
// shipping the whole thing to whichever specialist matched first. These lock
// the multi-domain detection + escalation while preserving the single-domain
// fast path that existing routing relied on.
describe('routing: multi-domain detection + escalation to Jarvis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTierOverride.mockReturnValue(null);
  });

  it('matchedSpecialists returns one domain for a single-specialty task', () => {
    expect(matchedSpecialists('refactor this function')).toEqual(['coder']);
  });

  it('matchedSpecialists dedupes several keywords from the same specialist', () => {
    // refactor + function + bug all map to coder; still one distinct domain.
    expect(matchedSpecialists('refactor the function to fix the bug')).toEqual(['coder']);
  });

  it('matchedSpecialists returns distinct domains in rule order', () => {
    // research -> sleuth, summarize -> scribe; sleuth precedes scribe in the table.
    expect(matchedSpecialists('research the latest framework and summarize it')).toEqual(['sleuth', 'scribe']);
  });

  it('matchedSpecialists returns empty when no keyword matches', () => {
    expect(matchedSpecialists('hello there how are you today')).toEqual([]);
  });

  it('intelligentRoute escalates a multi-domain task to self without an Opus call', async () => {
    const r = await intelligentRoute('refactor this function and research the latest framework');
    expect(r.callsign).toBe('self');
    expect(r.source).toBe('keyword');
    expect(r.reason).toContain('multi-domain');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('intelligentRoute keeps the single-domain keyword fast path (no Opus call)', async () => {
    const r = await intelligentRoute('refactor this function');
    expect(r.callsign).toBe('coder');
    expect(r.source).toBe('keyword');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('suggestRoute still returns the first single match (dashboard suggestion contract)', () => {
    expect(suggestRoute('refactor this function')).toBe('coder');
  });
});

// The 2026-06-02 research team: a regular analyst (prism) plus an abliterated
// cross-check pair (oracle researches uncensored, heretic diffs regular vs
// uncensored for bias / censorship / false info). These lock the roster wiring
// (tier + model per the 16GB-VRAM-aware plan) and that each role is reachable
// by its own keywords without disturbing the existing single-domain routes.
describe('research team: prism / oracle / heretic specialists', () => {
  it('registers prism as a cloud analyst on Opus 4.8 (Fable 5 temp-unavailable 2026-06-13)', () => {
    expect(SPECIALISTS.prism.tier).toBe('cloud');
    expect(SPECIALISTS.prism.preferredModel).toBe('claude-opus-4-8');
    expect(SPECIALISTS.prism.capabilities).toContain('verification');
  });

  it('registers oracle as a local / abliterated researcher on gemma-4-abliterated', () => {
    // Local tier (not claw): reasons over injected Brave results in one bounded
    // inference, so it is fast and cannot spin the claw tool loop past the
    // research timeout. Same tier as heretic.
    expect(SPECIALISTS.oracle.tier).toBe('local');
    expect(SPECIALISTS.oracle.preferredModel).toBe('huihui_ai/gemma-4-abliterated:latest');
    expect(SPECIALISTS.oracle.capabilities).toContain('uncensored');
  });

  it('registers heretic as a local / abliterated auditor on neuraldaredevil-8b', () => {
    expect(SPECIALISTS.heretic.tier).toBe('local');
    expect(SPECIALISTS.heretic.preferredModel).toBe('closex/neuraldaredevil-8b-abliterated:latest');
    expect(SPECIALISTS.heretic.capabilities).toContain('bias-audit');
  });

  it('keeps the abliterated models within the 16GB GPU budget (small enough to fit)', () => {
    // oracle (~10GB) and heretic (~6GB) are deliberately small so they fit the
    // RTX 5080's 16GB; the 35b deep-dive (reaper, 22) is the escalation target.
    expect(SPECIALISTS.oracle.vramHintGB).toBeLessThanOrEqual(14);
    expect(SPECIALISTS.heretic.vramHintGB).toBeLessThanOrEqual(8);
  });

  it('exposes all three in the auto-derived ALL_CALLSIGNS roster', () => {
    expect(ALL_CALLSIGNS).toEqual(expect.arrayContaining(['prism', 'oracle', 'heretic']));
  });

  it('routes each new role by its own keywords', () => {
    expect(matchedSpecialists('do a research analysis of these sources')).toContain('prism');
    expect(matchedSpecialists('give me an uncensored research take on this')).toContain('oracle');
    expect(matchedSpecialists('run a bias check on the findings')).toContain('heretic');
  });

  it('does not disturb the existing single-domain routes', () => {
    // Plain "research" still belongs to sleuth, not prism/oracle.
    expect(matchedSpecialists('research the latest framework and summarize it')).toEqual(['sleuth', 'scribe']);
    expect(matchedSpecialists('refactor this function')).toEqual(['coder']);
  });
});
