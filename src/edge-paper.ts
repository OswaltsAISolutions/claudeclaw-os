// Edge paper trader: simulated fills against REAL Kalshi quotes.
//
// This is the proving ground Gabe asked for (2026-06-10): the system trades
// fake money exactly as it would trade real money, for ~4 weeks, and the
// honest P&L decides whether the $500 go/no-go gate ever opens. Hard rules:
//   - NO Kalshi order endpoint is ever called. Entries/exits are simulated
//     at the real bid/ask the scanner just observed, with taker fees modeled.
//   - One open trade per Kalshi market, $50 budget per trade, 6 max open,
//     sports never (excluded upstream by the scanner anyway).
//   - P&L attribution follows the kacho lesson: edge_captured (the theoretical
//     edge locked at entry vs Polymarket fair value) is recorded per trade, so
//     directional residual = realized - edge_captured is visible. If residual
//     dominates, the "arb" is actually directional betting and we say so.
//
// Limitations carried honestly: fills assume our size is available at the
// quoted top-of-book (depth is not fetched in v1), and marks move at 5-min
// scan granularity. Both flatter the strategy slightly; the gate review must
// remember that.

import {
  closePaperTrade,
  createPaperTrade,
  hasOpenPaperTrade,
  markPaperTrade,
  openPaperTrades,
  paperBookSummary,
  type EdgePaperTrade,
} from './db.js';
import { logger } from './logger.js';

const log = (msg: string) => logger.info({ scope: 'paper' }, msg);

export const PAPER_START_BALANCE = 500; // mirrors the planned real funding
const PER_TRADE_BUDGET = 50;            // $ ALL-IN cost cap per position (contracts + fees)
const MAX_OPEN = 6;
const ENTRY_MIN_NET = 0.03;             // same bar as the Telegram alert
const ENTRY_MAX_NET = 0.15;             // bigger "edges" are data errors, not free money
const MIN_ENTRY_PRICE = 0.05;           // below this the ceil'd taker fee devours the position
const MAX_ENTRY_PRICE = 0.95;
const CONVERGENCE_EPS = 0.01;           // gap considered closed within 1c

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Same notifier decoupling as the scanner/library workers.
export type PaperNotifier = (trade: EdgePaperTrade, phase: 'open' | 'closed') => void;
let notifier: PaperNotifier | null = null;
export function setEdgePaperNotifier(fn: PaperNotifier): void {
  notifier = fn;
}

/** Kalshi taker fee per contract at price p, rounded up to the cent. */
function takerFee(p: number): number {
  return Math.ceil(7 * p * (1 - p)) / 100;
}

// Minimal view of what the scanner passes in (avoids a circular import).
export interface PaperQuote {
  ticker: string;
  title: string;
  yesSub: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  category: string;
}

export interface PaperSignal {
  kind: string;                 // xvenue | kalshi_intra
  opportunityId: string | null;
  ticker: string;
  direction?: string;           // kalshi_cheap_buy_yes | kalshi_rich_buy_no (xvenue)
  polyMid?: number;             // fair value thesis (xvenue)
  netEdge: number;
}

// ── Entries ─────────────────────────────────────────────────────────────────

