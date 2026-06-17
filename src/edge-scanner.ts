// Edge Scanner: read-only prediction-market dislocation measurement.
//
// Purpose (2026-06-10 money-systems research): before ANY capital decision,
// measure empirically whether post-fee edges still exist at retail timescales.
// Kalshi is the only venue legally tradable from Ohio; Polymarket is scanned
// strictly as a free public-data fair-value feed (no auth, no orders, ever).
//
// What it measures, every SCAN_MS:
//   - negrisk_yes / negrisk_no: Polymarket multi-outcome (negRisk) events where
//     sum(YES asks) < 1 (buy-all-YES) or sum(YES bids) > 1 (buy-all-NO).
//   - xvenue: confirmed Kalshi<->Polymarket pairs where Kalshi is mispriced vs
//     the Polymarket mid (the only leg Gabe could legally execute).
//   - kalshi_intra: YES ask + NO ask < $1 on one Kalshi market.
//   - kalshi_spread: wide Kalshi spreads = maker opportunity candidates.
//
// Lifecycle: opportunities open on first sight, refresh while they persist,
// close when they vanish. first_seen->closed_at IS the duration dataset that
// answers "is this edge real at home-server latency, or seconds-scale bot food".
//
// Honesty rules (per Gabe's no-mock-data standing rule):
//   - depth_usd is null in v1 (we do not fetch order books; depth unknown).
//   - net_edge uses a documented, conservative fee model (see kalshiTakerFee /
//     polyFeeModel below); assumptions are carried in detail JSON.
//   - Sports/Esports are excluded everywhere: untradeable from Ohio (OCCC
//     enforcement) and pure noise for this dataset.

import { delegate } from './specialists.js';
import { runPaperPass, type PaperSignal } from './edge-paper.js';
import {
  closeVanishedEdgeOpportunities,
  createEdgeOpportunity,
  edgeSummaryCounts,
  getOpenEdgeOpportunity,
  lastEdgeAlertTs,
  listEdgePairs,
  markEdgeOpportunityAlerted,
  touchEdgeOpportunity,
  updateEdgePair,
  upsertEdgePair,
  upsertEdgeStats,
  type EdgeOpportunity,
  type EdgePair,
} from './db.js';
import { logger } from './logger.js';

const log = (msg: string) => logger.info({ scope: 'edge' }, msg);
const logErr = (msg: string) => logger.error({ scope: 'edge' }, msg);

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

const SCAN_MS = 5 * 60 * 1000;          // full sweep cadence
const MATCH_EVERY_N_SCANS = 6;          // pair-matching pass ~every 30 min
const FETCH_GAP_MS = 250;               // politeness gap between paginated calls
const KALSHI_MAX_PAGES = 30;            // 30 x 200 = up to 6,000 open events
const POLY_MAX_PAGES = 5;               // top 500 events by 24h volume

// Detection thresholds (per-$1 contract/set, after fees unless noted)
const NEGRISK_MIN_NET = 0.005;
const XVENUE_MIN_NET = 0.02;
const SPREAD_MIN_WIDTH = 0.08;          // gross quoted spread to count as maker candidate
const SPREAD_MIN_NET = 0.025;
const SPREAD_MIN_LIQUIDITY = 500;       // $ liquidity floor for spread candidates
const ALERT_MIN_NET = 0.03;             // Telegram alert bar
const ALERT_COOLDOWN_S = 30 * 60;

// Pair-matching knobs
const MATCH_MIN_JACCARD = 0.5;
const MATCH_MAX_END_DIFF_DAYS = 5;
const MATCH_LLM_BATCH = 15;
const MATCH_LLM_MAX_BATCHES = 2;        // per matching pass, keeps scribe load bounded

const SPORTS_RE = /sport|esport|nba|nfl|mlb|nhl|ncaa|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|f1|nascar|olympic/i;

// ── Types for the slices of venue API responses we consume ────────────────

interface KalshiMarket {
  ticker: string;
  title: string;
  yesSub: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  closeTime: string | null;
  liquidityDollars: number | null;
  category: string;
  eventTitle: string;
}

interface PolyMarket {
  conditionId: string;
  question: string;
  bestBid: number | null;
  bestAsk: number | null;
  endDate: string | null;
  acceptingOrders: boolean;
  feesEnabled: boolean;
}

interface PolyEvent {
  slug: string;
  title: string;
  negRisk: boolean;
  sports: boolean;
  endDate: string | null;
  markets: PolyMarket[];
}

