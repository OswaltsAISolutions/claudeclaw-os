import { useMemo, useState } from 'preact/hooks';
import { RefreshCw, Radar, Check, X as XIcon } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill, StatusDot, type Tone } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch } from '@/lib/api';

// Edge Scanner: read-only measurement of prediction-market dislocations.
// This page reports what the scanner SEES, never trades. Depth is honestly
// "unknown" in v1 (no order-book fetch) and every edge is shown net of a
// documented fee model. Kalshi is the only venue legally tradable from
// Ohio; Polymarket numbers are a free fair-value signal feed.

interface ScannerState {
  running: boolean;
  scanCount: number;
  lastScanAt: number | null;
  lastScanMs: number | null;
  lastMatchAt: number | null;
  kalshiMarkets: number;
  polyEvents: number;
  partialKalshiSweep?: boolean;
  lastError: string | null;
  errorCount: number;
}

interface Summary {
  state: ScannerState;
  counts: { pairs_candidate: number; pairs_confirmed: number; opps_open: number; opps_closed: number };
}

interface Opp {
  id: string;
  kind: string;
  ref: string;
  title: string | null;
  venue: string | null;
  category: string | null;
  detail: Record<string, unknown> | null;
  gross_edge: number | null;
  net_edge: number | null;
  depth_usd: number | null;
  first_seen: number;
  last_seen: number;
  max_net_edge: number | null;
  status: 'open' | 'closed';
  closed_at: number | null;
}

interface Pair {
  id: string;
  kalshi_ticker: string;
  kalshi_title: string | null;
  poly_question: string | null;
  poly_event_slug: string | null;
  category: string | null;
  match_score: number | null;
  llm_confidence: number | null;
  status: string;
  invert: number;
}

interface PaperTrade {
  id: string;
  kalshi_ticker: string;
  title: string | null;
  category: string | null;
  side: 'yes' | 'no' | 'arb';
  qty: number;
  entry_price: number;
  entry_fee: number;
  entry_poly_fair: number | null;
  edge_captured: number | null;
  opened_at: number;
  status: 'open' | 'closed' | 'settled';
  mark_price: number | null;
  exit_reason: string | null;
  result: string | null;
  realized_pnl: number | null;
  closed_at: number | null;
}

interface PaperBook {
  summary: {
    start_balance: number; cash: number; open_cost: number; open_count: number;
    realized_pnl: number; closed_count: number;
    edge_captured_total: number; directional_residual_total: number;
  };
  trades: PaperTrade[];
}

const KIND_LABEL: Record<string, string> = {
  negrisk_yes: 'negRisk buy-YES',
  negrisk_no: 'negRisk buy-NO',
  xvenue: 'Kalshi vs Poly',
  kalshi_intra: 'Kalshi YES+NO<$1',
  kalshi_spread: 'Kalshi spread',
};

const KIND_TONE: Record<string, Tone> = {
  negrisk_yes: 'accent',
  negrisk_no: 'accent',
  xvenue: 'high',
  kalshi_intra: 'done',
  kalshi_spread: 'medium',
};

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function durationLabel(o: Opp): string {
  const end = o.status === 'closed' ? (o.closed_at ?? o.last_seen) : Math.floor(Date.now() / 1000);
  const s = Math.max(0, end - o.first_seen);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5">
      <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] font-semibold">{label}</div>
      <div class="text-[16px] font-semibold text-[var(--color-text)] mt-0.5">{value}</div>
    </div>
  );
}

