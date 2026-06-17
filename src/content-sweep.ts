// Content Engine P4: live-event monitoring.
//
// Twice a day (and on demand from the Studio) this sweeps the live web for
// events worth a video in each of Gabe's two lanes, judges them against the
// Creator Brief, and lands the winners directly in the Studio as ready,
// draftable opportunities (library_items with source='sweep'). The library
// stays his saves; the Studio shows saves + live events ranked together.
//
// Pipeline per track: Brave news/web searches (past-day freshness) -> URL
// dedup against everything already stored -> ONE judge call (cloud prism,
// uncensored oracle fallback for lane material that trips guardrails) ->
// insert up to 3 picks -> Telegram summary via the registered notifier.

import crypto from 'crypto';

import {
  createSweepLibraryItem,
  getLibraryItem,
  getLibraryItemByUrl,
  listLibraryItems,
  type LibraryItem,
} from './db.js';
import { braveSearch as braveSearchShared, normalizeUrl, domainOf, type BraveResult } from './web-search.js';
import { delegate } from './specialists.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'content-sweep', ...extra }, msg);

// ── Lane definitions ───────────────────────────────────────────────────

const TRACKS: Record<'ai' | 'real_world', {
  platforms: string[];
  queries: string[];
  judgeBrief: string;
}> = {
  ai: {
    platforms: ['tiktok', 'youtube'],
    queries: [
      'AI agents breakthrough announcement',
      'open source LLM model release',
      'Anthropic Claude OpenAI new release',
      'AI automation small business success',
      'AI tools beginners viral',
      'local AI home server hardware',
    ],
    judgeBrief: 'LANE: AI empowerment for regular people (TikTok hook-first + YouTube in-depth). Thesis: AI is the future and EVERY person can benefit by building their own AI system. Audience: people whose AI knowledge stops at ChatGPT, plus small businesses wanting to implement AI. GOOD picks: new capabilities normal people can actually use, free/cheap tools, agentic-AI milestones he can demo or react to, make-your-computer-work-for-you stories, business-implementation wins. BAD picks: inside-baseball research papers, enterprise vendor noise, AI doom, stock-pump headlines.',
  },
  real_world: {
    platforms: ['instagram', 'x'],
    queries: [
      'government corruption investigation exposed',
      'lobbying money influence congress investigation',
      'war conflict escalation breaking',
      'declassified documents revealed',
      'whistleblower testimony government',
      'geopolitics power shift major',
    ],
    judgeBrief: 'LANE: real-world truth-telling (Instagram + X, suit-and-tie single-narrator monologue). Lane: world events + real-time geopolitics, governments, wars, following the money, lobbying, corruption, real un-sanitized history, morality. Independent, NOT partisan. GOOD picks: stories with receipts (documents, testimony, money trails) where the mainstream framing hides the interesting part, live events still forming where an honest breakdown lands early. BAD picks: pure partisan food-fights, celebrity noise, single-source rumors with no documents, stories with no moral so-what.',
  },
};

const MAX_PICKS_PER_TRACK = 3;
const MIN_SCORE = 50;
const PER_QUERY_RESULTS = 5;

// ── Brave search (shared client; past-day freshness because this sweep is LIVE) ──

function braveSearch(q: string): Promise<BraveResult[]> {
  return braveSearchShared(q, { count: PER_QUERY_RESULTS, freshness: 'pd' });
}

// ── Judge ──────────────────────────────────────────────────────────────

interface JudgePick { url: string; title: string; score: number; angle: string; why_now: string }

function extractJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

async function judgeTrack(
  track: 'ai' | 'real_world',
  candidates: BraveResult[],
  recentTitles: string[],
): Promise<JudgePick[]> {
  const lane = TRACKS[track];
  const list = candidates
    .map((r, i) => `${i + 1}. ${r.title}\n   url: ${r.url}\n   ${r.description?.slice(0, 220) ?? ''}${r.age ? `\n   age: ${r.age}` : ''}`)
    .join('\n');

  const prompt = [
    'You are the live-event scout for a content creator (Gabe, GCruise). From the headlines below, pick ONLY the ones genuinely worth one of his videos. Most days that is 0-3 picks; an empty pick list is a perfectly good answer. Return STRICT JSON only.',
    '',
    lane.judgeBrief,
    '',
    recentTitles.length ? `ALREADY COVERED RECENTLY (skip these stories even from other outlets):\n${recentTitles.map((t) => `- ${t}`).join('\n')}` : '',
    '',
    `CANDIDATES (live search results from the past day):\n${list}`,
    '',
    `Rules: max ${MAX_PICKS_PER_TRACK} picks. score = strength as a content opportunity 0-100 (fit-to-lane + substance + timeliness + uniqueness); do not pick anything under ${MIN_SCORE}. angle = the one-line take HIS video makes (not a summary of the headline). One pick per underlying story.`,
    '',
    'Return ONLY: {"picks":[{"url":"...","title":"...","score":0,"angle":"...","why_now":"..."}]}',
  ].filter(Boolean).join('\n');

  const tryModel = async (callsign: 'prism' | 'oracle') => {
    const res = await delegate(callsign, prompt, { shareMemory: false, maxTokens: 1000 });
    return extractJson<{ picks?: JudgePick[] }>(res.output);
  };

  let out: { picks?: JudgePick[] } | null = null;
  try { out = await tryModel('prism'); } catch (err) {
    log('prism judge failed', { track, err: String(err).slice(0, 200) });
  }
  if (!out || !Array.isArray(out.picks)) {
    // Lane material (war, corruption) can trip cloud guardrails -> local uncensored.
    try { out = await tryModel('oracle'); } catch (err) {
      log('oracle judge failed', { track, err: String(err).slice(0, 200) });
    }
  }

  return (out?.picks ?? [])
    .filter((p) => p && typeof p.url === 'string' && typeof p.title === 'string')
    .map((p) => ({ ...p, score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))) }))
    .filter((p) => p.score >= MIN_SCORE)
    .slice(0, MAX_PICKS_PER_TRACK);
}

