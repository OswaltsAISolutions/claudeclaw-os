import { agentObsidianConfig, GOOGLE_API_KEY, MEMORY_NUDGE_INTERVAL_TURNS, MEMORY_NUDGE_INTERVAL_HOURS } from './config.js';
import {
  batchUpdateMemoryRelevance,
  decayMemories,
  getConsolidationsWithEmbeddings,
  getDashboardPinnedMemories,
  getLastMemorySaveTime,
  getOtherAgentActivity,
  getRecentConsolidations,
  getRecentHighImportanceMemories,
  getRecentWarRoomTranscriptForChat,
  getTurnCountSinceTimestamp,
  logConversationTurn,
  pinMemory,
  pruneConversationLog,
  pruneSlackMessages,
  pruneWaMessages,
  pruneWarRoomMeetings,
  saveMemoryEmbedding,
  saveStructuredMemory,
  searchConversationHistory,
  searchMemories,
} from './db.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { logger } from './logger.js';
import { ingestConversationTurn } from './memory-ingest.js';
import { buildObsidianContext } from './obsidian.js';

/**
 * Build a structured memory context string to prepend to the user's message.
 *
 * 2026-05-25 rewrite — unified global ranking + byte budget.
 *
 * Old design: 5 independent layers each dumped their top-K with no global
 * cap. A typical turn produced ~10 KB of preamble — long enough to bloat
 * local-model context windows and leak into chat UIs when joins went
 * wrong (see [[bug from 2026-05-24 chat-leak incident]]).
 *
 * New design:
 *   1) CORE: pinned memories (explicitly marked permanent by the user).
 *      Always rides, capped at 2 entries / ~250 bytes. Skipped when empty.
 *   2) CTX:  unified pool of (semantic-search memories + recent-high-importance
 *      memories + consolidation insights + recent team activity + recall
 *      history). Each candidate gets a composite score
 *      `relevance × 0.65 + importance × 0.25 + recency × 0.10`, where
 *      relevance = cosine(query, embedding) for embedded items, or a
 *      default mid-tier signal (0.55) for items without embeddings.
 *      We pick top items in score order until we hit ~2.5 KB / 8 entries.
 *
 * Target: total memory block ≤ 3 KB (down from ~10 KB). Local 30b models
 * have noticeably better instruction-following with shorter contexts; this
 * is the single biggest lever for output quality after the local pivot.
 */
export interface MemoryContextResult {
  contextText: string;
  surfacedMemoryIds: number[];
  surfacedMemorySummaries: Map<number, string>;
}

// Budget knobs. Tunable; defaults picked from empirical testing on
// typical Jarvis prompts (~6 entries fits comfortably in 2.5 KB).
const CTX_BYTE_BUDGET = 2500;
const CTX_MAX_ITEMS = 8;
const CORE_MAX_ITEMS = 2;
const CORE_BYTE_BUDGET = 250;
// Items without an embedding get this as their relevance signal — middle
// of the road. Strong importance/recency can still float them up, but
// they can't outrank a semantically-perfect match.
const NO_EMBEDDING_RELEVANCE = 0.55;

/** Source kind for a ranked candidate. The label survives into the
 *  rendered output as a one-character prefix so the model can tell a
 *  background fact from live team activity without verbose section
 *  headers. */
type CandidateKind = 'mem' | 'insight' | 'team' | 'history';

interface RankCandidate {
  kind: CandidateKind;
  id: number | null;         // null for non-memory sources (insights, team, history)
  summary: string;           // The one-line display text
  embedding: number[] | null;
  importance: number;        // 0..1
  ageSeconds: number;
  /** Optional prefix tag rendered before the summary (e.g. @scribe, 2d). */
  tag?: string;
  /** Override score; when set, skip composite computation (used by team
   *  activity which gets a fixed recency-driven score). */
  scoreOverride?: number;
}

interface RankedCandidate extends RankCandidate {
  score: number;
}

