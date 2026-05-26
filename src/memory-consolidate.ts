import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  getUnconsolidatedMemories,
  saveConsolidationAtomic,
  saveConsolidationEmbedding,
} from './db.js';
import { embedText } from './embeddings.js';
import { requireEnabled } from './kill-switches.js';
import { logger } from './logger.js';
import { parseJsonResponse } from './gemini.js';

interface ConsolidationResult {
  summary: string;
  insight: string;
  connections: Array<{
    from_id: number;
    to_id: number;
    relationship: string;
  }>;
  contradictions?: Array<{
    stale_id: number;
    supersedes_id: number;
    reason: string;
  }>;
}

// 2026-05-23: upgraded from Haiku 4.5 → Sonnet 4.6 per the intelligence-over-
// cost principle. Memory consolidation quality matters more than speed —
// Sonnet produces sharper insights, better connection mapping, and better
// contradiction detection than Haiku at the cost of slightly higher latency
// (still <1 minute per consolidation run, well within the 30-min cadence).
const CONSOLIDATION_MODEL = 'claude-sonnet-4-6';
const CONSOLIDATION_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. You find patterns and connections across a user's recent memories.

Given these unconsolidated memories:
{MEMORIES}

Your job:
1. Find cross-cutting patterns, themes, or connections between memories
2. Create a synthesized summary that captures the overall picture
3. Identify one key insight that emerges from these memories together
4. Map connections between specific memories (use their IDs)
5. Check for CONTRADICTIONS: if any memory updates, corrects, or supersedes an earlier one, flag it. IMPORTANT: Compare the created_at timestamps to determine which is newer. The memory with the LATER timestamp is authoritative (it's the correction). Set stale_id to the OLDER memory's ID and supersedes_id to the NEWER memory's ID.

Return ONLY a JSON object — no prose, no markdown fences, no commentary:
{
  "summary": "A synthesized view across all source memories",
  "insight": "One key pattern or insight that emerges",
  "connections": [
    {"from_id": N, "to_id": M, "relationship": "description of how they relate"}
  ],
  "contradictions": [
    {"stale_id": N, "supersedes_id": M, "reason": "why the newer one replaces the older"}
  ]
}

If memories are unrelated, still summarize but note they cover different topics. Connections and contradictions arrays can be empty if none exist.`;

/**
 * Run one consolidation pass via Haiku 4.5 (Phase 5 swap, 2026-05-21).
 *
 * The previous implementation used `@google/genai` Gemini 2.0 Flash, which
 * was hitting hard 429 free-tier quotas every 30 minutes. The user is on
 * Anthropic Max, so we now reuse the existing `claude-agent-sdk` (no
 * separate API key required — auth flows through `claude login`).
 */
async function generateHaikuJson(prompt: string): Promise<string> {
  requireEnabled('LLM_SPAWN_ENABLED');

  let text = '';
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CONSOLIDATION_TIMEOUT_MS);

  try {
    for await (const event of query({
      prompt,
      options: {
        model: CONSOLIDATION_MODEL,
        // Single-turn: consolidation doesn't need tool use or follow-ups.
        maxTurns: 1,
        // Skip CLAUDE.md / settings load — we're calling Haiku directly.
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (ev.type !== 'assistant') continue;
      const msg = ev.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (!msg?.content) continue;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          text += block.text;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return text;
}

async function generateHaikuJsonWithRetry(prompt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await generateHaikuJson(prompt);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /\b(429|529)\b|overloaded|rate.?limit/i.test(msg);
      if (!isRetryable || attempt === RETRY_DELAYS_MS.length) break;
      const delay = RETRY_DELAYS_MS[attempt];
      logger.warn({ err, attempt: attempt + 1, delay }, 'Consolidation Haiku call failed, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// Guard against overlapping consolidation runs (keyed by chatId)
const consolidatingChats = new Set<string>();

/**
 * Run consolidation for a given chat. Finds patterns across unconsolidated
 * memories and creates synthesis records. Safe to call frequently; it's
 * a no-op if fewer than 2 memories are pending or if already running.
 */
export async function runConsolidation(chatId: string): Promise<void> {
  if (consolidatingChats.has(chatId)) {
    logger.debug({ chatId }, 'Consolidation already running for this chat, skipping');
    return;
  }

  consolidatingChats.add(chatId);
  try {
    const memories = getUnconsolidatedMemories(chatId, 20);

    if (memories.length < 2) {
      logger.debug({ count: memories.length }, 'Not enough memories to consolidate');
      return;
    }

    const memoriesJson = memories.map((m) => ({
      id: m.id,
      summary: m.summary,
      entities: JSON.parse(m.entities),
      topics: JSON.parse(m.topics),
      importance: m.importance,
      created_at: new Date(m.created_at * 1000).toISOString(),
    }));

    const prompt = CONSOLIDATION_PROMPT.replace(
      '{MEMORIES}',
      JSON.stringify(memoriesJson, null, 2),
    );

    const raw = await generateHaikuJsonWithRetry(prompt);
    const result = parseJsonResponse<ConsolidationResult>(raw);

    if (!result || !result.summary || !result.insight) {
      logger.warn({ raw: raw.slice(0, 200) }, 'Consolidation produced invalid result');
      return;
    }

    const sourceIds = memories.map((m) => m.id);

    const validConnections: Array<{ from_id: number; to_id: number; relationship: string }> = [];
    if (result.connections && result.connections.length > 0) {
      for (const conn of result.connections) {
        if (!conn.from_id || !conn.to_id) continue;
        if (!sourceIds.includes(conn.from_id) || !sourceIds.includes(conn.to_id)) continue;
        validConnections.push(conn);
      }
    }

    const validContradictions: Array<{ stale_id: number; superseded_by: number }> = [];
    if (result.contradictions && result.contradictions.length > 0) {
      for (const contra of result.contradictions) {
        if (!sourceIds.includes(contra.stale_id) || !sourceIds.includes(contra.supersedes_id)) {
          logger.warn(
            { staleId: contra.stale_id, supersededBy: contra.supersedes_id, reason: contra.reason },
            'Contradiction detected but IDs not in current batch, skipping',
          );
          continue;
        }
        const staleMem = memories.find((m) => m.id === contra.stale_id);
        const newMem = memories.find((m) => m.id === contra.supersedes_id);
        let staleId = contra.stale_id;
        let supersededBy = contra.supersedes_id;
        if (staleMem && newMem && staleMem.created_at > newMem.created_at) {
          staleId = contra.supersedes_id;
          supersededBy = contra.stale_id;
          logger.warn(
            { originalStale: contra.stale_id, correctedStale: staleId },
            'Corrected contradiction direction (LLM assigned newer memory as stale)',
          );
        }
        validContradictions.push({ stale_id: staleId, superseded_by: supersededBy });
        logger.info(
          { staleId, supersededBy, reason: contra.reason },
          'Memory superseded (contradiction resolved)',
        );
      }
    }

    const consolidationId = saveConsolidationAtomic(
      chatId, sourceIds, result.summary, result.insight,
      validConnections, validContradictions,
    );

    try {
      const embeddingText = `${result.summary} ${result.insight}`;
      const embedding = await embedText(embeddingText);
      if (embedding.length > 0) {
        saveConsolidationEmbedding(consolidationId, embedding);
      }
    } catch (embErr) {
      logger.warn({ err: embErr, consolidationId }, 'Failed to embed consolidation');
    }

    logger.info(
      {
        chatId,
        sourceCount: sourceIds.length,
        connections: result.connections?.length ?? 0,
        insight: result.insight.slice(0, 80),
        model: CONSOLIDATION_MODEL,
      },
      'Consolidation complete',
    );
  } catch (err) {
    logger.error({ err }, 'Consolidation failed');
  } finally {
    consolidatingChats.delete(chatId);
  }
}
