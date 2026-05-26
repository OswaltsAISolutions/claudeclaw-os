// SpecialistFloor — the "Mission Control room" view of the 10 specialists.
//
// Why this exists alongside the /specialists page: that page is the static
// roster + config surface (tier overrides, ad-hoc dispatch, model details).
// The Floor is the LIVE OPERATIONS view: a Factorio-style grid of station
// cards that show who is working, who is idle, what they just did, and
// when they last fired. Real data only, polled every 8 seconds.
//
// Visual taste anchor: Factorio-style rooms wearing an iOS skin (bubbly
// icons, smooth type, glass surfaces, real data only). Per the user's
// pinned feedback_visual_taste memory.

import { useMemo } from 'preact/hooks';
import {
  Crosshair, Zap, Clock, Wrench, CircleDot,
  Cloud, Cpu, Sparkles,
} from 'lucide-preact';
import { useFetch } from '@/lib/useFetch';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { formatRelativeTime } from '@/lib/format';

interface Specialist {
  callsign: string;
  tier: 'local' | 'claw' | 'cloud';
  defaultTier: 'local' | 'claw' | 'cloud';
  tierOverride: string | null;
  role: string;
  preferredModel: string;
  fallbackModels: string[];
  capabilities: string[];
  vramHintGB: number;
  temperature: number;
  contextTokens: number;
  available: boolean;
  modelInUse: string | null;
  fellBackFrom: string | null;
}

interface SpecialistStats {
  callsign: string;
  invocations: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalToolCalls: number;
  lastInvokedAt: number | null;
  lastModel: string | null;
  recentTasks: Array<{ when: number; preview: string; durationMs: number; tier: string }>;
}