/** Compute composite relevance score for a candidate. */
function scoreCandidate(c: RankCandidate, queryEmbedding: number[] | undefined): number {
  if (typeof c.scoreOverride === 'number') return c.scoreOverride;
  const relevance = queryEmbedding && queryEmbedding.length > 0 && c.embedding && c.embedding.length > 0
    ? Math.max(0, cosineSimilarity(queryEmbedding, c.embedding))
    : NO_EMBEDDING_RELEVANCE;
  const importance = Math.max(0, Math.min(1, c.importance));
  // Exponential recency decay with a 1-week half-life. Items younger than
  // a few hours sit near 1.0; week-old items sit near 0.5; month-old
  // items near 0.1.
  const recency = Math.exp(-c.ageSeconds / (7 * 24 * 3600));
  return relevance * 0.65 + importance * 0.25 + recency * 0.10;
}

/** Parse the stored embedding column. Returns null for empty/missing. */
function parseEmbedding(stored: string | null | undefined): number[] | null {
  if (!stored) return null;
  try {
    const arr = JSON.parse(stored);
    if (Array.isArray(arr) && arr.length > 0) return arr as number[];
  } catch {
    /* fall through */
  }
  return null;
}

/** Format a candidate as a single output line. */
function renderCandidate(c: RankedCandidate): string {
  const score = c.score.toFixed(2);
  const tag = c.tag ? ` ${c.tag}` : '';
  return `${score}${tag} ${c.summary}`;
}

/** Pick candidates in score order until byte/item budgets are hit. */
function selectByBudget(
  candidates: RankedCandidate[],
  byteBudget: number,
  maxItems: number,
): RankedCandidate[] {
  const picked: RankedCandidate[] = [];
  let used = 0;
  for (const c of candidates) {
    if (picked.length >= maxItems) break;
    const line = renderCandidate(c);
    const lineCost = line.length + 1; // +1 for newline
    if (used + lineCost > byteBudget) continue; // try smaller items further down the list
    picked.push(c);
    used += lineCost;
  }
  return picked;
}

export interface BuildMemoryContextOpts {
  /** Include consolidation insights (Layer 3). Default true.
   *  War room callers pass false because the consolidations table lacks
   *  agent_id and would leak across-agent insights. */
  includeConsolidations?: boolean;
  /** Include `getOtherAgentActivity` block (Layer 4). Default true.
   *  War room callers pass false to keep strict per-agent isolation. */
  includeTeamActivity?: boolean;
  /** Include conversation history recall (Layer 5). Default true. */
  includeRecallHistory?: boolean;
  /** Strict per-agent retrieval. When omitted, memories from any agent in
   *  the chat are eligible (legacy Telegram behavior). When set, search
   *  is constrained to memories with `agent_id = strictAgentId`. */
  strictAgentId?: string;
  /** When set, append a war-room transcript bridge (last N rows from any
   *  meeting in this chat, optionally excluding the current meeting). */
  warRoomBridge?: { excludeMeetingId?: string; limit?: number };
}