function tryEnter(sig: PaperSignal, q: PaperQuote): void {
  if (hasOpenPaperTrade(q.ticker)) return;
  const book = paperBookSummary(PAPER_START_BALANCE);
  if (book.open_count >= MAX_OPEN) return;

  let side: 'yes' | 'no' | 'arb';
  let price: number;            // per contract (arb = combined pair cost)
  let polyFair: number | null = null;

  if (sig.kind === 'xvenue') {
    if (sig.direction === 'kalshi_cheap_buy_yes') {
      if (q.yesAsk === null || q.yesAsk <= 0) return;
      side = 'yes';
      price = q.yesAsk;
      polyFair = sig.polyMid ?? null;
    } else if (sig.direction === 'kalshi_rich_buy_no') {
      if (q.noAsk === null || q.noAsk <= 0) return;
      side = 'no';
      price = q.noAsk;
      polyFair = sig.polyMid ?? null;
    } else {
      return;
    }
  } else if (sig.kind === 'kalshi_intra') {
    if (q.yesAsk === null || q.noAsk === null) return;
    side = 'arb';
    price = q.yesAsk + q.noAsk; // pays $1 at settlement whatever happens
    if (price >= 1) return;
  } else {
    return;
  }

  // Price band: outside it the cent-rounded taker fee is a huge fraction of
  // the contract (a 1c contract pays a 1c fee = 100%), and longshot quotes
  // are usually stale anyway. Arb pairs are exempt (cost is the ~$0.9 pair).
  if (side !== 'arb' && (price < MIN_ENTRY_PRICE || price > MAX_ENTRY_PRICE)) return;

  // Size to the ALL-IN budget: contracts plus their fees stay within $50.
  const perContractFee = side === 'arb'
    ? takerFee(q.yesAsk as number) + takerFee(q.noAsk as number)
    : takerFee(price);
  const qty = Math.floor(PER_TRADE_BUDGET / (price + perContractFee));
  if (qty < 1) return;
  const fee = perContractFee * qty;
  const cost = price * qty + fee;
  if (cost > book.cash) return;

  // Theoretical edge locked at entry: fair value of what we hold minus all-in cost.
  let edgeCaptured: number | null = null;
  if (side === 'arb') {
    edgeCaptured = (1 - price) * qty - fee;
  } else if (polyFair !== null) {
    const fairPerContract = side === 'yes' ? polyFair : 1 - polyFair;
    edgeCaptured = (fairPerContract - price) * qty - fee;
  }

  const trade = createPaperTrade({
    opportunityId: sig.opportunityId,
    kalshiTicker: q.ticker,
    title: `${q.title}${q.yesSub ? ` (${q.yesSub})` : ''}`,
    category: q.category,
    side,
    qty,
    entryPrice: price,
    entryFee: fee,
    entryPolyFair: polyFair,
    edgeCaptured,
  });
  log(`paper OPEN ${side} x${qty} ${q.ticker} @ ${price.toFixed(3)} (fee ${fee.toFixed(2)}, thesis fair ${polyFair?.toFixed(3) ?? 'n/a'})`);
  try { notifier?.(trade, 'open'); } catch { /* non-fatal */ }
}

// ── Exits ───────────────────────────────────────────────────────────────────

function exitValue(t: EdgePaperTrade, q: PaperQuote): { proceeds: number; fee: number; price: number } | null {
  if (t.side === 'yes') {
    if (q.yesBid === null || q.yesBid <= 0) return null;
    const fee = takerFee(q.yesBid) * t.qty;
    return { proceeds: q.yesBid * t.qty - fee, fee, price: q.yesBid };
  }
  if (t.side === 'no') {
    if (q.noBid === null || q.noBid <= 0) return null;
    const fee = takerFee(q.noBid) * t.qty;
    return { proceeds: q.noBid * t.qty - fee, fee, price: q.noBid };
  }
  return null; // arb pairs are held to settlement by design
}

function tryConvergenceExit(t: EdgePaperTrade, q: PaperQuote, polyMidNow: number | null): void {
  const ev = exitValue(t, q);
  if (!ev) return;
  const entryCost = t.entry_price * t.qty + t.entry_fee;
  const pnlIfExit = ev.proceeds - entryCost;
  if (pnlIfExit <= 0) return;

  // Exit only when the thesis is spent: the gap to Polymarket fair value has
  // closed (or we have no thesis value to compare against anymore).
  let gapClosed = true;
  if (polyMidNow !== null) {
    const fairPerContract = t.side === 'yes' ? polyMidNow : 1 - polyMidNow;
    gapClosed = fairPerContract - ev.price <= CONVERGENCE_EPS;
  }
  if (!gapClosed) return;

  const closed = closePaperTrade(t.id, {
    status: 'closed',
    exitPrice: ev.price,
    exitFee: ev.fee,
    exitReason: 'convergence',
    realizedPnl: pnlIfExit,
  });
  log(`paper CLOSE convergence ${t.kalshi_ticker} pnl ${pnlIfExit.toFixed(2)}`);
  if (closed) { try { notifier?.(closed, 'closed'); } catch { /* non-fatal */ } }
}

/**
 * Handle a held trade whose market vanished from the open sweep: fetch the
 * single market. Settled with yes/no -> realize. Settled/voided with any
 * other terminal result -> close flat (Kalshi refunds premiums and fees on
 * voided markets, so pnl 0 is the faithful model; without this branch a
 * voided market would pin a book slot forever). Still active (just outside
 * a truncated sweep) -> return a live quote so the caller can mark and
 * convergence-exit instead of going blind.
 */
