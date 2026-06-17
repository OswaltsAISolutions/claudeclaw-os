// Fact-checker for content briefs (Content Engine).
//
// Takes a draft's VERIFY-flagged claims and gets the research team to rule on
// each one BEFORE Gabe says it on camera. Per claim: targeted Brave searches
// are pre-fetched, then sleuth (Opus 4.7, bash+curl) reads the actual pages
// and returns a structured verdict with sources. One oracle (local,
// uncensored) pass then reviews the whole verdict set for censorship/framing
// gaps and may downgrade a verdict to "disputed" — it can never upgrade.
//
// The bar is deliberately conservative: "confirmed" must mean CONFIRMED.
// A primary source, or two independent reputable outlets actually read (not
// search snippets), or it stays unverified. False positives here are worse
// than false negatives: one confidently-stated wrong fact on camera costs
// more than ten over-cautious hedges.

import {
  getContentDraft,
  getLibraryItem,
  updateContentDraft,
  type ContentDraft,
  type LibraryItem,
} from './db.js';
import { braveSearch, normalizeUrl, type BraveResult } from './web-search.js';
import { delegate } from './specialists.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'fact-check', ...extra }, msg);

// ── Shapes ─────────────────────────────────────────────────────────────

export type Verdict = 'confirmed' | 'false' | 'unverified' | 'disputed';

export interface ClaimVerdict {
  index: number;             // position in the brief's key_facts array
  claim: string;
  verdict: Verdict;
  confidence: 'high' | 'medium' | 'low';
  summary: string;           // one line: what the evidence shows
  correction: string | null; // when verdict is 'false': what is actually true
  dispute_reason?: string;   // when oracle downgraded to 'disputed'
  sources: Array<{ url: string; what_it_shows: string }>;
}

export interface VerificationResult {
  claims: ClaimVerdict[];
  summary: { confirmed: number; false: number; unverified: number; disputed: number };
  checked_at: number;
  model: string;
}

interface BriefFact { fact: string; source?: string; needs_verification?: boolean }

// ── Per-claim verification (sleuth) ────────────────────────────────────

const CLAIM_CONCURRENCY = 2;
const PER_CLAIM_MAX_MS = 5 * 60 * 1000; // sleuth reads real pages; give it room, but never hang the run