export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  agentId = 'main',
  opts: BuildMemoryContextOpts = {},
): Promise<MemoryContextResult> {
  const {
    includeConsolidations = true,
    includeTeamActivity = true,
    includeRecallHistory = true,
    strictAgentId,
    warRoomBridge,
  } = opts;
  const surfacedIds = new Set<number>();
  const summaryMap = new Map<number, string>();
  const now = Math.floor(Date.now() / 1000);

  // Embed the query once for vector scoring across all sources. Local
  // bge-m3 (~200ms); failures are non-fatal — items without embeddings
  // fall back to NO_EMBEDDING_RELEVANCE in scoreCandidate().
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await embedText(userMessage);
  } catch {
    /* non-fatal */
  }

  // ── CORE: pinned memories ────────────────────────────────────────
  // Pinned memories are user-marked "remember this permanently". They
  // always ride at the top of the context, regardless of query relevance,
  // because they're typically identity facts (who the user is, role,
  // hard rules) that the agent needs every turn.
  let corePicked: RankedCandidate[] = [];
  if (!strictAgentId) {
    const pinned = getDashboardPinnedMemories(chatId);
    const coreCandidates: RankedCandidate[] = pinned.map((m) => ({
      kind: 'mem' as const,
      id: m.id,
      summary: m.summary,
      embedding: parseEmbedding(m.embedding),
      importance: m.importance,
      ageSeconds: now - m.accessed_at,
      // Score override: importance × 1.0 keeps the top-importance pinned
      // items first; we don't rerank by query relevance because pinned
      // items are deliberately background-context.
      scoreOverride: m.importance,
      score: m.importance,
    }));
    coreCandidates.sort((a, b) => b.score - a.score);
    corePicked = selectByBudget(coreCandidates, CORE_BYTE_BUDGET, CORE_MAX_ITEMS);
    for (const c of corePicked) {
      if (c.id !== null) {
        surfacedIds.add(c.id);
        summaryMap.set(c.id, c.summary);
      }
    }
  }

  // ── Build the candidate pool for the CTX block ───────────────────
  const pool: RankCandidate[] = [];

  // Source 1: semantic + FTS hybrid search over memories. Pull a larger
  // pool (15) than we'll emit so the global ranker has options.
  const searched = searchMemories(chatId, userMessage, 15, queryEmbedding, strictAgentId);
  for (const mem of searched) {
    if (surfacedIds.has(mem.id)) continue;
    pool.push({
      kind: 'mem',
      id: mem.id,
      summary: mem.summary,
      embedding: parseEmbedding(mem.embedding),
      importance: mem.importance,
      ageSeconds: now - mem.accessed_at,
    });
  }

  // Source 2: recent high-importance memories. Some of these may already
  // be in the search results (dedup by id). Cap pool growth at 10.
  const recentHigh = getRecentHighImportanceMemories(chatId, 10, strictAgentId);
  for (const mem of recentHigh) {
    if (surfacedIds.has(mem.id)) continue;
    if (pool.some((p) => p.kind === 'mem' && p.id === mem.id)) continue;
    pool.push({
      kind: 'mem',
      id: mem.id,
      summary: mem.summary,
      embedding: parseEmbedding(mem.embedding),
      importance: mem.importance,
      ageSeconds: now - mem.accessed_at,
    });
  }

  // Source 3: consolidation insights. Embedding-aware when available.
  if (includeConsolidations && !strictAgentId) {
    const embedded = getConsolidationsWithEmbeddings(chatId);
    if (embedded.length > 0) {
      for (const c of embedded) {
        pool.push({
          kind: 'insight',
          id: null,
          summary: c.insight,
          embedding: Array.isArray(c.embedding) ? c.embedding : null,
          importance: 0.6,           // insights treated as "moderately important"
          ageSeconds: 0,             // (no created_at on this shape) — treat as fresh
        });
      }
    } else {
      // Fallback: a couple recent insights, no embedding signal.
      for (const c of getRecentConsolidations(chatId, 3)) {
        pool.push({
          kind: 'insight',
          id: null,
          summary: c.insight,
          embedding: null,
          importance: 0.5,
          ageSeconds: 0,
        });
      }
    }
  }

  // Source 4: team activity (other agents' hivemind entries, last 24h).
  // We pull a tighter window than the old 10 (now 6) and let global
  // ranking decide which ones actually deserve to surface.
  if (includeTeamActivity) {
    const teamRows = getOtherAgentActivity(agentId, 24, 6);
    for (const entry of teamRows) {
      const age = now - entry.created_at;
      const ago = age < 3600
        ? `${Math.max(1, Math.round(age / 60))}m`
        : `${Math.round(age / 3600)}h`;
      pool.push({
        kind: 'team',
        id: null,
        summary: entry.summary,
        embedding: null,
        importance: 0.45,
        ageSeconds: age,
        tag: `@${entry.agent_id.replace(/^specialist:/, '')}/${ago}`,
      });
    }
  }

  // Source 5: conversation history (only when the prompt itself hints
  // at a recall query — e.g. "what did we do yesterday"). We add these
  // to the same pool so they compete with memories on relevance.
  if (includeRecallHistory) {
    const recallKeywords = new RegExp(
      [
        '\\bremember\\b', '\\brecall\\b', '\\byesterday\\b', '\\blast time\\b',
        '\\bwe talked\\b', '\\bwe discussed\\b', '\\bwhat do you know\\b',
        '\\bdo you know\\b', '\\bpreviously\\b', '\\bearlier\\b',
        '\\blast week\\b', '\\bfew days\\b',
        '\\bshipped\\b', '\\bshipping\\b',
        "\\btoday'?s?\\b.*\\b(wins?|activity|work|progress|recap|summary)\\b",
        '\\bwhat we (did|have|worked|built|shipped|discussed|talked|made)\\b',
        '\\bwhat (did|have|are|were) we\\b',
        '\\bwhat\'?s been (shipped|done|happening|going|new|built)\\b',
        '\\bsummarize (today|the day|recent|the last)\\b',
        '\\brecap\\b', '\\bwhat happened\\b', '\\btldr\\b', '\\btl;?dr\\b',
        '\\blast \\d+ (hour|day|week|month)s?\\b',
        '\\blast (few|several) (hour|day|week|month)s?\\b',
        '\\bin the last (hour|day|week|month|24|48|72)\\b',
        '\\bprogress (update|report|so far)\\b',
        '\\bstatus (update|report|check)\\b',
        '\\bwhere are we\\b', '\\bwhere we (left|stand)\\b',
      ].join('|'),
      'i',
    );
    if (recallKeywords.test(userMessage)) {
      const historyTurns = searchConversationHistory(chatId, userMessage, agentId, 4, 10);
      for (const t of historyTurns) {
        const age = now - t.created_at;
        const daysAgo = Math.round(age / 86400);
        const ago = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d' : `${daysAgo}d`;
        const role = t.role === 'user' ? 'User' : 'You';
        const trimmed = t.content.length > 200 ? t.content.slice(0, 200) + '…' : t.content;
        pool.push({
          kind: 'history',
          id: null,
          summary: `${role}: ${trimmed}`,
          embedding: null,
          importance: 0.5,
          ageSeconds: age,
          tag: ago,
        });
      }
    }
  }

  // ── Global ranking and budgeted selection ─────────────────────────
  const scored: RankedCandidate[] = pool.map((c) => ({ ...c, score: scoreCandidate(c, queryEmbedding) }));
  scored.sort((a, b) => b.score - a.score);
  const ctxPicked = selectByBudget(scored, CTX_BYTE_BUDGET, CTX_MAX_ITEMS);
  for (const c of ctxPicked) {
    if (c.id !== null) {
      surfacedIds.add(c.id);
      summaryMap.set(c.id, c.summary);
    }
  }

  // ── War-room bridge (separate block; kept verbatim) ──────────────
  // Treated separately because it's a chronological transcript, not a
  // collection of facts to rank. Capped at 6 lines max.
  let warRoomBlock = '';
  if (warRoomBridge) {
    const cutoff = now - 24 * 3600;
    const rows = getRecentWarRoomTranscriptForChat(chatId, {
      limit: Math.min(warRoomBridge.limit ?? 6, 6),
      sinceTs: cutoff,
      excludeMeetingId: warRoomBridge.excludeMeetingId,
    });
    if (rows.length > 0) {
      const lines = rows.slice().reverse().map((r) => {
        const speaker = r.speaker === 'user' ? 'User' : r.speaker;
        const snippet = r.text.length > 160 ? r.text.slice(0, 160) + '…' : r.text;
        return `${speaker}: ${snippet}`;
      });
      warRoomBlock = `[war room]\n${lines.join('\n')}\n[/war room]`;
    }
  }

  // ── Assemble final block ─────────────────────────────────────────
  const parts: string[] = [];
  if (corePicked.length > 0) {
    const lines = corePicked.map((c) => c.summary);
    parts.push(`[core]\n${lines.join('\n')}\n[/core]`);
  }
  if (ctxPicked.length > 0) {
    const lines = ctxPicked.map((c) => renderCandidate(c));
    parts.push(`[ctx · ${ctxPicked.length}]\n${lines.join('\n')}\n[/ctx]`);
  }
  if (warRoomBlock) parts.push(warRoomBlock);

  const obsidianBlock = buildObsidianContext(agentObsidianConfig);
  if (obsidianBlock) parts.push(obsidianBlock);

  // Trace the final size so we can monitor for regressions / bloat
  // creep over time. Cheap (one log line per turn) and high-signal —
  // an unexpected jump back into 8 KB territory means a new source got
  // wired in without going through the budget gate.
  const contextText = parts.join('\n\n');
  logger.info(
    {
      chatId,
      agentId,
      coreItems: corePicked.length,
      ctxItems: ctxPicked.length,
      contextBytes: contextText.length,
      poolSize: pool.length,
      hadEmbedding: !!(queryEmbedding && queryEmbedding.length > 0),
    },
    '[memory] context built',
  );

  return {
    contextText,
    surfacedMemoryIds: [...surfacedIds],
    surfacedMemorySummaries: summaryMap,
  };
}

