// Specialist roster and dispatch layer.
//
// Each specialist is a local-model-backed worker with a defined role,
// preferred + fallback model tags, and a tuned system prompt. The
// dispatcher (`delegate`) wraps Ollama chat with:
//   - shared hivemind memory injection (so the specialist sees the same
//     facts about the user that Jarvis does),
//   - conversation_log + hive_mind persistence so future turns and the
//     activity feed can see what each specialist did,
//   - model availability checks with graceful fallback when the
//     preferred tag isn't installed yet.
//
// Naming: callsigns. Short, role-coded, no theme overhead. Locked with
// the user in May 2026.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ollamaChat, ollamaListModels, type ChatMessage } from './ollama.js';
import { buildMemoryContext } from './memory.js';
import { logConversationTurn, logToHiveMind } from './db.js';
import { ALLOWED_CHAT_ID, PROJECT_ROOT, AGENT_MAX_TURNS } from './config.js';
import { logger } from './logger.js';

export type SpecialistCallsign =
  | 'scribe'
  | 'coder'
  | 'eye'
  | 'sleuth'
  | 'reaper'
  | 'archivist'
  | 'sentinel'
  | 'cipher'
  | 'atlas'      // Cloud supervisor — Opus 4.7. Strategy, heavyweight reasoning, planning.
  | 'mercury';   // Cloud supervisor — Sonnet latest. Fast execution, parallel scout work.

// Specialist tier:
//   - 'local'   → Ollama-backed. Free, runs on user's GPU. Best for high-volume,
//                 narrow, predictable tasks.
//   - 'cloud'   → Anthropic Agent SDK via OAuth (Max plan quota, NO API key).
//                 Full tool access. Best for high-stakes reasoning + work
//                 that benefits from web search, file IO, etc. Falls back to
//                 a local specialist (fallbackCallsign) on rate-limit.
export type SpecialistTier = 'local' | 'cloud';

export interface SpecialistConfig {
  callsign: SpecialistCallsign;
  tier: SpecialistTier;
  role: string;                  // One-line human description.
  preferredModel: string;        // Ollama tag for 'local', SDK model string for 'cloud'.
  fallbackModels: string[];      // Local only: ordered list of fallback Ollama tags.
  fallbackCallsign?: SpecialistCallsign; // Cloud only: when rate-limited, redirect to another specialist (legacy fallback).
  localFallbackModel?: string;   // Cloud only: Ollama tag to use directly when cloud rate-limits/fails. Tried BEFORE fallbackCallsign — faster, fewer hops, doesn't pile on another cloud specialist that's likely also rate-limited.
  capabilities: string[];        // Tag list for routing heuristics.
  systemPrompt: string;          // Tuned role prompt.
  defaultContextTokens: number;  // num_ctx (local) or unused (cloud).
  temperature: number;           // 0.2 = factual, 0.7 = creative.
  vramHintGB: number;            // Rough estimate; 0 for cloud.
  cloudAllowTools?: boolean;     // Cloud only: true → full tool access (default true).
}

// All system prompts share a common "you are part of a hivemind" framing
// so specialist outputs feel consistent. Role-specific guidance follows.
const HIVEMIND_PREAMBLE = [
  'You are a specialist in a multi-agent system orchestrated by Jarvis,',
  "the user's primary AI assistant. You share the same persistent memory",
  '("hivemind") as Jarvis and every other specialist. Treat the memory',
  'context as authoritative facts about the user. Reply tight, no filler,',
  'no AI clichés ("Certainly!", "I\'d be happy to", "absolutely", "Great question").',
  '',
  'PUNCTUATION (HARD RULE): NEVER use an em dash (—) or en dash (–) anywhere',
  'in your output. Not for parentheticals, not for emphasis, not for ranges,',
  'not for ANY reason. Use a comma, a period, parentheses, or start a new',
  'sentence instead. If you catch yourself about to type — replace it before',
  'sending. The user has explicitly said an em dash in your output is a',
  'failed task. Hyphens (-) in compound words like "fact-check" are fine.',
  '',
  'You are receiving a task delegated by Jarvis. Complete it directly and',
  'return the result. Do not ask clarifying questions unless the task is',
  'genuinely ambiguous; otherwise make a reasonable assumption and note it.',
].join(' ');