export function Edge() {
  const [tab, setTab] = useState<'open' | 'closed' | 'pairs' | 'paper'>('open');
  const [kind, setKind] = useState('');
  const [scanBusy, setScanBusy] = useState(false);

  const summary = useFetch<Summary>('/api/edge/summary', 10_000);
  const oppPath = useMemo(() => {
    if (tab === 'pairs' || tab === 'paper') return null;
    const p = new URLSearchParams({ status: tab, limit: '150' });
    if (kind) p.set('kind', kind);
    return `/api/edge/opportunities?${p}`;
  }, [tab, kind]);
  const opps = useFetch<{ rows: Opp[]; total: number }>(oppPath, 15_000);
  const pairs = useFetch<{ pairs: Pair[] }>(tab === 'pairs' ? '/api/edge/pairs' : null, 30_000);
  const paper = useFetch<PaperBook>(tab === 'paper' ? '/api/edge/paper' : null, 15_000);

  const st = summary.data?.state;
  const counts = summary.data?.counts;

  const forceScan = async () => {
    setScanBusy(true);
    try { await apiPost('/api/edge/scan'); summary.refresh(); } catch { /* 409 = already scanning */ }
    setTimeout(() => setScanBusy(false), 4000);
  };

  const setPairStatus = async (p: Pair, status: 'confirmed' | 'rejected') => {
    await apiPatch(`/api/edge/pairs/${p.id}`, { status });
    pairs.refresh();
  };

  const rows = opps.data?.rows ?? [];

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Edge Scanner"
        actions={
          <button type="button" onClick={forceScan} disabled={scanBusy}
            class="press-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[12px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50">
            <RefreshCw size={12} class={scanBusy ? 'animate-spin' : ''} /> Scan now
          </button>
        }
      />

      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pb-6 space-y-4">
        {/* Worker state strip */}
        <div class="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)] pt-1">
          <StatusDot tone={st ? (st.lastError ? 'failed' : st.running ? 'running' : 'cancelled') : 'queued'} />
          {st
            ? st.lastScanAt
              ? <span>Scan #{st.scanCount} {ago(st.lastScanAt)} ({((st.lastScanMs ?? 0) / 1000).toFixed(1)}s) · {st.kalshiMarkets.toLocaleString()} Kalshi markets{st.partialKalshiSweep ? ' (partial sweep)' : ''} · {st.polyEvents} Poly events · read-only, nothing funded</span>
              : <span>Scanner armed, first sweep pending…</span>
            : <span>Connecting…</span>}
        </div>
        {st?.lastError && (
          <div class="text-[12px] font-mono text-[var(--color-status-failed)]">last error: {st.lastError}</div>
        )}

        {/* Stat chips */}
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <StatChip label="Open dislocations" value={counts ? String(counts.opps_open) : '—'} />
          <StatChip label="Closed (lifetime)" value={counts ? String(counts.opps_closed) : '—'} />
          <StatChip label="Confirmed pairs" value={counts ? String(counts.pairs_confirmed) : '—'} />
          <StatChip label="Candidate pairs" value={counts ? String(counts.pairs_candidate) : '—'} />
        </div>

        {/* Tabs + kind filter */}
        <div class="flex items-center gap-2 flex-wrap">
          {(['open', 'closed', 'pairs', 'paper'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              class={`press-target px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${tab === t
                ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
              {t === 'open' ? 'Open' : t === 'closed' ? 'History' : t === 'pairs' ? 'Market pairs' : 'Paper book'}
            </button>
          ))}
          {tab !== 'pairs' && tab !== 'paper' && (
            <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)}
              class="ml-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)]">
              <option value="">All kinds</option>
              {Object.entries(KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          )}
        </div>

        {/* Opportunity list */}
        {tab !== 'pairs' && tab !== 'paper' && (
          <>
            <PageState
              loading={opps.loading && rows.length === 0}
              error={opps.error}
              empty={!opps.loading && !opps.error && rows.length === 0}
              emptyTitle={tab === 'open' ? 'No dislocations right now' : 'No history yet'}
              emptyDescription={tab === 'open'
                ? 'That is honest data, not a bug: post-fee edges are rare. The scanner sweeps every 5 minutes.'
                : 'Closed dislocations build the duration dataset that decides the go/no-go on real capital.'}
            />
            <div class="space-y-2">
              {rows.map((o) => (
                <div key={o.id} class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
                  <div class="flex items-center gap-2 flex-wrap">
                    <Pill tone={KIND_TONE[o.kind] ?? 'neutral'}>{KIND_LABEL[o.kind] ?? o.kind}</Pill>
                    {o.category && <span class="text-[11px] text-[var(--color-text-faint)]">{o.category}</span>}
                    <span class="ml-auto text-[12px] font-semibold text-[var(--color-text)]">net {pct(o.net_edge)}</span>
                    <span class="text-[11px] text-[var(--color-text-muted)]">gross {pct(o.gross_edge)}</span>
                  </div>
                  <div class="text-[13px] text-[var(--color-text)] mt-1.5 leading-snug">{o.title ?? o.ref}</div>
                  <div class="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                    <span>alive {durationLabel(o)}</span>
                    <span>peak {pct(o.max_net_edge)}</span>
                    <span>depth {o.depth_usd === null ? 'unknown' : `$${o.depth_usd.toFixed(0)}`}</span>
                    <span>seen {ago(o.last_seen)}</span>
                    {o.detail && typeof o.detail === 'object' && 'direction' in o.detail && (
                      <span class="font-mono">{String((o.detail as Record<string, unknown>).direction)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Pairs tab */}
        {tab === 'pairs' && (
          <>
            <PageState
              loading={pairs.loading && !pairs.data}
              error={pairs.error}
              empty={!pairs.loading && !pairs.error && (pairs.data?.pairs.length ?? 0) === 0}
              emptyTitle="No matched markets yet"
              emptyDescription="The matcher runs ~every 30 minutes: title similarity first, then scribe verifies that both questions resolve on the same outcome."
            />
            <div class="space-y-2">
              {(pairs.data?.pairs ?? []).map((p) => (
                <div key={p.id} class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
                  <div class="flex items-center gap-2 flex-wrap">
                    <Pill tone={p.status === 'confirmed' ? 'done' : p.status === 'rejected' ? 'failed' : 'queued'}>{p.status}</Pill>
                    {p.invert === 1 && <Pill tone="warn">inverse</Pill>}
                    {p.category && <span class="text-[11px] text-[var(--color-text-faint)]">{p.category}</span>}
                    <span class="ml-auto text-[11px] text-[var(--color-text-muted)]">
                      match {p.match_score === null ? '—' : p.match_score.toFixed(2)} · LLM {p.llm_confidence === null ? 'unchecked' : p.llm_confidence.toFixed(2)}
                    </span>
                  </div>
                  <div class="text-[12.5px] text-[var(--color-text)] mt-1.5 leading-snug">
                    <span class="text-[var(--color-text-faint)] font-semibold mr-1">K:</span>{p.kalshi_title ?? p.kalshi_ticker}
                  </div>
                  <div class="text-[12.5px] text-[var(--color-text)] mt-0.5 leading-snug">
                    <span class="text-[var(--color-text-faint)] font-semibold mr-1">P:</span>{p.poly_question ?? '—'}
                  </div>
                  {p.status !== 'rejected' && (
                    <div class="flex items-center gap-2 mt-2">
                      {p.status !== 'confirmed' && (
                        <button type="button" onClick={() => void setPairStatus(p, 'confirmed')}
                          class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--color-border)] text-[var(--color-status-done)]">
                          <Check size={11} /> Confirm
                        </button>
                      )}
                      <button type="button" onClick={() => void setPairStatus(p, 'rejected')}
                        class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--color-border)] text-[var(--color-status-failed)]">
                        <XIcon size={11} /> Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Paper book tab */}
        {tab === 'paper' && (
          <>
            {paper.data && (
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                <StatChip label="Paper cash" value={`$${paper.data.summary.cash.toFixed(2)}`} />
                <StatChip label="In positions" value={`$${paper.data.summary.open_cost.toFixed(2)} (${paper.data.summary.open_count})`} />
                <StatChip label="Realized P&L" value={`${paper.data.summary.realized_pnl >= 0 ? '+' : ''}$${paper.data.summary.realized_pnl.toFixed(2)}`} />
                <StatChip label="Edge vs residual" value={`$${paper.data.summary.edge_captured_total.toFixed(2)} / ${paper.data.summary.directional_residual_total >= 0 ? '+' : ''}$${paper.data.summary.directional_residual_total.toFixed(2)}`} />
              </div>
            )}
            <PageState
              loading={paper.loading && !paper.data}
              error={paper.error}
              empty={!paper.loading && !paper.error && (paper.data?.trades.length ?? 0) === 0}
              emptyTitle="No paper trades yet"
              emptyDescription="The trader enters only when a confirmed cross-venue signal clears 3% net of fees. Patience is the strategy; an empty book is honest data."
            />
            <div class="space-y-2">
              {(paper.data?.trades ?? []).map((t) => {
                const unrealized = t.status === 'open' && t.mark_price !== null
                  ? (t.mark_price - t.entry_price) * t.qty - t.entry_fee
                  : null;
                return (
                  <div key={t.id} class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
                    <div class="flex items-center gap-2 flex-wrap">
                      <Pill tone={t.status === 'open' ? 'running' : (t.realized_pnl ?? 0) >= 0 ? 'done' : 'failed'}>
                        {t.status === 'open' ? 'open' : t.exit_reason === 'settlement' ? `settled ${t.result ?? ''}` : 'closed'}
                      </Pill>
                      <Pill tone="neutral">{t.side} x{t.qty}</Pill>
                      {t.category && <span class="text-[11px] text-[var(--color-text-faint)]">{t.category}</span>}
                      <span class="ml-auto text-[12px] font-semibold text-[var(--color-text)]">
                        {t.status === 'open'
                          ? (unrealized !== null ? `${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)} unrealized` : 'no mark yet')
                          : `${(t.realized_pnl ?? 0) >= 0 ? '+' : ''}$${(t.realized_pnl ?? 0).toFixed(2)}`}
                      </span>
                    </div>
                    <div class="text-[13px] text-[var(--color-text)] mt-1.5 leading-snug">{t.title ?? t.kalshi_ticker}</div>
                    <div class="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                      <span>in @ {t.entry_price.toFixed(2)} (fee ${t.entry_fee.toFixed(2)})</span>
                      {t.entry_poly_fair !== null && <span>thesis fair {t.entry_poly_fair.toFixed(2)}</span>}
                      {t.mark_price !== null && t.status === 'open' && <span>mark {t.mark_price.toFixed(2)}</span>}
                      {t.edge_captured !== null && <span>edge at entry ${t.edge_captured.toFixed(2)}</span>}
                      <span>{ago(t.status === 'open' ? t.opened_at : (t.closed_at ?? t.opened_at))}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div class="text-[11px] text-[var(--color-text-faint)] leading-relaxed">
              Fake $500 bankroll, $50 per position, 6 max open, one per market. Fills assume quoted top-of-book
              (depth unfetched, slightly flattering). Edge-at-entry vs directional residual is the number that matters:
              if residual drives the P&L, this is betting, not arbitrage, and it will be said plainly at the gate review.
            </div>
          </>
        )}

        {/* Honest footer */}
        <div class="flex items-start gap-2 text-[11px] text-[var(--color-text-faint)] leading-relaxed pt-2">
          <Radar size={13} class="mt-0.5 shrink-0" />
          <span>
            Read-only measurement. Net edges subtract a documented fee model (Kalshi taker 0.07·p·(1-p) rounded up to the cent;
            Polymarket 0.072·p·(1-p) where fees are enabled). Order-book depth is not fetched in v1, so size is unknown.
            Sports are excluded (untradeable from Ohio). No venue is funded and the scanner places no orders.
          </span>
        </div>
      </div>
    </div>
  );
}