/**
 * Persist the assistant turn of a successful user/assistant exchange and
 * fire fire-and-forget memory ingestion on the pair.
 *
 * The user turn is NOT persisted here — that now happens BEFORE the agent
 * runs (Phase 2 fix, 2026-05-21), so an aborted or SIGTERMed run never
 * leaves an orphan. Call this only on the success path; abort / error
 * branches should write a direct `logConversationTurn('assistant', ...)`
 * because we never want to memory-ingest a timeout or crash message.
 */
export function logAssistantTurn(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  sessionId?: string,
  agentId = 'main',
): void {
  try {
    logConversationTurn(chatId, 'assistant', assistantResponse, sessionId, agentId);
  } catch (err) {
    logger.error({ err }, 'Failed to log assistant turn');
  }

  // Fire-and-forget: LLM-powered memory extraction over the full pair.
  void ingestConversationTurn(chatId, userMessage, assistantResponse, agentId).catch((err) => {
    logger.error({ err }, 'Memory ingestion fire-and-forget failed');
  });
}

/**
 * Create a new pinned memory from arbitrary user-supplied text.
 *
 * "Pinned" here is the existing memories.pinned flag — these entries are
 * exempt from decay AND always ride at the top of buildMemoryContext()'s
 * CORE block. Used by the `/pin <text>` Telegram command and the
 * dashboard's POST /api/memory/pin endpoint so the user can promote
 * facts to permanent without having to know existing memory IDs.
 *
 * Embedding generation is fire-and-forget so the caller doesn't pay the
 * ~200ms bge-m3 round-trip. Without an embedding the entry still rides
 * in CORE (CORE doesn't rank by relevance), just won't show up in the
 * RANKED block until the next ingest pass re-embeds it.
 */
