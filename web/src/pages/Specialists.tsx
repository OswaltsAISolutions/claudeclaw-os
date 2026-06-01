import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Crosshair, Send, Square, Zap, AlertTriangle, CheckCircle2,
  Brain, ChevronDown, ChevronUp,
} from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPost, dashboardToken } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { formatRelativeTime } from '@/lib/format';

interface Specialist {
  callsign: string;
  tier: 'local' | 'claw' | 'cloud';
  role: string;
  preferredModel: string;
  fallbackModels: string[];
  fallbackCallsign?: string | null;
  capabilities: string[];
  vramHintGB: number;
  temperature: number;
  contextTokens: number;
  available: boolean;
  modelInUse: string | null;
  fellBackFrom: string | null;
}

interface DelegateResult {
  callsign: string;
  modelUsed: string;
  output: string;
  durationMs: number;
  tokenEstimate: number;
  fellBackFrom?: string | null;
}

interface HistoryTurn {
  role: 'user' | 'assistant' | string;
  content: string;
  timestamp?: number;
  created_at?: number;
}

interface HistoryResponse {
  callsign: string;
  turns: HistoryTurn[];
}

export function Specialists() {
  const roster = useFetch<{ specialists: Specialist[] }>('/api/specialists', 15_000);

  if (roster.loading && !roster.data) return <PageState loading />;
  if (roster.error) return <PageState error={roster.error} />;

  const specs = roster.data?.specialists || [];
  const available = specs.filter((s) => s.available).length;

  return (
    <div class="h-full flex flex-col">
      <PageHeader title="Specialists" />

      <div class="flex-1 overflow-y-auto px-5 md:px-6 pb-8 space-y-5 max-w-4xl mx-auto w-full">
        {/* Top status banner. */}
        <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl px-4 py-3 flex items-center gap-3">
          <Crosshair size={16} class="text-[var(--color-accent)]" />
          <div class="flex-1 min-w-0">
            <div class="text-[12.5px] font-medium text-[var(--color-text)]">
              {available} of {specs.length} specialists online
            </div>
            <div class="text-[10.5px] text-[var(--color-text-faint)]">
              J.A.R.V.I.S. routes tasks to these callsigns. All share the same hivemind memory.
            </div>
          </div>
          <Pill tone="done">hivemind</Pill>
        </div>

        {/* Roster grid */}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {specs.map((s) => (
            <SpecialistCard key={s.callsign} spec={s} onChanged={roster.refresh} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SpecialistCard({ spec, onChanged }: { spec: Specialist; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [task, setTask] = useState('');
  const [lastResult, setLastResult] = useState<DelegateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Recent task history for this specialist — pulled from
  // /api/specialists/:callsign/history (conversation_log entries tagged
  // with agent_id = "specialist:<callsign>"). Poll every 10s when the
  // card is expanded so a routed task from chat appears within seconds.
  const history = useFetch<HistoryResponse>(
    `/api/specialists/${spec.callsign}/history`,
    expanded ? 10_000 : 60_000,
  );

  async function runTask() {
    const trimmed = task.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setError(null);
    setLastResult(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/specialists/delegate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dashboard-token': dashboardToken,
        },
        body: JSON.stringify({ callsign: spec.callsign, task: trimmed }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data: DelegateResult = await res.json();
      setLastResult(data);
      onChanged();
      // Refresh the history feed so the just-dispatched task shows up
      // immediately rather than waiting for the next poll.
      history.refresh();
      pushToast({
        tone: 'success',
        title: `${spec.callsign} done`,
        description: `${data.durationMs}ms, ~${data.tokenEstimate} tokens`,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setError('Cancelled');
      } else {
        const msg = err?.message || String(err);
        setError(msg);
        pushToast({ tone: 'error', title: `${spec.callsign} failed`, description: msg });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runTask();
    }
  }

  const statusBadge = spec.available
    ? spec.fellBackFrom
      ? <Pill tone="neutral">fallback</Pill>
      : <Pill tone="done">online</Pill>
    : <Pill tone="failed">offline</Pill>;

  // Tier badge — shows where this specialist runs. Local is the
  // post-2026-05-25 default. Cloud means it would hit the paid
  // Anthropic route (only when a user override flips it).
  const tierBadge = spec.tier === 'cloud'
    ? <span class="text-[9.5px] font-mono uppercase tracking-[0.14em] px-1.5 py-0.5 rounded bg-[var(--color-status-warning)]/15 border border-[var(--color-status-warning)]/40 text-[var(--color-status-warning)]">PAID</span>
    : spec.tier === 'claw'
      ? <span class="text-[9.5px] font-mono uppercase tracking-[0.14em] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/40 text-[var(--color-accent)]">LOCAL · CLAW</span>
      : <span class="text-[9.5px] font-mono uppercase tracking-[0.14em] px-1.5 py-0.5 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-muted)]">LOCAL</span>;

  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-4 space-y-2.5">
      {/* Header */}
      <div class="flex items-start gap-2">
        <div class="shrink-0 w-8 h-8 rounded bg-[var(--color-card)] border border-[var(--color-border)] flex items-center justify-center">
          <CallsignGlyph callsign={spec.callsign} />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[13px] font-semibold text-[var(--color-text)] capitalize">{spec.callsign}</span>
            {tierBadge}
            {statusBadge}
            <span class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums">
              ~{spec.vramHintGB}GB VRAM
            </span>
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-snug">{spec.role}</div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          class="shrink-0 p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-card)]"
          title={expanded ? 'Collapse' : 'Details'}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Model line */}
      <div class="text-[10.5px] font-mono text-[var(--color-text-faint)] truncate">
        {spec.available
          ? <>model: {spec.modelInUse}{spec.fellBackFrom && <span class="text-[var(--color-status-warning)]"> (wanted {spec.fellBackFrom})</span>}</>
          : <span class="text-[var(--color-status-failed)]">wanted: {spec.preferredModel} — not installed</span>}
      </div>

      {/* Capabilities */}
      <div class="flex flex-wrap gap-1">
        {spec.capabilities.slice(0, 6).map((cap) => (
          <span key={cap} class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text-faint)]">
            {cap}
          </span>
        ))}
      </div>

      {/* Usage stats (last 24h) — backed by /api/specialists/stats */}
      <SpecialistStatsStrip callsign={spec.callsign} />


      {/* Expanded details */}
      {expanded && (
        <div class="space-y-2.5">
          <div class="text-[10.5px] text-[var(--color-text-faint)] bg-[var(--color-card)] rounded p-2 space-y-1 border border-[var(--color-border)]">
            <div>temperature: <span class="font-mono">{spec.temperature}</span></div>
            <div>context: <span class="font-mono">{spec.contextTokens.toLocaleString()} tokens</span></div>
            <div>fallback chain:</div>
            <ul class="ml-3 space-y-0.5">
              {spec.fallbackModels.map((m) => (
                <li key={m} class="font-mono text-[10px] truncate">↳ {m}</li>
              ))}
            </ul>
          </div>

          {/* Recent activity feed — last N tasks delegated to this
              specialist (whether via the dispatch box above, or routed
              from chat / Telegram / Mission Control through agent.ts's
              intelligentRoute). Polls every 10s while card is expanded. */}
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <div class="text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--color-text-faint)]">
                Recent activity
              </div>
              {history.data?.turns && (
                <div class="text-[10px] text-[var(--color-text-faint)] tabular-nums">
                  {history.data.turns.length} turn{history.data.turns.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
            {history.loading && !history.data && (
              <div class="text-[10.5px] text-[var(--color-text-faint)] italic px-1">loading…</div>
            )}
            {history.data && history.data.turns.length === 0 && (
              <div class="text-[10.5px] text-[var(--color-text-faint)] italic px-1">no recent tasks</div>
            )}
            {history.data && history.data.turns.length > 0 && (
              <div class="space-y-1.5">
                {history.data.turns.slice(0, 6).map((turn, i) => {
                  const ts = turn.timestamp ?? turn.created_at;
                  const isUser = turn.role === 'user';
                  return (
                    <div
                      key={i}
                      class={[
                        'text-[11px] bg-[var(--color-card)] rounded p-2 border border-[var(--color-border)]',
                        isUser ? 'border-l-2 border-l-[var(--color-accent)]' : '',
                      ].join(' ')}
                    >
                      <div class="text-[var(--color-text-faint)] text-[10px] mb-1 flex items-center gap-1.5">
                        <span class={isUser ? 'text-[var(--color-accent)] font-semibold' : 'capitalize'}>
                          {isUser ? 'TASK' : turn.role}
                        </span>
                        {ts && (
                          <>
                            <span>·</span>
                            <span>{formatRelativeTime(ts)}</span>
                          </>
                        )}
                      </div>
                      <div class="text-[var(--color-text)] line-clamp-2 leading-snug">
                        {turn.content?.slice(0, 240) || '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick task panel */}
      <div class="border-t border-[var(--color-border)] pt-2 space-y-1.5">
        <textarea
          value={task}
          onInput={(e: any) => setTask(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={spec.available
            ? `Quick task for ${spec.callsign}…  (Cmd/Ctrl+Enter to dispatch)`
            : 'Specialist offline — install a model first'}
          disabled={!spec.available || running}
          rows={2}
          class="w-full bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text)] text-[11.5px] rounded px-2 py-1.5 resize-y min-h-[36px] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
        <div class="flex items-center justify-end gap-2">
          {running ? (
            <button
              type="button"
              onClick={cancel}
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[var(--color-status-failed)]/15 border border-[var(--color-status-failed)]/40 text-[var(--color-status-failed)]"
            >
              <Square size={11} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={runTask}
              disabled={!spec.available || !task.trim()}
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={11} /> Dispatch
            </button>
          )}
        </div>
      </div>

      {/* Last result */}
      {(running || lastResult || error) && (
        <div class="border-t border-[var(--color-border)] pt-2">
          {running && (
            <div class="text-[11px] text-[var(--color-text-faint)] flex items-center gap-1.5">
              <Zap size={11} class="text-[var(--color-accent)] animate-pulse" />
              {spec.callsign} working…
            </div>
          )}
          {error && (
            <div class="text-[11px] text-[var(--color-status-failed)] flex items-start gap-1.5">
              <AlertTriangle size={11} class="shrink-0 mt-0.5" /> {error}
            </div>
          )}
          {lastResult && (
            <div class="space-y-1">
              <div class="flex items-center gap-2 text-[10.5px] text-[var(--color-text-faint)]">
                <CheckCircle2 size={11} class="text-[var(--color-status-done)]" />
                <span class="tabular-nums">{lastResult.durationMs}ms</span>
                <span>·</span>
                <span class="tabular-nums">~{lastResult.tokenEstimate} tokens</span>
                <span>·</span>
                <span class="font-mono truncate">{lastResult.modelUsed}</span>
              </div>
              <div class="text-[11.5px] text-[var(--color-text)] bg-[var(--color-card)] border border-[var(--color-border)] rounded p-2 whitespace-pre-wrap max-h-[260px] overflow-y-auto">
                {lastResult.output}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Tiny single-character glyph per callsign. Cheaper than a real icon set
// and keeps the cards visually distinct.
function CallsignGlyph({ callsign }: { callsign: string }) {
  const glyph: Record<string, string> = {
    scribe: 'S',
    coder: '{ }',
    eye: '◉',
    sleuth: '?',
    reaper: '☠',
    archivist: '◫',
    sentinel: '◆',
    cipher: 'Σ',
  };
  return (
    <span class="text-[12px] font-mono font-semibold text-[var(--color-accent)]">
      {glyph[callsign] || callsign[0].toUpperCase()}
    </span>
  );
}

// Re-export the Brain icon so tree-shakers don't complain about an unused
// import when this file is the only consumer outside LocalModels.
export { Brain };

// ── Per-card usage stats strip ────────────────────────────────────────
// Pulls /api/specialists/stats once per card mount and re-fetches when
// the parent roster refreshes. Shows: invocations (last 24h), total
// runtime, last invocation timestamp. Click to expand and see the
// recent task previews. Empty state (no invocations) shows a faint
// "no recent activity" line so a brand-new specialist doesn't look
// broken.

interface SpecialistStatsResp {
  hours: number;
  stats: Array<{
    callsign: string;
    invocations: number;
    totalDurationMs: number;
    avgDurationMs: number;
    totalToolCalls: number;
    lastInvokedAt: number | null;
    lastModel: string | null;
    recentTasks: Array<{ when: number; preview: string; durationMs: number; tier: string }>;
  }>;
}

function SpecialistStatsStrip({ callsign }: { callsign: string }) {
  const [open, setOpen] = useState(false);
  // Refresh every 30s so the activity stays live without hammering the API.
  const fetched = useFetch<SpecialistStatsResp>('/api/specialists/stats?hours=24', 30_000);
  const stats = fetched.data?.stats?.find((s) => s.callsign === callsign);
  if (!stats) return null;

  if (stats.invocations === 0) {
    return (
      <div class="text-[10px] text-[var(--color-text-faint)] italic">
        no recent activity (24h)
      </div>
    );
  }

  const totalSec = Math.round(stats.totalDurationMs / 1000);
  const avgSec = Math.round(stats.avgDurationMs / 1000);
  const lastAgo = stats.lastInvokedAt ? relativeAgo(stats.lastInvokedAt) : '—';

  return (
    <div class="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        class="w-full flex items-center justify-between gap-2 text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      >
        <span class="flex items-center gap-2 tabular-nums">
          <span class="text-[var(--color-accent)] font-semibold">{stats.invocations}</span>
          <span>{stats.invocations === 1 ? 'run' : 'runs'} · {totalSec}s total · avg {avgSec}s · last {lastAgo}</span>
        </span>
        <ChevronDown size={10} class={['shrink-0 transition-transform', open ? '' : '-rotate-90'].join(' ')} />
      </button>
      {open && (
        <div class="space-y-1 text-[10px] text-[var(--color-text-faint)] pl-2 border-l border-[var(--color-border)]">
          {stats.recentTasks.map((t, i) => (
            <div key={i} class="truncate">
              <span class="font-mono tabular-nums text-[var(--color-text-muted)]">
                {relativeAgo(t.when)}
              </span>
              <span class="text-[var(--color-text-faint)] mx-1">·</span>
              <span class="font-mono uppercase text-[9px] text-[var(--color-accent)]/70">
                {t.tier}
              </span>
              <span class="text-[var(--color-text-faint)] mx-1">·</span>
              <span class="tabular-nums">{Math.round(t.durationMs / 1000)}s</span>
              <span class="text-[var(--color-text-faint)] mx-1">·</span>
              {t.preview.length > 80 ? t.preview.slice(0, 80) + '…' : t.preview}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function relativeAgo(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
