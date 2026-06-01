import { useState } from 'preact/hooks';
import { Check, Pipette, RotateCcw } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Toggle } from '@/components/Toggle';
import { CardGroup, CardRow } from '@/components/CardGroup';
import { useFetch } from '@/lib/useFetch';
import { apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import {
  theme, themeMeta, setTheme, type ThemeName,
  customAccent, setCustomAccent,
  uiScale, setUiScale,
  showCosts, setShowCosts,
  bootAudioEnabled, setBootAudio,
} from '@/lib/theme';
import {
  workspaceName,
  setWorkspaceName,
  hotkeyMod,
  setHotkeyMod,
  type HotkeyMod,
} from '@/lib/personalization';

interface Health {
  killSwitches: Record<string, boolean>;
  killSwitchRefusals: Record<string, number>;
  model: string;
  contextPct: number;
}

interface SecurityStatus { [key: string]: any; }

const KILL_SWITCH_LABELS: Record<string, { label: string; description: string }> = {
  WARROOM_TEXT_ENABLED: {
    label: 'Text War Room',
    description: 'Allow multi-agent text meetings via /api/warroom/text/*',
  },
  WARROOM_VOICE_ENABLED: {
    label: 'Voice War Room',
    description: 'Allow voice meetings via Pipecat',
  },
  LLM_SPAWN_ENABLED: {
    label: 'LLM spawn',
    description: 'Allow Claude SDK calls (master switch)',
  },
  DASHBOARD_MUTATIONS_ENABLED: {
    label: 'Dashboard mutations',
    description: 'Allow non-GET requests (set to false to lock dashboard read-only)',
  },
  MISSION_AUTO_ASSIGN_ENABLED: {
    label: 'Mission auto-assign',
    description: 'Allow Haiku/Gemini classifier on /api/mission/tasks/auto-assign',
  },
  SCHEDULER_ENABLED: {
    label: 'Scheduler',
    description: 'Allow scheduled cron tasks to fire',
  },
};

const THEME_ORDER: ThemeName[] = ['ios-dark', 'graphite', 'midnight', 'crimson'];

export function Settings() {
  const health = useFetch<Health>('/api/health', 30_000);
  const security = useFetch<SecurityStatus>('/api/security/status', 60_000);

  const error = health.error || security.error;

  return (
    <div class="flex flex-col h-full">
      <PageHeader title="Settings" />

      {error && <PageState error={error} />}
      {(health.loading || security.loading) && !health.data && <PageState loading />}

      {health.data && (
        <div class="flex-1 overflow-y-auto px-5 md:px-6 py-4 space-y-7 max-w-2xl mx-auto w-full">

          <CardGroup
            title="WORKSPACE"
            footer="Identity for this dashboard. Stored in the database so it shows up in any browser pointed at this server."
          >
            <CardRow
              label="Name"
              description="Up to 32 characters. Empty resets to ClaudeClaw."
              value={<WorkspaceNameField />}
            />
            <CardRow
              label="Theme"
              description="Switches CSS variables across the app."
              value={<ThemePicker />}
            />
            <CardRow
              label="Custom accent"
              description="Override the theme's accent with any hex. Reset clears it."
              value={<AccentPicker />}
            />
          </CardGroup>

          <CardGroup
            title="DISPLAY"
            footer="Per-browser display preferences. Stored in localStorage, not per-workspace."
          >
            <CardRow
              label="UI scale"
              description="Zooms the whole app proportionally so layout stays correct."
              value={<ScalePicker />}
            />
            <CardRow
              label="Show costs"
              description="Hide if you're on a Claude Code subscription — costs only matter on the API path."
              value={
                <Toggle
                  on={showCosts.value}
                  onChange={() => setShowCosts(!showCosts.value)}
                  ariaLabel="Show costs"
                />
              }
            />
            <CardRow
              label="Boot Music & Voice"
              description="Plays AC/DC-style background music and ElevenLabs voice narration during the J.A.R.V.I.S. home boot sequence. Visuals always play."
              value={
                <Toggle
                  on={bootAudioEnabled.value}
                  onChange={() => setBootAudio(!bootAudioEnabled.value)}
                  ariaLabel="Enable boot audio"
                />
              }
            />
          </CardGroup>

          <CardGroup
            title="KEYBOARD"
            footer="Pick which modifier opens the command palette and quick-jump search."
          >
            <CardRow
              label="Search shortcut"
              description="Auto matches your platform — pick a value to override."
              value={<HotkeyPicker />}
            />
          </CardGroup>

          <SpecialistRoutingGroup />

          <CardGroup
            title="KILL SWITCHES"
            footer="Runtime feature gates. Toggling writes the flag to .env atomically; the runtime re-reads it within 1.5s so changes take effect without a restart."
          >
            {Object.entries(health.data.killSwitches).map(([key, on]) => {
              const meta = KILL_SWITCH_LABELS[key] || { label: key, description: '' };
              const refusals = health.data!.killSwitchRefusals[key] || 0;
              return (
                <KillSwitchRow
                  key={key}
                  switchKey={key}
                  label={meta.label}
                  description={meta.description}
                  on={on}
                  refusals={refusals}
                  onChange={() => health.refresh()}
                />
              );
            })}
          </CardGroup>

          <CardGroup
            title="READ-ONLY"
            footer="To toggle a kill switch, edit .env and set the relevant flag to true or false. The change takes effect within 1.5 seconds without a process restart."
          >
            <CardRow label="Default model" value={health.data.model || '—'} />
            <CardRow label="Context window" value={health.data.contextPct + '%'} />
          </CardGroup>

          <CardGroup title="ACKNOWLEDGEMENTS">
            <CardRow
              label="3D brain model"
              description="Detailed Human Brain Model, NIH 3D 3DPX-021161, CC-BY"
            />
          </CardGroup>

        </div>
      )}
    </div>
  );
}

// ── Specialist routing override ──────────────────────────────────────
// Per-callsign tier selector. Lets the user override the static tier
// from src/specialists.ts at runtime without a rebuild. Stored in the
// dashboard_settings KV under `specialist.<callsign>.tier`. Cleared by
// re-clicking the active button (back to default) or by picking the
// default tier explicitly.

interface SpecialistRow {
  callsign: string;
  tier: 'claw' | 'cloud' | 'local';
  defaultTier: 'claw' | 'cloud' | 'local';
  tierOverride: 'claw' | 'cloud' | 'local' | null;
  preferredModel: string;
  cloudModel: string | null;
  modelInUse: string | null;
  available: boolean;
}

function SpecialistRoutingGroup() {
  const list = useFetch<{ specialists: SpecialistRow[] }>('/api/specialists', 30_000);
  if (list.loading && !list.data) {
    return (
      <CardGroup title="SPECIALIST ROUTING" footer="Loading…">
        <div class="px-4 py-3 text-[12px] text-[var(--color-text-muted)]">Fetching specialists…</div>
      </CardGroup>
    );
  }
  if (list.error || !list.data) {
    return (
      <CardGroup title="SPECIALIST ROUTING" footer={list.error || 'Failed to load specialists'}>
        <div class="px-4 py-3 text-[12px] text-[var(--color-text-muted)]">Could not load specialists.</div>
      </CardGroup>
    );
  }
  return (
    <CardGroup
      title="SPECIALIST ROUTING"
      footer="Override where each specialist runs. Claw = local agentic loop via claw-code + Ollama (free). Local = direct Ollama call, no tool loop (vision and uncensored). Cloud = paid Anthropic SDK (only if the specialist has a cloudModel set). Click the active button to revert to default."
    >
      {list.data.specialists.map((s) => (
        <SpecialistRoutingRow key={s.callsign} spec={s} onChanged={list.refresh} />
      ))}
    </CardGroup>
  );
}

function SpecialistRoutingRow({ spec, onChanged }: { spec: SpecialistRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function setTier(target: 'claw' | 'cloud' | 'local') {
    setBusy(true);
    try {
      // Clicking the currently-active tier clears any override and reverts
      // to the spec's default (matters when default and override happen to
      // resolve to the same tier).
      const isActive = spec.tier === target;
      const payload = isActive && spec.tierOverride
        ? { tier: null }                              // clear override
        : isActive && !spec.tierOverride
          ? { tier: spec.defaultTier }                // no-op confirmation; harmless
          : { tier: target };                         // new override
      const res = await apiPost<{ ok?: boolean; error?: string }>(
        `/api/specialists/${spec.callsign}/tier`,
        payload,
      );
      if (res.ok) {
        pushToast({
          tone: 'success',
          title: payload.tier === null
            ? `${spec.callsign} reverted to default (${spec.defaultTier})`
            : `${spec.callsign} routed to ${payload.tier}`,
        });
        onChanged();
      } else {
        pushToast({ tone: 'error', title: 'Override failed', description: res.error || 'unknown error', durationMs: 6000 });
      }
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Override failed', description: err?.message || String(err), durationMs: 6000 });
    } finally {
      setBusy(false);
    }
  }
  const tiers: Array<{ key: 'claw' | 'local' | 'cloud'; label: string; available: boolean; hint: string }> = [
    { key: 'claw',  label: 'CLAW',  available: true,                  hint: 'Local claw-code agentic loop + Ollama' },
    { key: 'local', label: 'LOCAL', available: true,                  hint: 'Direct Ollama call, no tool loop' },
    { key: 'cloud', label: 'CLOUD', available: !!spec.cloudModel,     hint: spec.cloudModel ? `Paid Anthropic SDK (${spec.cloudModel})` : 'No cloudModel configured' },
  ];
  return (
    <div class="flex items-start gap-3 px-4 py-3.5">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-0.5">
          <span class="text-[14px] font-medium text-[var(--color-text)] capitalize">{spec.callsign}</span>
          {spec.tierOverride && (
            <span class="text-[9.5px] font-mono uppercase tracking-[0.14em] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/40 text-[var(--color-accent)]">
              override active
            </span>
          )}
        </div>
        <div class="text-[11.5px] text-[var(--color-text-faint)] leading-snug">
          default: <span class="font-mono uppercase">{spec.defaultTier}</span>
          {' · '}
          model: <span class="font-mono">{spec.modelInUse || spec.preferredModel}</span>
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        {tiers.map((t) => {
          const active = spec.tier === t.key;
          const disabled = busy || !t.available;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => !disabled && setTier(t.key)}
              disabled={disabled}
              title={t.hint}
              class={[
                'inline-flex items-center px-2.5 py-1 rounded-md text-[10.5px] font-mono uppercase tracking-[0.12em] border transition-colors',
                active
                  ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'bg-[var(--color-card)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
                disabled ? 'opacity-40 cursor-not-allowed' : '',
              ].join(' ')}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Workspace name field ──────────────────────────────────────────────

function WorkspaceNameField() {
  const [savedTick, setSavedTick] = useState(false);
  const value = workspaceName.value;
  function onInput(e: Event) {
    const next = (e.target as HTMLInputElement).value;
    setWorkspaceName(next);
    setSavedTick(true);
    // Brief checkmark cue. The signal updates instantly; the PATCH is
    // debounced 600ms inside personalization.ts.
    window.setTimeout(() => setSavedTick(false), 1500);
  }
  return (
    <div class="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onInput={onInput}
        maxLength={32}
        placeholder="ClaudeClaw"
        class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] w-[200px]"
      />
      {savedTick && <Check size={14} class="text-[var(--color-status-done)] shrink-0" />}
    </div>
  );
}

// ── Theme picker ──────────────────────────────────────────────────────

function ThemePicker() {
  return (
    <div class="flex items-center gap-1.5">
      {THEME_ORDER.map((name) => {
        const active = theme.value === name;
        const meta = themeMeta[name];
        return (
          <button
            key={name}
            type="button"
            onClick={() => setTheme(name)}
            class={[
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12.5px] border transition-colors',
              active
                ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-text)]'
                : 'bg-[var(--color-card)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
            ].join(' ')}
          >
            <div
              class="w-3.5 h-3.5 rounded-sm shrink-0"
              style={{ background: meta.swatch, border: '1px solid var(--color-border)' }}
            />
            {meta.label}
            {active && <Check size={12} class="text-[var(--color-accent)]" />}
          </button>
        );
      })}
    </div>
  );
}

// ── Accent picker ─────────────────────────────────────────────────────

function AccentPicker() {
  const current = customAccent.value;
  const [draft, setDraft] = useState(current ?? '#');
  function commit(next: string) {
    if (/^#[0-9a-fA-F]{6}$/.test(next)) setCustomAccent(next);
  }
  return (
    <div class="flex items-center gap-2">
      <label
        class="relative inline-flex items-center justify-center w-8 h-8 rounded border border-[var(--color-border)] cursor-pointer overflow-hidden"
        style={{ backgroundColor: current || 'var(--color-elevated)' }}
        title="Pick a color"
      >
        <Pipette size={13} class={current ? 'text-white mix-blend-difference' : 'text-[var(--color-text-faint)]'} />
        <input
          type="color"
          value={current || '#8b8af0'}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value.toLowerCase();
            setDraft(v); commit(v);
          }}
          class="absolute inset-0 opacity-0 cursor-pointer"
        />
      </label>
      <input
        type="text"
        value={draft}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setDraft(v);
          if (/^#[0-9a-fA-F]{6}$/.test(v)) setCustomAccent(v);
        }}
        placeholder="#8b8af0"
        maxLength={7}
        class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] w-[110px]"
      />
      {current && (
        <button
          type="button"
          onClick={() => { setCustomAccent(null); setDraft('#'); }}
          class="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] border border-[var(--color-border)] transition-colors"
          title="Restore theme accent"
        >
          <RotateCcw size={11} /> Reset
        </button>
      )}
    </div>
  );
}