export async function createPinnedMemory(
  chatId: string,
  text: string,
  agentId = 'main',
): Promise<{ id: number; summary: string }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('pinned memory text is empty');
  // Use the first 140 chars as the displayable summary. The full text
  // goes into raw_text so future re-summarization passes have the
  // original to work with.
  const summary = trimmed.length > 140 ? trimmed.slice(0, 140) + '…' : trimmed;
  const id = saveStructuredMemory(
    chatId,
    trimmed,                // raw_text
    summary,                // summary (display)
    [],                     // entities
    ['user-pinned'],        // topics
    0.95,                   // importance (just below 1.0 so user can override later)
    'user-pin',             // source
    agentId,
  );
  pinMemory(id);

  // Embed in background. Best-effort: if Ollama is down the memory still
  // exists, it just won't show up in semantic search until something
  // else re-embeds it.
  embedText(trimmed).then((vec) => {
    if (vec.length > 0) {
      try {
        saveMemoryEmbedding(id, vec);
      } catch (err) {
        logger.warn({ err: (err as Error).message, id }, '[memory] failed to save pinned embedding');
      }
    }
  }).catch(() => { /* embedding miss is non-fatal */ });

  return { id, summary };
}

/**
 * Run the daily decay sweep. Call once on startup and every 24h.
 * Also prunes old conversation_log entries to prevent unbounded growth.
 *
 * MESSAGE RETENTION POLICY:
 * WhatsApp and Slack messages are auto-deleted after 3 days.
 * This is a security measure: message bodies contain personal
 * conversations that must not persist on disk indefinitely.
 */