// ── Sweep ──────────────────────────────────────────────────────────────

export interface SweepSummary {
  ok: boolean;
  trigger: 'manual' | 'scheduled';
  searched: number;
  candidates: number;
  added: Array<{ id: string; track: string; score: number; angle: string | null; title: string }>;
  skippedDuplicates: number;
  errors: string[];
}

let notifier: ((summary: SweepSummary, items: LibraryItem[]) => void) | null = null;
export function setSweepNotifier(fn: (summary: SweepSummary, items: LibraryItem[]) => void): void {
  notifier = fn;
}

let inFlight = false;

export async function runContentSweep(trigger: 'manual' | 'scheduled'): Promise<SweepSummary> {
  if (inFlight) return { ok: false, trigger, searched: 0, candidates: 0, added: [], skippedDuplicates: 0, errors: ['a sweep is already running'] };
  inFlight = true;
  const summary: SweepSummary = { ok: true, trigger, searched: 0, candidates: 0, added: [], skippedDuplicates: 0, errors: [] };
  const addedItems: LibraryItem[] = [];

  try {
    // Titles of recent sweep finds, fed to the judge for cross-outlet dedup.
    const recent = listLibraryItems({ platform: 'web', limit: 40 }).items
      .map((i) => (i.caption ?? '').split('\n')[0])
      .filter(Boolean);

    for (const track of ['ai', 'real_world'] as const) {
      const lane = TRACKS[track];
      const pool = new Map<string, BraveResult>();

      for (const q of lane.queries) {
        try {
          const results = await braveSearch(q);
          summary.searched++;
          for (const r of results) {
            const norm = normalizeUrl(r.url);
            if (!pool.has(norm)) pool.set(norm, { ...r, url: norm });
          }
        } catch (err) {
          summary.errors.push(`search "${q}": ${String(err).slice(0, 120)}`);
          // A missing key fails every query identically; bail out of the lane.
          if (String(err).includes('BRAVE_API_KEY')) break;
        }
      }

      // Drop anything already in the library (saves or earlier sweeps).
      const fresh: BraveResult[] = [];
      for (const r of pool.values()) {
        if (getLibraryItemByUrl(r.url)) summary.skippedDuplicates++;
        else fresh.push(r);
      }
      summary.candidates += fresh.length;
      if (fresh.length === 0) continue;

      const picks = await judgeTrack(track, fresh, recent);
      for (const pick of picks) {
        const norm = normalizeUrl(pick.url);
        if (getLibraryItemByUrl(norm)) { summary.skippedDuplicates++; continue; }
        const src = fresh.find((r) => r.url === norm);
        const id = crypto.randomBytes(4).toString('hex');
        createSweepLibraryItem(id, norm, {
          caption: `${pick.title}\n\n${src?.description ?? ''}`.trim(),
          authorName: domainOf(norm),
          track,
          platforms: lane.platforms,
          contentScore: pick.score,
          contentAngle: pick.angle?.slice(0, 280) ?? null,
          analysis: { hook_summary: pick.why_now ?? null, model_used: 'sweep', sweep_trigger: trigger },
          tags: ['live-event'],
        });
        const item = getLibraryItem(id);
        if (item) addedItems.push(item);
        summary.added.push({ id, track, score: pick.score, angle: pick.angle ?? null, title: pick.title });
        // Also seed cross-track dedup within this same run.
        recent.push(pick.title);
        // Story clustering: a sweep hit on an already-saved story merges into
        // its card. Fire-and-forget; clustering failure leaves a singleton.
        const { clusterContentItem } = await import('./content-cluster.js');
        void clusterContentItem(id);
      }
    }
  } catch (err) {
    summary.ok = false;
    summary.errors.push(String(err).slice(0, 200));
  } finally {
    inFlight = false;
  }

  log('sweep done', { trigger, searched: summary.searched, candidates: summary.candidates, added: summary.added.length, dupes: summary.skippedDuplicates, errors: summary.errors.length });
  try { notifier?.(summary, addedItems); } catch (err) {
    log('sweep notifier failed', { err: String(err).slice(0, 150) });
  }
  return summary;
}

// ── Schedule (8:00 + 18:00 local, same setTimeout-chain pattern as x-sync) ──

const timers = new Map<number, ReturnType<typeof setTimeout>>();

function msUntil(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startContentSweep(): void {
  if (timers.size) return;
  ([[8, 0], [18, 0]] as const).forEach(([hour, minute], slot) => {
    const schedule = () => {
      timers.set(slot, setTimeout(async () => {
        try { await runContentSweep('scheduled'); }
        catch (err) { logger.warn({ scope: 'content-sweep', err: String(err) }, 'scheduled sweep failed'); }
        schedule();
      }, msUntil(hour, minute)));
    };
    schedule();
  });
  log('live-event sweeps scheduled (8:00 + 18:00 local)');
}

export function stopContentSweep(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