// ── UI scale picker ───────────────────────────────────────────────────

const SCALE_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0.95, label: '95%' },
  { value: 1.00, label: '100%' },
  { value: 1.10, label: '110%' },
  { value: 1.25, label: '125%' },
  { value: 1.50, label: '150%' },
];

function ScalePicker() {
  const current = uiScale.value;
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      {SCALE_PRESETS.map((p) => {
        const active = Math.abs(current - p.value) < 0.001;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => setUiScale(p.value)}
            class={[
              'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12.5px] border transition-colors tabular-nums',
              active
                ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-text)]'
                : 'bg-[var(--color-card)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
            ].join(' ')}
          >
            {p.label}
            {active && <Check size={12} class="text-[var(--color-accent)]" />}
          </button>
        );
      })}
    </div>
  );
}

// ── Hotkey picker ─────────────────────────────────────────────────────

function HotkeyPicker() {
  const current = hotkeyMod.value;
  const opts: { v: HotkeyMod; label: string; hint: string }[] = [
    { v: 'auto', label: 'Auto', hint: '⌘ on Mac, Ctrl elsewhere' },
    { v: 'meta', label: '⌘ Cmd / Meta', hint: 'Mac standard' },
    { v: 'ctrl', label: 'Ctrl', hint: 'Windows / Linux standard' },
  ];
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      {opts.map((o) => {
        const active = current === o.v;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => setHotkeyMod(o.v)}
            class={[
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12.5px] border transition-colors',
              active
                ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-text)]'
                : 'bg-[var(--color-card)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
            ].join(' ')}
            title={o.hint}
          >
            {o.label}
            {active && <Check size={12} class="text-[var(--color-accent)]" />}
          </button>
        );
      })}
    </div>
  );
}