export function runDecaySweep(): void {
  decayMemories();
  pruneConversationLog(500);

  // Enforce 3-day retention on messaging data
  const wa = pruneWaMessages(3);
  const slack = pruneSlackMessages(3);
  // 90-day retention on ended war-room meetings (configurable later via
  // env var if needed). Without this, warroom_meetings + warroom_transcript
  // grow unbounded — every voice/text meeting persists forever.
  const wr = pruneWarRoomMeetings(90);
  if (wa.messages + wa.outbox + wa.map + slack + wr.meetings + wr.convLog > 0) {
    logger.info(
      {
        wa_messages: wa.messages, wa_outbox: wa.outbox, wa_map: wa.map, slack,
        warroom_meetings: wr.meetings, warroom_conv_log: wr.convLog,
      },
      'Retention pruning complete',
    );
  }
}

/**
 * After an agent response, evaluate which surfaced memories were useful.
 * Fire-and-forget, never blocks the user. Has a 5-second timeout.
 */
export async function evaluateMemoryRelevance(
  surfacedMemoryIds: number[],
  memorySummaries: Map<number, string>,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  if (surfacedMemoryIds.length === 0 || !GOOGLE_API_KEY) return;

  try {
    // Build a list of memories with their content so Gemini can actually judge
    const memoryList = surfacedMemoryIds
      .map((id) => `  ${id}: "${(memorySummaries.get(id) ?? '').slice(0, 100)}"`)
      .join('\n');

    const prompt = `Given this conversation, which memories were actually relevant and useful for the response? Return ONLY a JSON array of useful memory IDs. If none were useful, return [].

User: ${userMessage.slice(0, 500)}
Response: ${assistantResponse.slice(0, 500)}

Memories that were surfaced:
${memoryList}`;

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Evaluation timeout')), 5000),
    );
    const raw = await Promise.race([generateContent(prompt), timeoutPromise]);
    const usefulIds = parseJsonResponse<number[]>(raw);
    if (!usefulIds || !Array.isArray(usefulIds)) return;

    batchUpdateMemoryRelevance(surfacedMemoryIds, new Set(usefulIds));
  } catch {
    // Non-fatal, never block
  }
}

/**
 * Check whether a memory nudge should be injected into the context.
 * Returns true if enough turns or time have passed since the last memory save.
 */
export function shouldNudgeMemory(chatId: string, agentId = 'main'): boolean {
  const lastSave = getLastMemorySaveTime(chatId, agentId);

  // Never nudge if no memories have been saved yet (first conversation)
  if (lastSave === null) return false;

  const now = Math.floor(Date.now() / 1000);
  const hoursSinceSave = (now - lastSave) / 3600;

  // Time-based nudge
  if (hoursSinceSave >= MEMORY_NUDGE_INTERVAL_HOURS) return true;

  // Turn-based nudge
  const turnsSinceSave = getTurnCountSinceTimestamp(chatId, lastSave, agentId);
  if (turnsSinceSave >= MEMORY_NUDGE_INTERVAL_TURNS) return true;

  return false;
}

export const MEMORY_NUDGE_TEXT = '[Memory nudge: It has been a while since anything was saved to long-term memory. If any decisions, preferences, or important facts came up in this conversation, consider mentioning them so they can be remembered.]';

/** Safely parse a JSON array string, returning [] on failure. */
function safeParse(json: string): string[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