interface ScanState {
  running: boolean;
  scanCount: number;
  lastScanAt: number | null;
  lastScanMs: number | null;
  lastMatchAt: number | null;
  kalshiMarkets: number;
  polyEvents: number;
  partialKalshiSweep: boolean;
  lastError: string | null;
  errorCount: number;
}

const state: ScanState = {
  running: false,
  scanCount: 0,
  lastScanAt: null,
  lastScanMs: null,
  lastMatchAt: null,
  kalshiMarkets: 0,
  polyEvents: 0,
  partialKalshiSweep: false,
  lastError: null,
  errorCount: 0,
};

let timer: ReturnType<typeof setTimeout> | null = null;
let scanInFlight: Promise<void> | null = null;

// bot.ts registers a notifier for Telegram alerts (same decoupling pattern
// as library-worker's setLibraryNotifier; avoids a circular import).
export type EdgeNotifier = (opp: EdgeOpportunity, meta: { isNew: boolean }) => void;
let notifier: EdgeNotifier | null = null;
export function setEdgeNotifier(fn: EdgeNotifier): void {
  notifier = fn;
}

export function getEdgeScannerState(): ScanState {
  return { ...state };
}

// ── Fee models (documented assumptions, carried into detail JSON) ──────────

/** Kalshi taker fee per contract, rounded up to the cent: ceil(0.07*p*(1-p)*100)/100. */
function kalshiTakerFee(p: number): number {
  return Math.ceil(7 * p * (1 - p)) / 100;
}

/** Kalshi maker fee model (~0.0175*p*(1-p)); some series are maker-free, so
 *  this is conservative (overstates cost). */
function kalshiMakerFee(p: number): number {
  return 0.0175 * p * (1 - p);
}

/** Polymarket (intl) taker fee model where feesEnabled: probability-weighted
 *  curve peaking ~1.8% at 50c (crypto rate, the worst case) = 0.072*p*(1-p).
 *  Markets with feesEnabled=false (most politics/geopolitics) cost 0. */
