// Story clustering for the Content Engine.
//
// Multiple saves and sweep hits about the SAME underlying story should be
// ONE video opportunity, not Studio clutter. After an item lands with
// intent=content, this compares it against recent content items on the same
// track with a single cheap model call and, on a match, stamps a shared
// cluster_id (the anchor = the earliest item's id). The Studio collapses
// shared cluster_ids into one card.
//
// Conservative on purpose: "same story" means the same underlying event or
// release, not the same general topic. A miss just means two cards — annoying
// but harmless. A false merge hides material, which is worse.

import {
  getLibraryItem,
  listLibraryItems,
  updateLibraryItem,
  type LibraryItem,
} from './db.js';
import { delegate } from './specialists.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'content-cluster', ...extra }, msg);

const RECENT_DAYS = 14;
const CANDIDATE_LIMIT = 30;

function gist(item: LibraryItem): string {
  return (item.content_angle ?? item.caption ?? '').split('\n')[0].slice(0, 180);
}

function extractJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

/**
 * Try to attach `itemId` to an existing story cluster. Returns the cluster id
 * it joined, or null if it stays a singleton. Never throws.
 */
export async function clusterContentItem(itemId: string): Promise<string | null> {
  try {
    const item = getLibraryItem(itemId);
    if (!item || item.intent !== 'content' || !item.track) return null;
    if (item.cluster_id) return item.cluster_id; // already clustered

    const cutoff = Math.floor(Date.now() / 1000) - RECENT_DAYS * 86_400;
    const candidates = listLibraryItems({ intent: 'content', track: item.track, limit: CANDIDATE_LIMIT })
      .items
      .filter((c) => c.id !== item.id && c.created_at >= cutoff && gist(c));
    if (candidates.length === 0) return null;

    const listing = candidates.map((c) => `${c.id}: ${gist(c)}`).join('\n');
    const prompt = [
      'Story-dedup check. Below is a NEW content item and a list of RECENT items. Decide if the new item covers the SAME UNDERLYING STORY (same event, same release, same investigation) as exactly one of the recent ones.',
      '',
      `NEW: ${gist(item)}`,
      '',
      `RECENT:\n${listing}`,
      '',
      'Rules: "same story" = a viewer would say these are about the same thing happening. Same TOPIC is NOT enough (two different AI model releases are different stories; two posts about the same school strike are one story). When unsure, NOT a match. Return ONLY: {"match": "<id or null>"}',
    ].join('\n');

    const res = await delegate('scribe', prompt, { shareMemory: false, maxTokens: 120 });
    const out = extractJson<{ match?: string | null }>(res.output);
    const matchId = typeof out?.match === 'string' && out.match !== 'null' ? out.match.trim() : null;
    if (!matchId) return null;

    const match = candidates.find((c) => c.id === matchId);
    if (!match) {
      log('matcher returned unknown id (ignored)', { item: itemId, matchId });
      return null;
    }

    // Anchor = the matched item's existing cluster, or the matched item itself.
    const clusterId = match.cluster_id ?? match.id;
    if (!match.cluster_id) updateLibraryItem(match.id, { cluster_id: clusterId });
    updateLibraryItem(item.id, { cluster_id: clusterId });
    log('clustered', { item: itemId, cluster: clusterId, with: match.id });
    return clusterId;
  } catch (err) {
    log('clustering failed (item stays singleton)', { item: itemId, err: String(err).slice(0, 150) });
    return null;
  }
}