// ── Kill switch row ──────────────────────────────────────────────────

interface KillSwitchRowProps {
  switchKey: string;
  label: string;
  description: string;
  on: boolean;
  refusals: number;
  onChange: () => void;
}

function KillSwitchRow({ switchKey, label, description, on, refusals, onChange }: KillSwitchRowProps) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    const newValue = !on;
    if (!newValue && switchKey === 'DASHBOARD_MUTATIONS_ENABLED') {
      if (!confirm('Disabling dashboard mutations will lock this dashboard read-only. Every non-GET request will return 503 until you re-enable it (which means you cannot use this UI to turn it back on — you have to edit .env directly). Continue?')) {
        return;
      }
    }
    if (!newValue && switchKey === 'LLM_SPAWN_ENABLED') {
      if (!confirm('Disabling LLM_SPAWN_ENABLED will stop every Claude SDK call across all agents. Mission tasks, scheduled tasks, and agent replies will all stop firing. Continue?')) {
        return;
      }
    }
    setBusy(true);
    try {
      await apiPost('/api/security/kill-switch', { key: switchKey, enabled: newValue });
      pushToast({
        tone: newValue ? 'success' : 'warn',
        title: label + ' ' + (newValue ? 'enabled' : 'disabled'),
        description: 'Takes effect within 1.5s.',
      });
      // Wait a tick for the kill-switches re-read window so the next
      // refresh shows the new state.
      setTimeout(onChange, 1700);
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Toggle failed', description: err?.message || String(err), durationMs: 6000 });
    } finally { setBusy(false); }
  }
  return (
    <div class="flex items-start gap-3 px-4 py-3.5">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-0.5">
          <span class="text-[15px] font-medium text-[var(--color-text)]">{label}</span>
          <code class="text-[10.5px] text-[var(--color-text-faint)] font-mono">{switchKey}</code>
        </div>
        <div class="text-[12px] text-[var(--color-text-faint)] leading-snug">{description}</div>
        {refusals > 0 && (
          <div class="text-[11px] text-[var(--color-status-failed)] mt-1 tabular-nums">
            {refusals} refusals since startup
          </div>
        )}
      </div>
      <Toggle on={on} onChange={toggle} disabled={busy} ariaLabel={label} />
    </div>
  );
}