function polyFeeModel(p: number, feesEnabled: boolean): number {
  return feesEnabled ? 0.072 * p * (1 - p) : 0;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'claudeclaw-edge-scanner/1.0 (read-only research)' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// ── Venue sweeps ────────────────────────────────────────────────────────────

async function sweepKalshi(): Promise<{ markets: KalshiMarket[]; partial: boolean }> {
  const out: KalshiMarket[] = [];
  let cursor = '';
  for (let page = 0; page < KALSHI_MAX_PAGES; page++) {
    const url = `${KALSHI_BASE}/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await fetchJson(url) as {
      events?: Array<Record<string, unknown>>;
      cursor?: string;
    };
    const events = data.events ?? [];
    for (const ev of events) {
      const category = String(ev.category ?? '');
      const eventTitle = String(ev.title ?? '');
      // Sports are untradeable from Ohio and drown the dataset; skip whole event.
      if (SPORTS_RE.test(category) || SPORTS_RE.test(String(ev.series_ticker ?? ''))) continue;
      const markets = (ev.markets ?? []) as Array<Record<string, unknown>>;
      for (const m of markets) {
        if (m.market_type !== 'binary' || m.status !== 'active') continue;
        if (m.mve_collection_ticker) continue; // multi-leg parlay junk
        const yesAsk = num(m.yes_ask_dollars);
        const yesBid = num(m.yes_bid_dollars);
        if (yesAsk === null && yesBid === null) continue;
        out.push({
          ticker: String(m.ticker ?? ''),
          title: String(m.title ?? eventTitle),
          yesSub: m.yes_sub_title ? String(m.yes_sub_title) : null,
          yesBid,
          yesAsk,
          noBid: num(m.no_bid_dollars),
          noAsk: num(m.no_ask_dollars),
          closeTime: m.close_time ? String(m.close_time) : null,
          liquidityDollars: num(m.liquidity_dollars),
          category,
          eventTitle,
        });
      }
    }
    cursor = data.cursor ?? '';
    if (!cursor || events.length === 0) break;
    await sleep(FETCH_GAP_MS);
  }
  // A non-empty cursor after the page cap means open events we never saw:
  // the sweep is PARTIAL and absence-of-market must not be treated as
  // market-closed downstream (lifecycle closes, paper settlement).
  return { markets: out, partial: cursor !== '' };
}

async function sweepPolymarket(): Promise<PolyEvent[]> {
  const out: PolyEvent[] = [];
  for (let page = 0; page < POLY_MAX_PAGES; page++) {
    const url = `${GAMMA_BASE}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100&offset=${page * 100}`;
    const data = await fetchJson(url) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length === 0) break;
    for (const ev of data) {
      const tags = (ev.tags ?? []) as Array<Record<string, unknown>>;
      const sports = tags.some((t) => SPORTS_RE.test(String(t.slug ?? '') + ' ' + String(t.label ?? '')))
        || SPORTS_RE.test(String(ev.title ?? ''));
      const markets = ((ev.markets ?? []) as Array<Record<string, unknown>>).map((m): PolyMarket => ({
        conditionId: String(m.conditionId ?? ''),
        question: String(m.question ?? ''),
        bestBid: num(m.bestBid),
        bestAsk: num(m.bestAsk),
        endDate: m.endDate ? String(m.endDate) : null,
        acceptingOrders: m.acceptingOrders !== false,
        feesEnabled: m.feesEnabled === true,
      }));
      out.push({
        slug: String(ev.slug ?? ''),
        title: String(ev.title ?? ''),
        negRisk: ev.negRisk === true,
        sports,
        endDate: ev.endDate ? String(ev.endDate) : null,
        markets,
      });
    }
    await sleep(FETCH_GAP_MS);
  }
  return out;
}

// ── Detection passes ────────────────────────────────────────────────────────

interface Finding {
  kind: string;
  ref: string;
  title: string;
  venue: string;
  category: string | null;
  detail: Record<string, unknown>;
  grossEdge: number;
  netEdge: number;
  depthUsd: number | null;
}

function detectNegRisk(events: PolyEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const ev of events) {
    if (!ev.negRisk || ev.sports || ev.markets.length < 2) continue;
    const legs = ev.markets.filter((m) => m.acceptingOrders);
    if (legs.length !== ev.markets.length) continue; // partial set = wrong math
    if (legs.some((m) => m.bestBid === null || m.bestAsk === null)) continue;

    const sumAsk = legs.reduce((s, m) => s + (m.bestAsk as number), 0);
    const sumBid = legs.reduce((s, m) => s + (m.bestBid as number), 0);
    const anyFees = legs.some((m) => m.feesEnabled);

    const legSummary = legs
      .slice()
      .sort((a, b) => (b.bestAsk ?? 0) - (a.bestAsk ?? 0))
      .slice(0, 12)
      .map((m) => ({ q: m.question.slice(0, 80), bid: m.bestBid, ask: m.bestAsk }));

    // Buy-all-YES: pay sum(asks), exactly one leg pays $1.
    const grossYes = 1 - sumAsk;
    const feeYes = legs.reduce((s, m) => s + polyFeeModel(m.bestAsk as number, m.feesEnabled), 0);
    const netYes = grossYes - feeYes;
    if (netYes >= NEGRISK_MIN_NET) {
      findings.push({
        kind: 'negrisk_yes', ref: ev.slug, title: ev.title, venue: 'polymarket',
        category: anyFees ? 'fees-enabled' : 'fee-free',
        detail: { n: legs.length, sumYesAsk: sumAsk, feeModel: feeYes, legs: legSummary, note: 'buy-all-YES; depth unknown (no book fetch in v1)' },
        grossEdge: grossYes, netEdge: netYes, depthUsd: null,
      });
    }

    // Buy-all-NO: NO ask ~= 1 - YES bid per leg; cost sum(1-bid) = N - sumBid,
    // payout N-1 -> gross = sumBid - 1.
    const grossNo = sumBid - 1;
    const feeNo = legs.reduce((s, m) => s + polyFeeModel(1 - (m.bestBid as number), m.feesEnabled), 0);
    const netNo = grossNo - feeNo;
    if (netNo >= NEGRISK_MIN_NET) {
      findings.push({
        kind: 'negrisk_no', ref: ev.slug, title: ev.title, venue: 'polymarket',
        category: anyFees ? 'fees-enabled' : 'fee-free',
        detail: { n: legs.length, sumYesBid: sumBid, feeModel: feeNo, legs: legSummary, note: 'buy-all-NO via 1-bid; depth unknown (no book fetch in v1)' },
        grossEdge: grossNo, netEdge: netNo, depthUsd: null,
      });
    }
  }
  return findings;
}

function detectKalshiIntra(markets: KalshiMarket[]): Finding[] {
  const findings: Finding[] = [];
  for (const m of markets) {
    if (m.yesAsk === null || m.noAsk === null || m.yesAsk <= 0 || m.noAsk <= 0) continue;
    const sum = m.yesAsk + m.noAsk;
    if (sum >= 1) continue;
    const gross = 1 - sum;
    const net = gross - kalshiTakerFee(m.yesAsk) - kalshiTakerFee(m.noAsk);
    if (net <= 0) continue;
    findings.push({
      kind: 'kalshi_intra', ref: m.ticker, title: m.title, venue: 'kalshi', category: m.category,
      detail: { yesAsk: m.yesAsk, noAsk: m.noAsk, liquidityDollars: m.liquidityDollars, note: 'YES+NO taker arb, both legs fee-modeled' },
      grossEdge: gross, netEdge: net, depthUsd: null,
    });
  }
  return findings;
}

function detectKalshiSpread(markets: KalshiMarket[]): Finding[] {
  const findings: Finding[] = [];
  for (const m of markets) {
    if (m.yesAsk === null || m.yesBid === null || m.yesAsk <= 0 || m.yesBid <= 0) continue;
    if ((m.liquidityDollars ?? 0) < SPREAD_MIN_LIQUIDITY) continue;
    const spread = m.yesAsk - m.yesBid;
    if (spread < SPREAD_MIN_WIDTH) continue;
    const mid = (m.yesAsk + m.yesBid) / 2;
    if (mid < 0.05 || mid > 0.95) continue; // longshot tails: spread is noise there
    const net = spread / 2 - kalshiMakerFee(mid);
    if (net < SPREAD_MIN_NET) continue;
    findings.push({
      kind: 'kalshi_spread', ref: m.ticker, title: m.title, venue: 'kalshi', category: m.category,
      detail: { yesBid: m.yesBid, yesAsk: m.yesAsk, mid, liquidityDollars: m.liquidityDollars, note: 'maker candidate: half-spread minus maker-fee model; adverse selection NOT modeled' },
      grossEdge: spread, netEdge: net, depthUsd: null,
    });
  }
  // Keep the dataset focused: top 40 by net edge per scan.
  return findings.sort((a, b) => b.netEdge - a.netEdge).slice(0, 40);
}

function detectXVenue(
  pairs: EdgePair[],
  kalshiByTicker: Map<string, KalshiMarket>,
  polyByCondition: Map<string, PolyMarket>,
): Finding[] {
  const findings: Finding[] = [];
  for (const pair of pairs) {
    const k = kalshiByTicker.get(pair.kalshi_ticker);
    const p = polyByCondition.get(pair.poly_condition_id);
    if (!k || !p || p.bestBid === null || p.bestAsk === null) continue;
    if (k.yesAsk === null || k.yesBid === null) continue;
    // The poly mid is only a trustworthy fair value on a real book. An empty
    // or near-empty book quotes ~0/~1 and mids to 0.5, which manufactured a
    // fake $2,400 "edge" on first deploy (Candace Owens market). Require a
    // tight spread and a non-degenerate mid before using it as a thesis.
    if (p.bestAsk - p.bestBid > 0.10) continue;
    let polyMid = (p.bestBid + p.bestAsk) / 2;
    if (pair.invert) polyMid = 1 - polyMid;
    if (polyMid < 0.02 || polyMid > 0.98) continue;

    // Only the Kalshi leg is executable from Ohio: measure Kalshi vs poly fair value.
    const buyEdge = polyMid - k.yesAsk - kalshiTakerFee(k.yesAsk);   // Kalshi cheap -> buy YES
    const sellEdge = k.yesBid - polyMid - kalshiTakerFee(k.yesBid);  // Kalshi rich  -> buy NO / sell YES
    const net = Math.max(buyEdge, sellEdge);
    if (net < XVENUE_MIN_NET) continue;
    const direction = buyEdge >= sellEdge ? 'kalshi_cheap_buy_yes' : 'kalshi_rich_buy_no';
    findings.push({
      kind: 'xvenue', ref: pair.id, title: `${k.title}${k.yesSub ? ` (${k.yesSub})` : ''}`, venue: 'cross', category: k.category,
      detail: {
        direction, polyMid, polyBid: p.bestBid, polyAsk: p.bestAsk, invert: pair.invert === 1,
        kalshiYesBid: k.yesBid, kalshiYesAsk: k.yesAsk, kalshiTicker: k.ticker,
        polyQuestion: p.question, llmConfidence: pair.llm_confidence,
        note: 'signal edge vs poly mid, Kalshi taker fee modeled; resolution-rule mismatch NOT verified',
      },
      grossEdge: net + kalshiTakerFee(direction === 'kalshi_cheap_buy_yes' ? k.yesAsk : k.yesBid),
      netEdge: net, depthUsd: null,
    });
  }
  return findings;
}

// ── Pair matching (heuristic + scribe confirmation) ─────────────────────────

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'in', 'on', 'by', 'of', 'to', 'at', 'vs', 'for',
  'be', 'before', 'after', 'or', 'and', 'is', 'as', 'this', 'that', 'what',
  'who', 'when', 'how', 'many', 'much', 'market', 'than', 'more', 'less',
]);

function titleTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s.%$-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / 86_400_000;
}

function findPairCandidates(kalshi: KalshiMarket[], polyEvents: PolyEvent[]): number {
  // Pre-tokenize poly side once (top-volume binary markets only).
  const polySide: Array<{ m: PolyMarket; ev: PolyEvent; tokens: Set<string> }> = [];
  for (const ev of polyEvents) {
    if (ev.sports) continue;
    for (const m of ev.markets) {
      if (!m.acceptingOrders || m.bestBid === null) continue;
      polySide.push({ m, ev, tokens: titleTokens(`${ev.title} ${m.question}`) });
    }
  }
  let created = 0;
  for (const k of kalshi) {
    const kTokens = titleTokens(`${k.eventTitle} ${k.title} ${k.yesSub ?? ''}`);
    if (kTokens.size < 2) continue;
    let best: { score: number; p: { m: PolyMarket; ev: PolyEvent } } | null = null;
    for (const p of polySide) {
      const score = jaccard(kTokens, p.tokens);
      if (score < MATCH_MIN_JACCARD) continue;
      const dd = daysBetween(k.closeTime, p.m.endDate ?? p.ev.endDate);
      if (dd !== null && dd > MATCH_MAX_END_DIFF_DAYS) continue;
      if (!best || score > best.score) best = { score, p };
    }
    if (best) {
      upsertEdgePair({
        kalshiTicker: k.ticker,
        kalshiTitle: `${k.title}${k.yesSub ? ` (${k.yesSub})` : ''}`,
        polyConditionId: best.p.m.conditionId,
        polyQuestion: best.p.m.question,
        polyEventSlug: best.p.ev.slug,
        category: k.category,
        endDate: k.closeTime,
        matchScore: best.score,
      });
      created++;
    }
  }
  return created;
}

/** LLM-confirm pending candidates in small batches via scribe. Strict JSON
 *  contract; on any parse failure the candidates simply stay candidates. */
async function confirmCandidatesWithLLM(): Promise<void> {
  const pending = listEdgePairs({ status: 'candidate', limit: MATCH_LLM_BATCH * MATCH_LLM_MAX_BATCHES })
    .filter((p) => p.llm_confidence === null);
  if (!pending.length) return;

  for (let i = 0; i < pending.length; i += MATCH_LLM_BATCH) {
    const batch = pending.slice(i, i + MATCH_LLM_BATCH);
    const lines = batch.map((p, idx) =>
      `${idx + 1}. A: "${(p.kalshi_title ?? p.kalshi_ticker).slice(0, 140)}" (closes ${p.end_date ?? 'unknown'}) | B: "${(p.poly_question ?? '').slice(0, 140)}"`,
    ).join('\n');
    const prompt = [
      'You match prediction-market questions between two exchanges (A=Kalshi, B=Polymarket).',
      'For each numbered pair decide whether they resolve on the SAME real-world outcome.',
      '"same": YES on A pays exactly when YES on B pays. "inverse": YES on A pays exactly when NO on B pays.',
      '"different": different entity, threshold, date, or resolution scope. Be strict: thresholds and dates must match.',
      'Respond with ONLY this JSON: {"results":[{"i":1,"verdict":"same","confidence":0.0}]}',
      '',
      lines,
    ].join('\n');

    try {
      // 2026-06-10: moved from scribe (Sonnet 4.6) to sleuth (Fable 5). In the
      // model eval, Sonnet green-lit the "exactly 1 cut" vs "1 cut happens"
      // trap as same; Fable 5 was the only model that reliably caught it.
      // Pair verdicts gate real paper trades, so they get the best reasoner.
      const res = await delegate('sleuth' as never, prompt, { shareMemory: false, maxTokens: 1200 });
      const m = res.output.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const parsed = JSON.parse(m[0]) as { results?: Array<{ i: number; verdict: string; confidence: number }> };
      for (const r of parsed.results ?? []) {
        const pair = batch[r.i - 1];
        if (!pair) continue;
        const conf = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0;
        if ((r.verdict === 'same' || r.verdict === 'inverse') && conf >= 0.7) {
          updateEdgePair(pair.id, { status: 'confirmed', invert: r.verdict === 'inverse' ? 1 : 0, llm_confidence: conf });
        } else if (r.verdict === 'different') {
          updateEdgePair(pair.id, { status: 'rejected', llm_confidence: conf });
        } else {
          updateEdgePair(pair.id, { llm_confidence: conf });
        }
      }
    } catch (err) {
      logErr(`pair LLM confirmation failed: ${String(err).slice(0, 200)}`);
    }
  }
}

// ── Persistence + alerting ──────────────────────────────────────────────────

const ALL_KINDS = ['negrisk_yes', 'negrisk_no', 'xvenue', 'kalshi_intra', 'kalshi_spread'];

function persistFindings(findings: Finding[]): { newCount: number; seenIds: Set<string>; best: number | null } {
  const seenIds = new Set<string>();
  let newCount = 0;
  let best: number | null = null;
  for (const f of findings) {
    if (best === null || f.netEdge > best) best = f.netEdge;
    const detail = JSON.stringify(f.detail);
    const open = getOpenEdgeOpportunity(f.kind, f.ref);
    let opp: EdgeOpportunity;
    let isNew = false;
    if (open) {
      touchEdgeOpportunity(open.id, f.grossEdge, f.netEdge, f.depthUsd, detail);
      opp = { ...open, gross_edge: f.grossEdge, net_edge: f.netEdge, detail };
      seenIds.add(open.id);
    } else {
      opp = createEdgeOpportunity({
        kind: f.kind, ref: f.ref, title: f.title, venue: f.venue, category: f.category,
        detail, grossEdge: f.grossEdge, netEdge: f.netEdge, depthUsd: f.depthUsd,
      });
      seenIds.add(opp.id);
      newCount++;
      isNew = true;
    }
    maybeAlert(opp, isNew);
  }
  return { newCount, seenIds, best };
}

function maybeAlert(opp: EdgeOpportunity, isNew: boolean): void {
  if (!notifier) return;
  if ((opp.net_edge ?? 0) < ALERT_MIN_NET) return;
  if (opp.category && SPORTS_RE.test(opp.category)) return;
  const now = Math.floor(Date.now() / 1000);
  // Cooldown across row generations: a close/reopen flap must not reset it.
  const lastTs = Math.max(opp.alerted_at ?? 0, lastEdgeAlertTs(opp.kind, opp.ref) ?? 0);
  if (lastTs && now - lastTs < ALERT_COOLDOWN_S) return;
  markEdgeOpportunityAlerted(opp.id);
  try {
    notifier(opp, { isNew });
  } catch (err) {
    logErr(`edge notifier threw: ${String(err).slice(0, 200)}`);
  }
}

// ── Scan orchestration ──────────────────────────────────────────────────────

async function runScan(withMatching: boolean): Promise<void> {
  const t0 = Date.now();
  const [kalshiSweep, polyEvents] = await Promise.all([sweepKalshi(), sweepPolymarket()]);
  const kalshi = kalshiSweep.markets;
  state.kalshiMarkets = kalshi.length;
  state.polyEvents = polyEvents.length;
  state.partialKalshiSweep = kalshiSweep.partial;
  if (kalshiSweep.partial) {
    log(`kalshi sweep PARTIAL at ${KALSHI_MAX_PAGES} pages; kalshi-kind lifecycle closes suspended this scan`);
  }

  if (withMatching) {
    const created = findPairCandidates(kalshi, polyEvents);
    state.lastMatchAt = Math.floor(Date.now() / 1000);
    if (created) log(`pair matching: ${created} candidate pair(s) upserted`);
    await confirmCandidatesWithLLM();
  }

  const kalshiByTicker = new Map(kalshi.map((m) => [m.ticker, m]));
  const polyByCondition = new Map<string, PolyMarket>();
  for (const ev of polyEvents) for (const m of ev.markets) polyByCondition.set(m.conditionId, m);

  const confirmed = listEdgePairs({ status: 'confirmed', limit: 1000 });
  const findings: Finding[] = [
    ...detectNegRisk(polyEvents),
    ...detectKalshiIntra(kalshi),
    ...detectKalshiSpread(kalshi),
    ...detectXVenue(confirmed, kalshiByTicker, polyByCondition),
  ];

  const { newCount, seenIds, best } = persistFindings(findings);
  // On a partial Kalshi sweep, a missing market may simply be past the page
  // cap, so only Polymarket-sourced kinds may close (the poly sweep is a
  // deterministic top-by-volume slice, not a random truncation).
  const closableKinds = kalshiSweep.partial
    ? ['negrisk_yes', 'negrisk_no']
    : ALL_KINDS;
  const closed = closeVanishedEdgeOpportunities(closableKinds, seenIds);

  // Paper trading pass: simulate fills on this scan's Kalshi-executable
  // signals (xvenue + intra). Real quotes, fake money, honest books.
  try {
    const paperSignals: PaperSignal[] = [];
    for (const f of findings) {
      if (f.kind === 'xvenue') {
        const d = f.detail as { direction?: string; polyMid?: number; kalshiTicker?: string };
        if (typeof d.kalshiTicker === 'string' && d.kalshiTicker) {
          paperSignals.push({
            kind: 'xvenue', opportunityId: null, ticker: d.kalshiTicker,
            direction: typeof d.direction === 'string' ? d.direction : undefined,
            polyMid: typeof d.polyMid === 'number' ? d.polyMid : undefined,
            netEdge: f.netEdge,
          });
        }
      } else if (f.kind === 'kalshi_intra') {
        paperSignals.push({ kind: 'kalshi_intra', opportunityId: null, ticker: f.ref, netEdge: f.netEdge });
      }
    }
    const polyMidByTicker = new Map<string, number>();
    for (const pair of confirmed) {
      const p = polyByCondition.get(pair.poly_condition_id);
      if (!p || p.bestBid === null || p.bestAsk === null) continue;
      let mid = (p.bestBid + p.bestAsk) / 2;
      if (pair.invert) mid = 1 - mid;
      polyMidByTicker.set(pair.kalshi_ticker, mid);
    }
    await runPaperPass(paperSignals, kalshiByTicker, polyMidByTicker);
  } catch (err) {
    logErr(`paper pass failed: ${String(err).slice(0, 200)}`);
  }

  const counts = edgeSummaryCounts();
  upsertEdgeStats({
    kalshiMarkets: kalshi.length,
    polyEvents: polyEvents.length,
    pairsCandidate: counts.pairs_candidate,
    pairsConfirmed: counts.pairs_confirmed,
    oppsOpen: counts.opps_open,
    oppsNew: newCount,
    bestNetEdge: best,
  });

  state.lastScanAt = Math.floor(Date.now() / 1000);
  state.lastScanMs = Date.now() - t0;
  log(`scan #${state.scanCount}: ${kalshi.length} kalshi mkts, ${polyEvents.length} poly events, ${findings.length} findings (${newCount} new, ${closed} closed) in ${state.lastScanMs}ms`);
}

async function tick(): Promise<void> {
  if (!state.running) return;
  state.scanCount++;
  const withMatching = state.scanCount === 1 || state.scanCount % MATCH_EVERY_N_SCANS === 0;
  try {
    scanInFlight = runScan(withMatching);
    await scanInFlight;
    state.lastError = null;
  } catch (err) {
    state.errorCount++;
    state.lastError = String(err).slice(0, 300);
    logErr(`scan failed: ${state.lastError}`);
  } finally {
    scanInFlight = null;
  }
  if (state.running) timer = setTimeout(() => void tick(), SCAN_MS);
}

/** Force a scan now (dashboard button). No-op result if one is in flight. */
export async function triggerEdgeScan(): Promise<{ started: boolean }> {
  if (scanInFlight) return { started: false };
  if (timer) { clearTimeout(timer); timer = null; }
  void tick();
  return { started: true };
}

export function startEdgeScanner(): void {
  if (state.running) return;
  state.running = true;
  // 30s boot delay: let the service settle before the first paginated sweep.
  timer = setTimeout(() => void tick(), 30_000);
  log('edge scanner started (read-only; first sweep in 30s)');
}

export function stopEdgeScanner(): void {
  state.running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