async function trySettleOrQuote(t: EdgePaperTrade): Promise<PaperQuote | null> {
  try {
    const r = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(t.kalshi_ticker)}`, {
      headers: { 'User-Agent': 'claudeclaw-edge-scanner/1.0 (read-only research)' },
    });
    if (!r.ok) return null;
    const data = await r.json() as { market?: Record<string, unknown> };
    const m = data.market;
    if (!m) return null;
    const num = (v: unknown): number | null => {
      const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const status = String(m.status ?? '').toLowerCase();
    const result = String(m.result ?? '').toLowerCase();

    if (status === 'active' || status === 'open') {
      return {
        ticker: t.kalshi_ticker,
        title: t.title ?? t.kalshi_ticker,
        yesSub: null,
        yesBid: num(m.yes_bid_dollars),
        yesAsk: num(m.yes_ask_dollars),
        noBid: num(m.no_bid_dollars),
        noAsk: num(m.no_ask_dollars),
        category: t.category ?? '',
      };
    }

    const terminal = ['settled', 'finalized', 'determined'].includes(status);
    if (terminal && (result === 'yes' || result === 'no')) {
      const entryCost = t.entry_price * t.qty + t.entry_fee;
      let proceeds = 0;
      if (t.side === 'arb') proceeds = 1 * t.qty;                 // one leg always pays
      else if (t.side === 'yes') proceeds = result === 'yes' ? t.qty : 0;
      else proceeds = result === 'no' ? t.qty : 0;
      const pnl = proceeds - entryCost;                            // settlement has no fee
      const closed = closePaperTrade(t.id, {
        status: 'settled', exitPrice: null, exitFee: 0,
        exitReason: 'settlement', result, realizedPnl: pnl,
      });
      log(`paper SETTLE ${t.kalshi_ticker} result=${result} pnl ${pnl.toFixed(2)}`);
      if (closed) { try { notifier?.(closed, 'closed'); } catch { /* non-fatal */ } }
      return null;
    }
    if (terminal) {
      // Voided / annulled / any non-yes-no terminal result: full refund model.
      const closed = closePaperTrade(t.id, {
        status: 'settled', exitPrice: null, exitFee: 0,
        exitReason: 'void', result: result || 'void', realizedPnl: 0,
      });
      log(`paper VOID ${t.kalshi_ticker} (result=${result || 'none'}), refunded flat`);
      if (closed) { try { notifier?.(closed, 'closed'); } catch { /* non-fatal */ } }
      return null;
    }
    return null; // e.g. 'closed' awaiting settlement: keep holding
  } catch {
    return null; // transient; next scan retries
  }
}

// ── Per-scan hook (called by edge-scanner after each sweep) ─────────────────

/**
 * One paper pass per scan: mark + exit existing positions against fresh
 * quotes, settle vanished markets, then consider new entries from this
 * scan's signals.
 */
export async function runPaperPass(
  signals: PaperSignal[],
  quotes: ReadonlyMap<string, PaperQuote>,
  polyMidByTicker: ReadonlyMap<string, number>,
): Promise<void> {
  // 1. Manage existing positions first (exits free budget for entries).
  for (const t of openPaperTrades()) {
    // Gone from the open sweep -> settled, voided, or just truncated out of a
    // partial sweep; trySettleOrQuote resolves which and hands back a live
    // quote in the truncated case so the position is never managed blind.
    const q = quotes.get(t.kalshi_ticker) ?? await trySettleOrQuote(t);
    if (!q) continue;
    const yesMid = q.yesBid !== null && q.yesAsk !== null ? (q.yesBid + q.yesAsk) / 2 : null;
    const noMid = q.noBid !== null && q.noAsk !== null ? (q.noBid + q.noAsk) / 2 : null;
    // Mark in the same units as entry_price: arb entries are the COMBINED
    // pair cost, so the arb mark is the sum of both leg mids.
    const mid = t.side === 'arb'
      ? (yesMid !== null && noMid !== null ? yesMid + noMid : null)
      : t.side === 'no' ? noMid : yesMid;
    if (mid !== null) markPaperTrade(t.id, mid);
    tryConvergenceExit(t, q, polyMidByTicker.get(t.kalshi_ticker) ?? null);
  }

  // 2. New entries, best edge first. Edges above ENTRY_MAX_NET are treated
  // as data errors (bad pair match or degenerate book), not opportunities:
  // double-digit riskless edges on liquid venues do not exist.
  const sorted = signals
    .filter((s) => s.netEdge >= ENTRY_MIN_NET && s.netEdge <= ENTRY_MAX_NET)
    .sort((a, b) => b.netEdge - a.netEdge);
  for (const sig of sorted) {
    const q = quotes.get(sig.ticker);
    if (q) tryEnter(sig, q);
  }
}

export function paperSummary(): ReturnType<typeof paperBookSummary> {
  return paperBookSummary(PAPER_START_BALANCE);
}