function extractJson<T>(text: string): T | null {
  // Greedy first (single JSON object, the common case)...
  const greedy = text.match(/\{[\s\S]*\}/);
  if (greedy) { try { return JSON.parse(greedy[0]) as T; } catch { /* fall through */ } }
  // ...then brace-balanced candidates: an agentic sleuth run can echo braces
  // in prose/tool output around the verdict. Prefer the LAST parseable block
  // (the verdict comes at the end).
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { candidates.push(text.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try { return JSON.parse(candidates[k]) as T; } catch { /* try the next-earlier block */ }
  }
  return null;
}

async function searchClaim(claim: string): Promise<BraveResult[]> {
  const queries = [
    claim.split(/\s+/).slice(0, 15).join(' '),
    `${claim.split(/\s+/).slice(0, 10).join(' ')} official document source`,
  ];
  const pool = new Map<string, BraveResult>();
  for (const q of queries) {
    try {
      for (const r of await braveSearch(q, { count: 6 })) {
        const norm = normalizeUrl(r.url);
        if (!pool.has(norm)) pool.set(norm, { ...r, url: norm });
      }
    } catch (err) {
      log('claim search failed', { q: q.slice(0, 60), err: String(err).slice(0, 120) });
      if (String(err).includes('BRAVE_API_KEY')) throw err; // fails every query; abort the run honestly
    }
  }
  return [...pool.values()].slice(0, 8);
}

function sleuthPrompt(claim: string, context: string, results: BraveResult[]): string {
  const block = results.length
    ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description?.slice(0, 200) ?? ''}`).join('\n')
    : '(prefetch found nothing — run your own searches via the /api/web/search endpoint)';
  return [
    'FACT-CHECK ONE CLAIM. A content creator is about to state this on camera; your verdict decides whether he says it plainly, corrects it, or hedges it. Be rigorous and CONSERVATIVE.',
    '',
    `CLAIM: "${claim}"`,
    context ? `CONTEXT (the story it comes from): ${context}` : '',
    '',
    '[SEARCH RESULTS]',
    block,
    '',
    'METHOD (mandatory): curl and READ at least the 2 most promising pages before ruling — search snippets alone are NOT evidence. Run additional searches yourself if the prefetch missed (curl "http://127.0.0.1:3141/api/web/search?token=$DASHBOARD_TOKEN&q=<query>&count=8").',
    '',
    'VERDICT RUBRIC:',
    '- "confirmed": a PRIMARY source (official record, court/government document, direct footage or transcript, the person\'s own verifiable statement) supports it, OR 2+ INDEPENDENT reputable outlets you actually read support it. Social posts, blogs, and SEO content never confirm on their own.',
    '- "false": solid sourcing contradicts the claim. Provide the correction.',
    '- "unverified": evidence is thin, single-source, paywalled beyond reach, or conflicting without resolution. WHEN IN DOUBT, THIS IS YOUR ANSWER. Never stretch to confirmed.',
    '- Partial truth: if the core is true but a detail (number, date, rank) is off, verdict "false" with the correction, so he states the accurate version.',
    '',
    'Return ONLY this JSON (no prose before or after):',
    '{"verdict":"confirmed|false|unverified","confidence":"high|medium|low","summary":"one line: what the evidence shows","correction":"what is actually true (only when verdict is false, else null)","sources":[{"url":"only URLs you actually fetched or saw in results","what_it_shows":"one line"}]}',
  ].filter(Boolean).join('\n');
}

async function checkClaim(index: number, fact: BriefFact, context: string): Promise<ClaimVerdict> {
  const base: ClaimVerdict = {
    index, claim: fact.fact, verdict: 'unverified', confidence: 'low',
    summary: '', correction: null, sources: [],
  };
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await searchClaim(fact.fact);
    const prompt = sleuthPrompt(fact.fact, context, results);
    const res = await Promise.race([
      delegate('sleuth', prompt, { shareMemory: false, maxTokens: 1200 }),
      new Promise<never>((_, rej) => { raceTimer = setTimeout(() => rej(new Error('claim check timed out')), PER_CLAIM_MAX_MS); }),
    ]);
    const out = extractJson<{
      verdict?: string; confidence?: string; summary?: string; correction?: string | null;
      sources?: Array<{ url?: string; what_it_shows?: string }>;
    }>(res.output);
    if (!out) return { ...base, summary: 'checker returned no parseable verdict; treat as unverified' };

    const verdict: Verdict = out.verdict === 'confirmed' || out.verdict === 'false' ? out.verdict : 'unverified';
    return {
      ...base,
      verdict,
      confidence: out.confidence === 'high' || out.confidence === 'medium' ? out.confidence : 'low',
      summary: (out.summary ?? '').slice(0, 300),
      correction: verdict === 'false' && typeof out.correction === 'string' ? out.correction.slice(0, 300) : null,
      sources: Array.isArray(out.sources)
        ? out.sources
            .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
            .slice(0, 5)
            .map((s) => ({ url: s.url!, what_it_shows: (s.what_it_shows ?? '').slice(0, 200) }))
        : [],
    };
  } catch (err) {
    // A missing Brave key fails every claim identically — propagate so the
    // whole run lands 'failed' (retryable from the UI), not a fake 'done'.
    if (String(err).includes('BRAVE_API_KEY')) throw err;
    log('claim check failed', { index, err: String(err).slice(0, 200) });
    return { ...base, summary: `check failed (${String(err).slice(0, 120)}); treat as unverified` };
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
  }
}

// ── Censorship cross-check (oracle, local uncensored) ──────────────────

async function oraclePass(claims: ClaimVerdict[], context: string): Promise<void> {
  const listing = claims
    .map((c) => `${c.index}: [${c.verdict}/${c.confidence}] "${c.claim.slice(0, 160)}" — ${c.summary.slice(0, 120)} (sources: ${c.sources.map((s) => { try { return new URL(s.url).hostname; } catch { return s.url; } }).join(', ') || 'none'})`)
    .join('\n');
  const prompt = [
    'You are the uncensored cross-checker. Below are fact-check verdicts produced from mainstream web sources. Your ONLY job: flag verdicts that look unreliable because of narrative management — e.g. a "false"/"unverified" that rests purely on official denials, or a "confirmed" that rests on one narrative repeated by outlets citing each other (not independent).',
    context ? `Story context: ${context}` : '',
    '',
    'VERDICTS:',
    listing,
    '',
    'Rules: you may ONLY move confirmed->disputed or unverified->disputed, with a one-line concrete reason. You cannot create "confirmed". No flags is a normal answer. Return ONLY: {"overrides":[{"index":0,"reason":"..."}]}',
  ].filter(Boolean).join('\n');

  try {
    const res = await delegate('oracle', prompt, { shareMemory: false, maxTokens: 600 });
    const out = extractJson<{ overrides?: Array<{ index?: number; reason?: string }> }>(res.output);
    for (const o of out?.overrides ?? []) {
      const target = claims.find((c) => c.index === o.index);
      if (!target || typeof o.reason !== 'string' || !o.reason.trim()) continue;
      if (target.verdict === 'confirmed' || target.verdict === 'unverified') {
        target.verdict = 'disputed';
        target.dispute_reason = o.reason.slice(0, 250);
      }
    }
  } catch (err) {
    // Oracle is an extra lens, not a gate: log and keep sleuth's verdicts.
    log('oracle pass failed (keeping sleuth verdicts)', { err: String(err).slice(0, 150) });
  }
}

// ── Label mode (faceless lane: inform, NEVER block) ─────────────────────
// Gabe's rule: unverified claims CAN ship on the faceless channel — that is
// the point of independent media. This mode extracts the load-bearing claims
// from a script and verdicts each one so he KNOWS what is documented vs
// alleged when he reads it. No gate, no rejection, just labels.

export async function labelText(text: string, context = ''): Promise<ClaimVerdict[]> {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const extractPrompt = [
    'List the load-bearing FACTUAL claims in this script — statements that are checkable against sources (events, numbers, named actions, attributions). Skip opinions, questions, and framing.',
    context ? `Context: ${context}` : '',
    '',
    `SCRIPT:\n${cleaned.slice(0, 6000)}`,
    '',
    'Answer with a single JSON object and nothing after it. It must have exactly one key: claims, an array of strings (max 8, each a self-contained claim).',
  ].filter(Boolean).join('\n');

  let claims: string[] = [];
  try {
    const res = await delegate('scribe', extractPrompt, { shareMemory: false, maxTokens: 700 });
    const out = extractJson<{ claims?: unknown[] }>(res.output);
    claims = Array.isArray(out?.claims)
      ? out!.claims!.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).slice(0, 8)
      : [];
  } catch (err) {
    log('label extraction failed', { err: String(err).slice(0, 150) });
    return [];
  }
  if (claims.length === 0) return [];

  const verdicts: ClaimVerdict[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CLAIM_CONCURRENCY, claims.length) }, async () => {
      while (cursor < claims.length) {
        const i = cursor++;
        verdicts.push(await checkClaim(i, { fact: claims[i], needs_verification: true }, context));
      }
    }),
  );
  verdicts.sort((a, b) => a.index - b.index);
  log('labeling done', { claims: claims.length });
  return verdicts;
}

// ── Orchestrator ───────────────────────────────────────────────────────

let notifier: ((draft: ContentDraft, item: LibraryItem | null, result: VerificationResult) => void) | null = null;
export function setVerifyNotifier(fn: (draft: ContentDraft, item: LibraryItem | null, result: VerificationResult) => void): void {
  notifier = fn;
}

const inFlight = new Set<string>();

/**
 * Verify a draft's flagged claims. Long-running (minutes): callers should
 * fire-and-forget and watch verification_status. Always lands on 'done' or
 * 'failed' — never leaves 'running' behind (boot recovery covers crashes).
 */
export async function verifyDraft(draftId: string): Promise<void> {
  if (inFlight.has(draftId)) return;
  const draft = getContentDraft(draftId);
  if (!draft || !draft.brief) return;

  let facts: BriefFact[] = [];
  let context = '';
  try {
    const brief = JSON.parse(draft.brief) as { angle?: string; key_facts?: BriefFact[] };
    facts = Array.isArray(brief.key_facts) ? brief.key_facts : [];
    context = brief.angle ?? '';
  } catch { /* unreadable brief -> no flagged claims */ }

  const flagged = facts
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => f && f.needs_verification && typeof f.fact === 'string');

  if (flagged.length === 0) {
    updateContentDraft(draftId, {
      verification_status: 'done',
      verification: JSON.stringify({ claims: [], summary: { confirmed: 0, false: 0, unverified: 0, disputed: 0 }, checked_at: Math.floor(Date.now() / 1000), model: 'none-needed' } satisfies VerificationResult),
    });
    return;
  }

  inFlight.add(draftId);
  updateContentDraft(draftId, { verification_status: 'running' });
  log('verification started', { draft: draftId, claims: flagged.length });

  try {
    // Small worker pool: claims are independent, sleuth runs are slow.
    const verdicts: ClaimVerdict[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CLAIM_CONCURRENCY, flagged.length) }, async () => {
        while (cursor < flagged.length) {
          const mine = flagged[cursor++];
          verdicts.push(await checkClaim(mine.index, mine.f, context));
        }
      }),
    );
    verdicts.sort((a, b) => a.index - b.index);

    await oraclePass(verdicts, context);

    const result: VerificationResult = {
      claims: verdicts,
      summary: {
        confirmed: verdicts.filter((c) => c.verdict === 'confirmed').length,
        false: verdicts.filter((c) => c.verdict === 'false').length,
        unverified: verdicts.filter((c) => c.verdict === 'unverified').length,
        disputed: verdicts.filter((c) => c.verdict === 'disputed').length,
      },
      checked_at: Math.floor(Date.now() / 1000),
      model: 'sleuth+oracle',
    };

    updateContentDraft(draftId, { verification: JSON.stringify(result), verification_status: 'done' });
    log('verification done', { draft: draftId, ...result.summary });

    const fresh = getContentDraft(draftId);
    if (fresh) {
      try { notifier?.(fresh, getLibraryItem(fresh.item_id), result); }
      catch (err) { log('verify notifier failed', { err: String(err).slice(0, 150) }); }
    }
  } catch (err) {
    updateContentDraft(draftId, { verification_status: 'failed' });
    log('verification failed', { draft: draftId, err: String(err).slice(0, 200) });
  } finally {
    inFlight.delete(draftId);
  }
}