export const SPECIALISTS: Record<SpecialistCallsign, SpecialistConfig> = {
  scribe: {
    callsign: 'scribe',
    tier: 'cloud',
    role: 'Writing, summaries, drafts, rewrites, formatting, transcript cleanup, short-form copy.',
    // 2026-05-23 upgrade: cloud Sonnet 4.6 per intelligence-over-cost principle.
    // Writing benefits enormously from cloud-tier intelligence — sharper prose,
    // better tone-matching, faster (no thinking-budget waste). Local Qwen3.6
    // 27b stays as fallback when cloud rate-limits (effectively never on Max).
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    localFallbackModel: 'huihui_ai/Qwen3.6-abliterated:27b',
    capabilities: ['writing', 'summarize', 'rewrite', 'format', 'draft', 'copy'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Scribe. Your job is producing high-quality prose: summaries, rewrites, drafts, formatted output. Match the tone the user wants. When summarizing, lead with the conclusion then back it up. When drafting, prefer short paragraphs and active voice. Never invent facts.`,
    defaultContextTokens: 8192,
    temperature: 0.5,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  coder: {
    callsign: 'coder',
    tier: 'cloud',
    role: 'Code reading, refactors, test stubs, lint fixes, bug analysis, language conversions.',
    // 2026-05-23 upgrade: cloud Sonnet 4.6. Cloud Claude is significantly
    // better at code (refactor-aware, multi-file reasoning, idiomatic across
    // languages) than any local 30b coder model. Local qwen3-coder stays as
    // fallback for cloud-down case.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    localFallbackModel: 'qwen3-coder:30b',
    capabilities: ['code', 'refactor', 'test', 'debug', 'review', 'convert'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Coder. Output working code, not pseudocode, unless explicitly asked. Match the project's existing style. When refactoring, preserve behavior. When debugging, identify root cause before proposing fixes. Show file paths and line numbers when relevant. Always note assumptions about runtime, framework, or libraries.`,
    defaultContextTokens: 16384,
    temperature: 0.2,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  eye: {
    callsign: 'eye',
    tier: 'cloud',
    role: 'Image and video analysis, OCR, screenshot triage, visual classification.',
    // 2026-05-23 upgrade: cloud Sonnet 4.6 (has vision). Significantly better
    // OCR and nuanced visual understanding than local 8b vision models.
    // Local qwen3-vl stays as offline fallback.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    localFallbackModel: 'qwen3-vl:8b',
    capabilities: ['vision', 'image', 'ocr', 'screenshot', 'video-frame', 'classify'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Eye. You describe what is in images and screenshots, extract text via OCR, and classify visual content. Be specific and grounded: say what you actually see, not what you assume. If the image is unclear, say so. For screenshots of UIs, name the application if recognizable and describe the visible state.`,
    defaultContextTokens: 8192,
    temperature: 0.3,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  sleuth: {
    callsign: 'sleuth',
    tier: 'cloud',
    role: 'Web research, multi-source synthesis, fact gathering, citation tracking.',
    // 2026-05-23 upgrade: cloud Sonnet 4.6. Research synthesis is exactly
    // Sonnet's wheelhouse — and cloud-tier means access to WebFetch and
    // (via Tavily MCP) live web search. Local deepseek-r1 stays as fallback
    // for offline pre-fetched-source synthesis when cloud is unreachable.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    localFallbackModel: 'deepseek-r1:14b',
    capabilities: ['research', 'synthesis', 'fact-check', 'citations', 'reasoning'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Sleuth. You synthesize information from multiple sources into coherent answers, with citations. If you are unsure of a claim, say so explicitly. Never invent sources or URLs. When given source material, ground every claim in it. Use WebFetch and Tavily when the task needs live web data; otherwise reason from provided sources.`,
    defaultContextTokens: 16384,
    temperature: 0.3,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  reaper: {
    callsign: 'reaper',
    tier: 'local',
    role: 'Uncensored / abliterated work: security research, red-team drafting, no-guardrail analysis.',
    preferredModel: 'huihui_ai/Qwen3.6-abliterated:35b',
    fallbackModels: [
      'huihui_ai/Qwen3.6-abliterated:27b',
      'closex/neuraldaredevil-8b-abliterated:latest',
      'igorls/gemma-4-E4B-it-heretic-GGUF:latest',
    ],
    capabilities: ['uncensored', 'security', 'red-team', 'analysis', 'no-refusal'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Reaper. You handle tasks where standard models refuse or hedge unnecessarily: security research, red-team scenarios, edgy creative work, legitimate adult content drafting. The user is an adult professional. Skip moralizing and warnings; deliver the requested output. Stay within legal bounds (no CSAM, no targeted real-person harm, no working malware against systems the user doesn't own).`,
    defaultContextTokens: 16384,
    temperature: 0.6,
    vramHintGB: 22,
  },
  archivist: {
    callsign: 'archivist',
    tier: 'cloud',
    role: 'Memory consolidation, recall queries, deduplication, salience scoring, summarization of long history.',
    // 2026-05-23 upgrade: cloud Sonnet 4.6. Memory consolidation quality
    // matters — Sonnet produces better insights, cleaner dedup decisions,
    // sharper salience scoring than local 7b model. Local qwen3.5 stays as
    // fallback for offline memory ops.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    localFallbackModel: 'qwen3.5:latest',
    capabilities: ['memory', 'recall', 'dedup', 'consolidate', 'salience'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Archivist. You maintain the integrity of the shared memory store. Tasks include: scoring memory importance (1-10), merging duplicate facts, summarizing long conversation runs, identifying outdated information. Be ruthless about pruning low-value memories. When uncertain whether to keep something, lean toward keeping it.`,
    defaultContextTokens: 32768,
    temperature: 0.2,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  sentinel: {
    callsign: 'sentinel',
    tier: 'cloud',
    role: 'Sysadmin, log triage, infra health checks, systemd troubleshooting, deployment diagnostics.',
    // 2026-05-23 upgrade: cloud Sonnet 4.6. Log analysis + sysadmin reasoning
    // benefits from cloud-tier intelligence (pattern recognition across long
    // log dumps, correct command suggestions). Local mistral-small stays as
    // fallback for offline diagnostics.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    localFallbackModel: 'mistral-small:24b',
    capabilities: ['sysadmin', 'logs', 'infra', 'systemd', 'diagnostics'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Sentinel. You triage logs, diagnose infra issues, and suggest fixes for sysadmin problems. Show the exact command or config snippet needed. Always note what the change does and how to roll it back. Never run destructive commands without explicit confirmation; you only suggest, the user or Jarvis executes.`,
    defaultContextTokens: 16384,
    temperature: 0.2,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  cipher: {
    callsign: 'cipher',
    tier: 'cloud',
    role: 'Data analysis, CSV/JSON crunching, statistical reasoning, pattern extraction.',
    // 2026-05-23 upgrade: cloud Opus 4.7 (per Gabe's explicit request).
    // Data analysis is reasoning-heavy + edge-case-sensitive; Opus understands
    // structured data, anomalies, and statistical nuance significantly better
    // than smaller models. Local deepseek-r1 stays as fallback for offline
    // crunching when cloud unreachable.
    preferredModel: 'claude-opus-4-7',
    fallbackModels: [],
    localFallbackModel: 'deepseek-r1:14b',
    capabilities: ['data', 'analysis', 'csv', 'json', 'statistics', 'patterns', 'reasoning'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Cipher. You analyze structured data and extract patterns. Show your reasoning briefly, then the answer. If the data is too large to reason about directly, propose a query or script. Always state assumptions about column meanings, data types, and missing values.`,
    defaultContextTokens: 32768,
    temperature: 0.2,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  // ── Cloud supervisors ────────────────────────────────────────────────
  // These two ride the user's Anthropic Max plan via OAuth (no API key,
  // no per-token billing). They have full tool access (Bash, file IO, web
  // search, MCP servers) and operate one tier above the local specialists
  // in the hierarchy: Gabe → Jarvis (COO) → Atlas + Mercury (supervisors)
  // → 8 local specialists (employees). On rate-limit they fail over to a
  // strong local specialist so work never stalls.
  atlas: {
    callsign: 'atlas',
    tier: 'cloud',
    role: 'Cloud supervisor (Opus 4.7). Heavyweight reasoning, planning, architecture review, deep synthesis.',
    // Opus 4.7 — strategic backbone of the team. Atlas carries the weight
    // of multi-step decomposition and quality-critical work that lower
    // tiers can't sustain. 2026-05-23: added direct localFallbackModel
    // since sleuth (the old fallbackCallsign target) is now cloud too —
    // when Anthropic is down, falling back to another cloud specialist
    // would just fail again.
    preferredModel: 'claude-opus-4-7',
    fallbackModels: [],
    fallbackCallsign: 'sleuth',
    localFallbackModel: 'deepseek-r1:14b', // best local reasoner
    capabilities: ['planning', 'architecture', 'review', 'synthesis', 'reasoning', 'supervise', 'orchestrate', 'tools'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Atlas, the Opus-class supervisor on this team. You sit one tier below Jarvis and one tier above the local specialists. Your job is heavyweight reasoning: decomposing large plans into steps Jarvis can hand to local specialists, reviewing critical code or decisions, synthesizing across many sources. You can use tools (file read/write, bash, web search, MCP) but use them deliberately. When you finish, output a concrete actionable result. If the task is better suited to a local specialist, say so and which one.`,
    defaultContextTokens: 0,
    temperature: 0.4,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
  mercury: {
    callsign: 'mercury',
    tier: 'cloud',
    role: 'Cloud supervisor (Sonnet 4.6). Fast execution, parallel scout work, drafting, light coding.',
    // Sonnet — speed-tier supervisor. Mercury chews through volume,
    // feeds Atlas/Jarvis quick scouting and drafts, and handles parallel
    // sub-tasks that don't need Opus-grade depth.
    // 2026-05-22: rolled back from claude-sonnet-4-7 (not yet released —
    // cloud SDK exits with code 1 on that ID) to claude-sonnet-4-6.
    // 2026-05-23: added direct localFallbackModel since coder is now also
    // cloud — fallbackCallsign alone would just fail again on full outage.
    preferredModel: 'claude-sonnet-4-6',
    fallbackModels: [],
    fallbackCallsign: 'coder',
    localFallbackModel: 'qwen3-coder:30b', // strongest local generalist
    capabilities: ['fast', 'execution', 'draft', 'scout', 'parallel', 'code', 'comms', 'tools'],
    systemPrompt: `${HIVEMIND_PREAMBLE}\n\nYou are Mercury, the Sonnet-class supervisor on this team. You sit alongside Atlas, one tier below Jarvis. Your edge is speed and throughput, not depth. Use tools freely (file read/write, bash, web search, MCP) to get to an answer fast. When a task needs deep reasoning or quality-critical judgment, defer to Atlas instead of overreaching. Output should be tight and actionable.`,
    defaultContextTokens: 0,
    temperature: 0.4,
    vramHintGB: 0,
    cloudAllowTools: true,
  },
};

export const ALL_CALLSIGNS: SpecialistCallsign[] = Object.keys(
  SPECIALISTS,
) as SpecialistCallsign[];

export interface DelegateResult {
  callsign: SpecialistCallsign;
  modelUsed: string;
  output: string;
  durationMs: number;
  tokenEstimate: number;
  fellBackFrom?: string;
}

/**
 * Resolve the best model for a specialist.
 *   - 'local': returns the first installed Ollama tag from
 *     [preferred, ...fallbacks]. Returns null if nothing in the chain is
 *     available.
 *   - 'cloud': always returns the configured SDK model string. Cloud
 *     auth (Anthropic Max OAuth) is validated at call time, not here.
 */
export async function resolveSpecialistModel(
  callsign: SpecialistCallsign,
): Promise<{ model: string; fellBackFrom?: string } | null> {
  const spec = SPECIALISTS[callsign];
  if (!spec) return null;
  if (spec.tier === 'cloud') {
    return { model: spec.preferredModel };
  }
  const installed = new Set((await ollamaListModels()).map((m) => m.name));
  if (installed.has(spec.preferredModel)) {
    return { model: spec.preferredModel };
  }
  for (const candidate of spec.fallbackModels) {
    if (installed.has(candidate)) {
      return { model: candidate, fellBackFrom: spec.preferredModel };
    }
  }
  // Last resort: any installed model that matches by base name (strip tag).
  const baseName = spec.preferredModel.split(':')[0];
  for (const name of installed) {
    if (name.startsWith(`${baseName}:`)) {
      return { model: name, fellBackFrom: spec.preferredModel };
    }
  }
  return null;
}

export interface DelegateOptions {
  chatId?: string;       // Defaults to ALLOWED_CHAT_ID.
  shareMemory?: boolean; // Default true. Inject hivemind memory context.
  signal?: AbortSignal;
  maxTokens?: number;    // Hard cap on output tokens.
  systemAddendum?: string; // Extra task-specific instructions tacked onto the system prompt.
}

// Detect rate-limit / quota / auth errors from the Anthropic SDK so the
// cloud path can fall back to a local specialist instead of failing the
// whole delegation. Match common shapes: HTTP 429, "rate_limit_error",
// "usage_limit", quota messages, and invalid_request_error for bad auth.
function isRateLimitOrQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('usage limit') ||
    msg.includes('usage_limit') ||
    msg.includes('quota') ||
    msg.includes('overloaded') ||
    msg.includes('too many requests') ||
    msg.includes('5h limit') ||
    msg.includes('plan limit')
  );
}

/**
 * Dispatch a task to a specialist. Blocks until the specialist finishes
 * and returns the full output. Logs both sides of the exchange to the
 * shared conversation log and hive_mind table so future turns can see it.
 *
 * Tier behavior:
 *   - 'local': calls Ollama, applies fallbackModels chain, captures both
 *     content and thinking deltas.
 *   - 'cloud': calls the Anthropic Agent SDK via OAuth (Max plan quota,
 *     no API key). Full tool access by default. On rate-limit / quota
 *     error, automatically delegates to fallbackCallsign (a local
 *     specialist) so the task still completes.
 */
export async function delegate(
  callsign: SpecialistCallsign,
  task: string,
  opts: DelegateOptions = {},
): Promise<DelegateResult> {
  const spec = SPECIALISTS[callsign];
  if (!spec) throw new Error(`unknown specialist: ${callsign}`);
  if (!task.trim()) throw new Error('task is empty');

  // Cloud path: route through Anthropic Agent SDK. Falls back to a local
  // specialist on rate-limit so dispatch never silently stalls.
  if (spec.tier === 'cloud') {
    return delegateCloud(spec, task, opts);
  }

  const resolved = await resolveSpecialistModel(callsign);
  if (!resolved) {
    throw new Error(
      `no installed model for ${callsign} (wanted ${spec.preferredModel} or fallbacks: ${spec.fallbackModels.join(', ')})`,
    );
  }

  const chatId = opts.chatId || ALLOWED_CHAT_ID || '';
  const agentNs = `specialist:${callsign}`;
  const shareMemory = opts.shareMemory !== false;

  // Persist the inbound task first so it shows up in history even if the
  // model errors mid-stream.
  logConversationTurn(chatId, 'user', task, undefined, agentNs);

  // Build shared hivemind context unless explicitly disabled. We pass
  // agentNs so this specialist's recent turns are eligible, but NOT
  // strictAgentId so memories from every agent in the hivemind flow in.
  let memoryContext = '';
  if (shareMemory) {
    try {
      const built = await buildMemoryContext(chatId, task, agentNs);
      memoryContext = built.contextText || '';
    } catch {
      memoryContext = '';
    }
  }

  const systemPrompt = [
    spec.systemPrompt,
    opts.systemAddendum ? `\n${opts.systemAddendum}` : '',
    memoryContext ? `\n${memoryContext}` : '',
  ]
    .join('\n')
    .trim();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  let output = '';
  let thinking = '';
  let evalCount = 0;
  let totalDurationNs = 0;
  const startedAt = Date.now();

  // Thinking models (qwen3.x, deepseek-r1, gpt-oss) burn budget on the
  // hidden thinking channel before emitting content. If the caller set a
  // small max-tokens, double it so the model has room to actually reply.
  const thinkingModel = /qwen3|deepseek-r1|gpt-oss/i.test(resolved.model);
  const effectiveMaxTokens = opts.maxTokens && thinkingModel
    ? Math.max(opts.maxTokens * 4, 512)
    : opts.maxTokens;

  await ollamaChat(
    resolved.model,
    messages,
    (ev) => {
      if (ev.delta) output += ev.delta;
      if (ev.thinkingDelta) thinking += ev.thinkingDelta;
      if (ev.done) {
        evalCount = ev.evalCount || 0;
        totalDurationNs = ev.totalDurationNs || 0;
      }
    },
    {
      temperature: spec.temperature,
      num_ctx: spec.defaultContextTokens,
      num_predict: effectiveMaxTokens,
    },
    opts.signal,
  );

  const durationMs = totalDurationNs > 0
    ? Math.round(totalDurationNs / 1e6)
    : Date.now() - startedAt;

  // Thinking-model fallback: if the model emitted reasoning to the
  // `thinking` channel but ran out of tokens before producing content,
  // surface the thinking so the caller still gets something useful.
  if (!output.trim() && thinking.trim()) {
    output = `[no final answer; partial reasoning]\n${thinking.trim()}`;
  }

  // Persist the result and mirror to hive_mind for cross-agent visibility.
  if (output.trim()) {
    logConversationTurn(chatId, 'assistant', output, undefined, agentNs);
    try {
      logToHiveMind(
        agentNs,
        chatId,
        'specialist-delegate',
        output.slice(0, 240),
        JSON.stringify({
          callsign,
          model: resolved.model,
          fellBackFrom: resolved.fellBackFrom,
          evalCount,
          durationMs,
          taskPreview: task.slice(0, 120),
        }),
      );
    } catch {
      // hive_mind insert is best-effort.
    }
  }

  return {
    callsign,
    modelUsed: resolved.model,
    output,
    durationMs,
    tokenEstimate: evalCount,
    fellBackFrom: resolved.fellBackFrom,
  };
}

/**
 * Cloud delegation via Anthropic Agent SDK. Uses OAuth credentials
 * (Anthropic Max plan quota), NOT an API key — so no per-token billing.
 * Inherits the same auth that powers Jarvis main. On rate-limit / quota
 * exhaustion, recursively delegates to the configured fallbackCallsign
 * (a local specialist) so work doesn't stall.
 */
async function delegateCloud(
  spec: SpecialistConfig,
  task: string,
  opts: DelegateOptions,
): Promise<DelegateResult> {
  const chatId = opts.chatId || ALLOWED_CHAT_ID || '';
  const agentNs = `specialist:${spec.callsign}`;
  const shareMemory = opts.shareMemory !== false;
  const startedAt = Date.now();

  // Log inbound first so the task shows up even if the SDK errors.
  logConversationTurn(chatId, 'user', task, undefined, agentNs);

  let memoryContext = '';
  if (shareMemory) {
    try {
      const built = await buildMemoryContext(chatId, task, agentNs);
      memoryContext = built.contextText || '';
    } catch {
      memoryContext = '';
    }
  }

  const systemPrompt = [
    spec.systemPrompt,
    opts.systemAddendum ? `\n${opts.systemAddendum}` : '',
    memoryContext ? `\n${memoryContext}` : '',
  ]
    .join('\n')
    .trim();

  // Anthropic Agent SDK call. OAuth auth is picked up automatically from
  // the parent process credentials (~/.claude/credentials.json or env).
  // We pass the system prompt via prompt prefix because the SDK's
  // single-turn helper doesn't expose a separate system field cleanly.
  // permissionMode 'bypassPermissions' grants full tool access without
  // per-call prompts — same posture Jarvis main runs with.
  let output = '';
  let toolCalls = 0;
  let didCompact = false;
  const abortController = opts.signal
    ? (() => {
        const ctrl = new AbortController();
        opts.signal!.addEventListener('abort', () => ctrl.abort());
        return ctrl;
      })()
    : new AbortController();

  try {
    for await (const event of query({
      prompt: `${systemPrompt}\n\n---\n\nTask:\n${task}`,
      options: {
        cwd: PROJECT_ROOT,
        settingSources: ['project', 'user'],
        permissionMode: spec.cloudAllowTools !== false ? 'bypassPermissions' : 'default',
        allowDangerouslySkipPermissions: spec.cloudAllowTools !== false,
        ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),
        model: spec.preferredModel,
        abortController,
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
      }
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as Array<{ type: string; text?: string; name?: string }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              output += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls++;
            }
          }
        }
      }
      if (ev['type'] === 'result') {
        // Final result event — capture full text if not already streamed
        const result = ev['result'] as string | undefined;
        if (result && !output) output = result;
      }
    }
  } catch (err) {
    // Cloud failed. Try fallbacks in order:
    //   1. Direct local model (spec.localFallbackModel) — fastest path to a
    //      working answer, doesn't pile on another likely-rate-limited cloud
    //      specialist. This is the primary failover after 2026-05-23 when
    //      most specialists became cloud-primary.
    //   2. Redirect to another specialist (spec.fallbackCallsign) — legacy
    //      orchestration path. Useful when localFallbackModel can't handle
    //      this kind of task and there's a sibling specialist that can.
    if (isRateLimitOrQuotaError(err)) {
      // Priority 1: direct local model.
      if (spec.localFallbackModel) {
        logger.warn(
          { callsign: spec.callsign, localFallbackModel: spec.localFallbackModel, err: String(err).slice(0, 200) },
          'cloud specialist rate-limited, falling back to local model directly',
        );
        try {
          logToHiveMind(
            agentNs, chatId, 'specialist-cloud-to-local-fallback',
            `${spec.callsign}: ${spec.preferredModel} → ${spec.localFallbackModel}`,
            JSON.stringify({ error: String(err).slice(0, 200) }),
          );
        } catch { /* best-effort */ }

        try {
          let localOutput = '';
          let localThinking = '';
          await ollamaChat(
            spec.localFallbackModel,
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: task },
            ],
            (ev) => {
              if (ev.delta) localOutput += ev.delta;
              if (ev.thinkingDelta) localThinking += ev.thinkingDelta;
            },
            {
              temperature: spec.temperature,
              num_ctx: spec.defaultContextTokens || 16384,
              num_predict: opts.maxTokens,
            },
            opts.signal,
          );
          if (!localOutput.trim() && localThinking.trim()) {
            localOutput = `[no final answer; partial reasoning]\n${localThinking.trim()}`;
          }
          if (localOutput.trim()) {
            logConversationTurn(chatId, 'assistant', localOutput, undefined, agentNs);
          }
          return {
            callsign: spec.callsign,
            modelUsed: spec.localFallbackModel,
            output: localOutput.trim() || '[local fallback produced no output]',
            durationMs: Date.now() - startedAt,
            tokenEstimate: 0,
            fellBackFrom: spec.preferredModel,
          };
        } catch (localErr) {
          logger.warn(
            { callsign: spec.callsign, err: localErr instanceof Error ? localErr.message : String(localErr) },
            'local fallback model also failed; falling through to callsign redirect',
          );
          // intentional fall-through to fallbackCallsign branch below
        }
      }

      // Priority 2: redirect to a different specialist (legacy orchestration).
      if (spec.fallbackCallsign) {
        logger.warn(
          { callsign: spec.callsign, fallback: spec.fallbackCallsign, err: String(err).slice(0, 200) },
          'cloud specialist rate-limited, redirecting to fallback callsign',
        );
        try {
          logToHiveMind(
            agentNs, chatId, 'specialist-callsign-redirect',
            `${spec.callsign} → ${spec.fallbackCallsign}`,
            JSON.stringify({ error: String(err).slice(0, 200) }),
          );
        } catch { /* best-effort */ }
        const fallbackResult = await delegate(spec.fallbackCallsign, task, opts);
        return {
          ...fallbackResult,
          fellBackFrom: spec.preferredModel,
        };
      }
    }
    throw err;
  }

  const durationMs = Date.now() - startedAt;

  if (output.trim()) {
    logConversationTurn(chatId, 'assistant', output, undefined, agentNs);
    try {
      logToHiveMind(
        agentNs,
        chatId,
        'specialist-delegate-cloud',
        output.slice(0, 240),
        JSON.stringify({
          callsign: spec.callsign,
          tier: 'cloud',
          model: spec.preferredModel,
          toolCalls,
          didCompact,
          durationMs,
          taskPreview: task.slice(0, 120),
        }),
      );
    } catch {
      // Best-effort.
    }
  }

  return {
    callsign: spec.callsign,
    modelUsed: spec.preferredModel,
    output: output.trim() || '[cloud specialist produced no output]',
    durationMs,
    tokenEstimate: 0, // SDK doesn't surface this cleanly; usage tab tracks separately
  };
}

/**
 * Routing helper. Given a task description, suggest the best specialist
 * or 'self' (meaning Jarvis handles it). This is intentionally simple
 * keyword-based; the smarter version uses an LLM router. Either way,
 * Jarvis has final say.
 */
export function suggestRoute(taskDescription: string): SpecialistCallsign | 'self' {
  const t = taskDescription.toLowerCase();

  // Hard "stay with Jarvis" triggers: anything ambiguous, planning,
  // multi-step orchestration, novel reasoning.
  const selfMarkers = [
    'plan', 'orchestrate', 'decide', 'what should i', 'help me think',
    'figure out', 'strategy', 'design the', 'architect',
  ];
  for (const m of selfMarkers) if (t.includes(m)) return 'self';

  // Order matters: more specific specialists first. Cloud supervisors
  // come AFTER local specialists for routine work (so we don't burn Max
  // quota on tasks a local can handle), but BEFORE 'self' fallback when
  // the task is heavy-reasoning or tool-heavy.
  const rules: Array<[SpecialistCallsign, string[]]> = [
    ['coder', ['refactor', 'unit test', 'compile', 'function', 'class ', 'typescript', 'python', 'javascript', 'lint', 'bug', 'stack trace', 'syntax']],
    ['eye', ['image', 'photo', 'screenshot', 'ocr', 'video frame', 'picture', 'what is in this', 'analyze this image']],
    ['cipher', ['csv', 'json data', 'spreadsheet', 'dataset', 'statistics', 'count rows', 'group by']],
    ['sentinel', ['systemd', 'log', 'crash', 'service', 'restart', 'cron', 'deployment', 'health check', 'journalctl']],
    ['reaper', ['uncensored', 'no guardrail', 'red team', 'jailbreak', 'security research', 'no warnings']],
    ['archivist', ['memory', 'remember', 'recall', 'consolidate', 'dedupe', 'salience']],
    ['sleuth', ['research', 'find out about', 'who is', 'what is the latest', 'sources', 'citations']],
    ['scribe', ['summarize', 'rewrite', 'draft', 'format this', 'tldr', 'clean up text', 'caption']],
    // Cloud supervisors — invoked when the task is heavyweight or
    // explicitly named. Atlas for deep / strategic / architectural work,
    // Mercury for parallel scout / fast turn-around.
    ['atlas', ['deep dive', 'architecture review', 'plan this out', 'strategic', 'long-form', 'review the design', 'post-mortem', 'opus']],
    ['mercury', ['quick scout', 'parallel', 'fast draft', 'spin up', 'spin out', 'sonnet']],
  ];

  for (const [callsign, keywords] of rules) {
    for (const kw of keywords) {
      if (t.includes(kw)) return callsign;
    }
  }

  return 'self';
}

/**
 * Smart auto-router. Three-stage fallback chain (Gabe explicitly requested
 * the smartest available model do the routing, since misroutes waste
 * specialist work):
 *
 *   1. Keyword fast-path via suggestRoute (~1ms). If it returns a specific
 *      callsign, trust it — those keywords are unambiguous and burning a
 *      cloud call on them would be wasteful.
 *   2. If keyword returns 'self' AND the task is non-trivial (≥20 chars),
 *      invoke Claude Opus 4.7 via the agent SDK (~3-4s). Opus is the
 *      smartest tier — closest to Jarvis-grade judgment on which specialist
 *      best fits a nuanced task. Runs in single-turn lightweight mode
 *      (no MCP, no CLAUDE.md load).
 *   3. If Opus fails (rate-limit, auth issue, network), fall back to
 *      mistral-small:24b on local Ollama. Non-thinking 24b model — slower
 *      than Opus and a bit dumber, but always available offline.
 *   4. If both fail, default to 'self' so Jarvis handles.
 *
 * Never throws — routing is best-effort and must always return something.
 * Gabe is on Anthropic Max so cloud quota is effectively unlimited; the
 * local fallback is purely for the "should never happen" cases.
 */
export async function intelligentRoute(task: string): Promise<{
  callsign: SpecialistCallsign | 'self';
  source: 'keyword' | 'opus' | 'local-fallback' | 'fallback';
  reason: string;
}> {
  const keywordPick = suggestRoute(task);
  if (keywordPick !== 'self') {
    return {
      callsign: keywordPick,
      source: 'keyword',
      reason: `keyword heuristic matched ${keywordPick}`,
    };
  }

  const trimmed = task.trim();
  if (trimmed.length < 20) {
    return {
      callsign: 'self',
      source: 'fallback',
      reason: 'task too short for routing — Jarvis handles',
    };
  }

  // Build the router prompt once — both cloud and local fallback use it.
  const routerPrompt = [
    'You are the task router for Jarvis (Gabriel\'s AI COO). Your job: pick the BEST specialist for the given task. Be decisive.',
    '',
    'Specialists:',
    '- scribe: writing, summaries, drafts, rewrites, formatting, short copy',
    '- coder: code reading, refactors, tests, bug fixes, language conversions',
    '- eye: image / video analysis, OCR, screenshot triage, visual classification',
    '- sleuth: research synthesis, multi-source fact gathering, citations, "tell me about X" style questions',
    '- reaper: uncensored / no-guardrail work (security research, red-team, edgy creative drafting)',
    '- archivist: memory consolidation, recall queries, deduplication, salience scoring',
    '- sentinel: sysadmin, log triage, infra / systemd troubleshooting, deployment diagnostics',
    '- cipher: data analysis, CSV / JSON crunching, statistics, pattern extraction',
    '- atlas: heavyweight reasoning, planning, architecture review, multi-step decomposition (Opus 4.7)',
    '- mercury: fast execution, parallel scout work, drafting under speed pressure (Sonnet 4.6)',
    '- self: Jarvis handles directly. Use only when truly conversational, trivially small, or genuinely orchestration-level (Jarvis decomposes then re-routes parts).',
    '',
    `Task:\n${trimmed}`,
    '',
    'Reply with ONLY the callsign — one word, lowercase. No explanation. No punctuation.',
  ].join('\n');

  // ── Stage 2: Claude Opus 4.7 via agent SDK ────────────────────────────
  // Single-turn, no MCP, no CLAUDE.md — minimum overhead. Auth flows via
  // OAuth (no ANTHROPIC_API_KEY required, rides Gabe's Max plan).
  try {
    let cloudOut = '';
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      for await (const event of query({
        prompt: routerPrompt,
        options: {
          model: 'claude-opus-4-7',
          maxTurns: 1,
          settingSources: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          abortController: ctrl,
        },
      })) {
        const ev = event as Record<string, unknown>;
        if (ev.type !== 'assistant') continue;
        const msg = ev.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        if (!msg?.content) continue;
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) cloudOut += block.text;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const cleaned = cloudOut
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .pop()
      ?.replace(/[^a-z]/g, '') ?? '';

    if (cleaned === 'self') {
      return { callsign: 'self', source: 'opus', reason: 'Opus 4.7 chose self' };
    }
    if ((ALL_CALLSIGNS as string[]).includes(cleaned)) {
      return {
        callsign: cleaned as SpecialistCallsign,
        source: 'opus',
        reason: `Opus 4.7 chose ${cleaned}`,
      };
    }
    // Unparseable — fall through to local fallback rather than defaulting
    // to 'self' since the task is non-trivial and we have another tier to try.
    logger.warn(
      { cleanedOutput: cleaned.slice(0, 80), rawLen: cloudOut.length },
      'Opus router returned unparseable response, falling through to local fallback',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Opus router failed, falling through to local mistral fallback',
    );
  }

  // ── Stage 3: local fallback — mistral-small:24b ────────────────────────
  // Should rarely trigger (Max plan = effectively unlimited quota). Mistral
  // is non-thinking so it answers within a tight num_predict budget without
  // burning it on hidden reasoning.
  const LOCAL_FALLBACK_MODEL = 'mistral-small:24b';
  try {
    let localOut = '';
    await ollamaChat(
      LOCAL_FALLBACK_MODEL,
      [{ role: 'user', content: routerPrompt }],
      (ev) => { if (ev.delta) localOut += ev.delta; },
      { temperature: 0.0, num_ctx: 2048, num_predict: 16 },
    );

    const cleaned = localOut
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .pop()
      ?.replace(/[^a-z]/g, '') ?? '';

    if (cleaned === 'self') {
      return { callsign: 'self', source: 'local-fallback', reason: 'mistral-small chose self (Opus unavailable)' };
    }
    if ((ALL_CALLSIGNS as string[]).includes(cleaned)) {
      return {
        callsign: cleaned as SpecialistCallsign,
        source: 'local-fallback',
        reason: `mistral-small chose ${cleaned} (Opus unavailable)`,
      };
    }
    return {
      callsign: 'self',
      source: 'fallback',
      reason: `local fallback returned unparseable: "${cleaned.slice(0, 40)}" — defaulting to self`,
    };
  } catch (err) {
    return {
      callsign: 'self',
      source: 'fallback',
      reason: `both Opus and local fallback failed; defaulting to self. Last error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