// Tier badge color + icon — distinguishes claw (local agentic), local
// (direct Ollama, no tools), and cloud (Anthropic SDK) at a glance.
function TierBadge({ tier }: { tier: 'local' | 'claw' | 'cloud' }) {
  const props = tier === 'cloud'
    ? { Icon: Cloud, label: 'cloud', cls: 'bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' }
    : tier === 'claw'
    ? { Icon: Wrench, label: 'claw', cls: 'bg-[color-mix(in_srgb,var(--color-status-running)_15%,transparent)] text-[var(--color-status-running)]' }
    : { Icon: Cpu, label: 'local', cls: 'bg-[var(--color-elevated)] text-[var(--color-text-muted)]' };
  const { Icon, label, cls } = props;
  return (
    <span class={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium ${cls}`}>
      <Icon size={10} />
      {label}
    </span>
  );
}

// Status dot driven by liveness signals: available (model resolved), and
// recency of last invocation. Green = active in last 5 min, amber = idle
// but ready, gray = offline (no resolved model).
function StatusDot({ spec, stats }: { spec: Specialist; stats?: SpecialistStats }) {
  let color: string;
  let label: string;
  if (!spec.available) {
    color = 'bg-[var(--color-text-faint)]';
    label = 'offline';
  } else if (stats?.lastInvokedAt && Date.now() / 1000 - stats.lastInvokedAt < 300) {
    color = 'bg-[var(--color-status-running)]';
    label = 'active';
  } else {
    color = 'bg-[var(--color-status-done)]';
    label = 'ready';
  }
  return (
    <span class="inline-flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-faint)]">
      <span class={`size-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function SpecialistCard({ spec, stats }: { spec: Specialist; stats?: SpecialistStats }) {
  const lastFire = stats?.lastInvokedAt
    ? formatRelativeTime(stats.lastInvokedAt)
    : 'never';
  const avgMs = stats?.avgDurationMs ?? 0;
  const calls = stats?.totalToolCalls ?? 0;
  const inv = stats?.invocations ?? 0;

  return (
    <div class="glass rounded-2xl border border-[var(--color-border)] p-3.5 flex flex-col gap-2.5 hover:border-[var(--color-border-strong)] transition-colors">
      {/* Header: callsign + tier + status */}
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <Sparkles size={11} class="text-[var(--color-accent)] shrink-0" />
            <span class="text-[13.5px] font-semibold text-[var(--color-text)] truncate">{spec.callsign}</span>
            <TierBadge tier={spec.tier} />
          </div>
          <div class="text-[11px] text-[var(--color-text-faint)] mt-0.5 line-clamp-1">
            {spec.role}
          </div>
        </div>
        <StatusDot spec={spec} stats={stats} />
      </div>

      {/* Model in use + telemetry strip */}
      <div class="flex items-center gap-3 text-[10.5px] text-[var(--color-text-muted)]">
        <span class="font-mono truncate flex-1 min-w-0" title={spec.modelInUse || spec.preferredModel}>
          {spec.modelInUse || spec.preferredModel || 'no model'}
        </span>
      </div>

      {/* Stats row */}
      <div class="grid grid-cols-3 gap-1.5">
        <Stat label="Calls 24h" value={inv} icon={Crosshair} />
        <Stat label="Tools" value={calls} icon={Zap} />
        <Stat label="Avg ms" value={avgMs > 0 ? formatMs(avgMs) : '—'} icon={Clock} />
      </div>

      {/* Recent tasks */}
      <div class="mt-1">
        <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] mb-1">
          Recent
        </div>
        {stats?.recentTasks && stats.recentTasks.length > 0 ? (
          <ul class="space-y-1">
            {stats.recentTasks.slice(0, 3).map((t) => (
              <li class="flex items-baseline gap-2 text-[11px] text-[var(--color-text-muted)]">
                <CircleDot size={8} class="text-[var(--color-text-faint)] shrink-0 mt-1" />
                <span class="truncate flex-1 min-w-0" title={t.preview}>{t.preview}</span>
                <span class="text-[10px] text-[var(--color-text-faint)] tabular-nums shrink-0">
                  {formatRelativeTime(t.when)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div class="text-[11px] text-[var(--color-text-faint)]">No invocations in the last 24h.</div>
        )}
      </div>

      {/* Footer: last fire + fallback note */}
      <div class="text-[10px] text-[var(--color-text-faint)] flex items-center gap-2 mt-0.5 pt-2 border-t border-[var(--color-border)]">
        <span>Last fire: {lastFire}</span>
        {spec.fellBackFrom && (
          <Pill tone="warn">fallback {spec.fellBackFrom}</Pill>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string | number; icon: any }) {
  return (
    <div class="bg-[var(--color-elevated)] rounded-lg px-2 py-1.5 flex flex-col">
      <div class="flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-[var(--color-text-faint)]">
        <Icon size={9} />
        {label}
      </div>
      <div class="text-[12px] font-semibold text-[var(--color-text)] tabular-nums">{value}</div>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SpecialistFloor() {
  const roster = useFetch<{ specialists: Specialist[] }>('/api/specialists', 30_000);
  const statsResp = useFetch<{ hours: number; stats: SpecialistStats[] }>('/api/specialists/stats?hours=24', 8_000);

  const statsBy = useMemo(() => {
    const m = new Map<string, SpecialistStats>();
    for (const s of statsResp.data?.stats ?? []) m.set(s.callsign, s);
    return m;
  }, [statsResp.data]);

  if (roster.loading && !roster.data) return <PageState loading />;
  if (roster.error) return <PageState error={roster.error} />;

  const specs = roster.data?.specialists ?? [];
  const online = specs.filter((s) => s.available).length;
  // Active = invoked in last 5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  const active = specs.filter((s) => {
    const st = statsBy.get(s.callsign);
    return st?.lastInvokedAt && nowSec - st.lastInvokedAt < 300;
  }).length;
  const totalCalls24h = specs.reduce((acc, s) => acc + (statsBy.get(s.callsign)?.invocations ?? 0), 0);
  const totalTools24h = specs.reduce((acc, s) => acc + (statsBy.get(s.callsign)?.totalToolCalls ?? 0), 0);

  return (
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-6xl mx-auto px-4 md:px-6 py-5 space-y-5">
        {/* Floor overview strip */}
        <div class="glass rounded-2xl border border-[var(--color-border)] px-4 py-3 flex items-center gap-5 flex-wrap">
          <div class="flex items-center gap-2">
            <Crosshair size={15} class="text-[var(--color-accent)]" />
            <div class="text-[13px] font-semibold text-[var(--color-text)]">Specialist Floor</div>
          </div>
          <div class="flex items-center gap-4 ml-auto text-[11.5px] text-[var(--color-text-muted)]">
            <span><b class="text-[var(--color-text)] tabular-nums">{online}</b>/{specs.length} online</span>
            <span><b class="text-[var(--color-status-running)] tabular-nums">{active}</b> active now</span>
            <span><b class="text-[var(--color-text)] tabular-nums">{totalCalls24h}</b> calls / 24h</span>
            <span><b class="text-[var(--color-text)] tabular-nums">{totalTools24h}</b> tools / 24h</span>
          </div>
        </div>

        {/* Grid of stations */}
        {specs.length === 0 ? (
          <div class="text-center py-16 text-[13px] text-[var(--color-text-faint)]">
            No specialists configured.
          </div>
        ) : (
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {specs.map((spec) => (
              <SpecialistCard
                key={spec.callsign}
                spec={spec}
                stats={statsBy.get(spec.callsign)}
              />
            ))}
          </div>
        )}

        {/* Refresh footer */}
        <div class="text-[10px] text-[var(--color-text-faint)] text-center pt-2">
          Roster polls every 30s, stats every 8s. Click a card on the Specialists page for full history.
        </div>
      </div>
    </div>
  );
}
