import { useEffect, useRef, useState } from 'preact/hooks';
import { Camera, Trash2, ExternalLink, Play, Pause, Eraser, ArrowDown, Send } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Pill, StatusDot } from '@/components/Pill';
import { Tab } from '@/components/PageHeader';
import { useFetch } from '@/lib/useFetch';
import { formatRelativeTime, formatCost } from '@/lib/format';
import { chatId, dashboardToken } from '@/lib/api';
import { apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { showCosts } from '@/lib/theme';

interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  running: boolean;
  todayTurns: number;
  todayCost: number;
}

interface ConvoTurn { role: 'user' | 'assistant'; content: string; created_at?: number; }
interface ScheduledTask { id: string; prompt: string; schedule: string; next_run: number; status: string; last_status: string | null; }
interface HiveEntry { id: number; action: string; summary: string; created_at: number; }
interface AgentTokens { todayCost: number; todayTurns: number; allTimeCost: number; }

type TabKey = 'overview' | 'send' | 'conversation' | 'tasks' | 'hive' | 'logs';

interface Props {
  agent: Agent | null;
  onClose: () => void;
}

export function AgentDetail({ agent, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  if (!agent) return null;

  return (
    <Modal open={!!agent} onClose={onClose} title="" width={720}>
      <Header agent={agent} />
      <div class="flex items-center gap-1 border-b border-[var(--color-border)] mb-4 -mx-5 px-5 pb-2">
        <Tab label="Overview" active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} />
        <Tab label="Send" active={activeTab === 'send'} onClick={() => setActiveTab('send')} />
        <Tab label="Conversation" active={activeTab === 'conversation'} onClick={() => setActiveTab('conversation')} />
        <Tab label="Scheduled" active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} />
        <Tab label="Hive Mind" active={activeTab === 'hive'} onClick={() => setActiveTab('hive')} />
        <Tab label="Logs" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} />
      </div>

      {activeTab === 'overview' && <OverviewTab agent={agent} />}
      {activeTab === 'send' && <SendTab agent={agent} />}
      {activeTab === 'conversation' && <ConversationTab agentId={agent.id} />}
      {activeTab === 'tasks' && <TasksTab agentId={agent.id} />}
      {activeTab === 'hive' && <HiveTab agentId={agent.id} />}
      {activeTab === 'logs' && <LogsTab agentId={agent.id} />}
    </Modal>
  );
}

function Header({ agent }: { agent: Agent }) {
  // Cache-bust the avatar by bumping a counter every time we upload or
  // delete — the AgentAvatar component reads `?token=...` only and
  // would otherwise serve the stale cached image.
  const [avatarVersion, setAvatarVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pickAndUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      pushToast({ tone: 'error', title: 'Image too large', description: 'Max 5 MB.', durationMs: 6000 });
      input.value = '';
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/avatar?token=${encodeURIComponent(dashboardToken)}`, {
        method: 'PUT',
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error || `HTTP ${res.status}`);
      }
      setAvatarVersion((v) => v + 1);
      pushToast({
        tone: 'success',
        title: 'Avatar updated',
        description: 'Telegram propagation needs @BotFather → /setuserpic on your phone.',
        durationMs: 8000,
      });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Upload failed', description: err?.message || String(err), durationMs: 7000 });
    } finally {
      setBusy(false);
      input.value = '';
    }
  }

  async function clearAvatar() {
    if (!confirm(`Remove the custom avatar for ${agent.id}? The dashboard will fall back to Telegram's avatar (if set) or initials.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/avatar?token=${encodeURIComponent(dashboardToken)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error || `HTTP ${res.status}`);
      }
      setAvatarVersion((v) => v + 1);
      pushToast({ tone: 'success', title: 'Avatar removed' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err), durationMs: 7000 });
    } finally { setBusy(false); }
  }

  function openBotFather() {
    // Deep-links to BotFather in the Telegram app (or web) so the user
    // can finish the loop with /setuserpic. The actual upload to
    // BotFather can't be automated via the Bot API.
    window.open('https://t.me/BotFather', '_blank', 'noreferrer');
  }

  return (
    <div class="flex items-start gap-3 mb-4 -mt-2">
      <div class="relative shrink-0 group">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          class="relative block rounded-full focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none disabled:opacity-50"
          title="Change avatar"
        >
          {/* cacheBust appends ?v=<n> to the avatar URL so the browser
              skips its 1h HTTP cache and refetches after upload/delete.
              Without this, the new image bytes are on disk but every
              IMG element across the dashboard keeps showing the old
              cached PNG until the cache expires. */}
          <AgentAvatar
            agentId={agent.id}
            name={agent.name}
            running={agent.running}
            size={44}
            cacheBust={avatarVersion}
          />
          <span class="absolute inset-0 rounded-full flex items-center justify-center bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity">
            <Camera size={16} />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={pickAndUpload}
          class="hidden"
        />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <StatusDot tone={agent.running ? 'done' : 'cancelled'} />
          <h2 class="text-[15px] font-semibold text-[var(--color-text)] truncate">{agent.name || agent.id}</h2>
          <code class="text-[10px] text-[var(--color-text-faint)] font-mono">{agent.id}</code>
        </div>
        {agent.description && (
          <div class="text-[12px] text-[var(--color-text-muted)] mt-0.5 leading-snug">{agent.description}</div>
        )}
        <div class="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] border border-[var(--color-border)] transition-colors disabled:opacity-40"
          >
            <Camera size={11} /> {busy ? 'Working…' : 'Change avatar'}
          </button>
          <button
            type="button"
            onClick={clearAvatar}
            disabled={busy}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] border border-[var(--color-border)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
            title="Remove custom avatar (revert to Telegram or initials)"
          >
            <Trash2 size={11} />
          </button>
          <button
            type="button"
            onClick={openBotFather}
            class="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
            title="Telegram bot avatars can only be set via @BotFather → /setuserpic"
          >
            Set on Telegram <ExternalLink size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface AgentDetails {
  running: boolean;
  activeState: string | null;
  subState: string | null;
  uptimeSec: number | null;
  restartCount: number | null;
  mainPid: number | null;
  memBytes: number | null;
  lastActivityAt: number | null;
  lastError: string | null;
}

function OverviewTab({ agent }: { agent: Agent }) {
  const tokens = useFetch<AgentTokens>(`/api/agents/${agent.id}/tokens`);
  const [details, setDetails] = useState<AgentDetails | null>(null);
  const [detailsErr, setDetailsErr] = useState<string | null>(null);
  const costsOn = showCosts.value;

  // Poll the rich runtime endpoint every 5s while the tab is mounted.
  // The endpoint shells out to systemctl + journalctl so we keep the
  // cadence gentle.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    async function tick() {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(agent.id)}/details?token=${encodeURIComponent(dashboardToken)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as AgentDetails;
        if (alive) { setDetails(data); setDetailsErr(null); }
      } catch (err: any) {
        if (alive) setDetailsErr(err?.message || String(err));
      } finally {
        if (alive) timer = window.setTimeout(tick, 5000);
      }
    }
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [agent.id]);

  return (
    <div class="space-y-3">
      <div class={(costsOn ? 'grid-cols-3' : 'grid-cols-1') + ' grid gap-2'}>
        <Kpi label="Today turns" value={String(agent.todayTurns)} />
        {costsOn && <Kpi label="Today cost" value={formatCost(agent.todayCost)} />}
        {costsOn && <Kpi label="Lifetime cost" value={formatCost(tokens.data?.allTimeCost || 0)} />}
      </div>

      <Section label="Runtime">
        <Row label="Status">
          {details
            ? <RuntimeStatusPill details={details} fallbackRunning={agent.running} />
            : (agent.running ? <Pill tone="done">running</Pill> : <Pill tone="cancelled">offline</Pill>)}
        </Row>
        <Row label="Uptime">
          <span class="text-[var(--color-text)] tabular-nums">
            {details?.uptimeSec != null ? formatUptime(details.uptimeSec) : '—'}
          </span>
        </Row>
        <Row label="Last activity">
          <span class="text-[var(--color-text)] tabular-nums">
            {details?.lastActivityAt ? formatRelativeTime(details.lastActivityAt) : '—'}
          </span>
        </Row>
        <Row label="Restarts">
          <span class="text-[var(--color-text)] tabular-nums">
            {details?.restartCount != null ? String(details.restartCount) : '—'}
          </span>
        </Row>
        <Row label="Memory">
          <span class="text-[var(--color-text)] tabular-nums">
            {details?.memBytes != null ? formatBytes(details.memBytes) : '—'}
          </span>
        </Row>
        <Row label="PID">
          <span class="text-[var(--color-text-muted)] font-mono text-[11px]">
            {details?.mainPid != null ? String(details.mainPid) : '—'}
          </span>
        </Row>
      </Section>

      <Section label="Configuration">
        <Row label="Model"><Pill tone="neutral">{agent.model || 'default'}</Pill></Row>
        <Row label="Service">
          <span class="text-[var(--color-text-muted)] font-mono text-[10.5px]">
            {agent.id === 'main' ? 'com.claudeclaw.main.service' : `com.claudeclaw.agent-${agent.id}.service`}
          </span>
        </Row>
      </Section>

      {details?.lastError && (
        <Section label="Last error">
          <div class="text-[10.5px] font-mono text-[var(--color-status-failed)] whitespace-pre-wrap break-all">
            {details.lastError}
          </div>
        </Section>
      )}

      {detailsErr && !details && (
        <div class="text-[10.5px] text-[var(--color-text-faint)] font-mono">
          Details endpoint: {detailsErr}
        </div>
      )}
    </div>
  );
}

function RuntimeStatusPill({ details, fallbackRunning }: { details: AgentDetails; fallbackRunning: boolean }) {
  const active = details.activeState || (details.running || fallbackRunning ? 'active' : 'inactive');
  const sub = details.subState;
  const tone: 'done' | 'cancelled' | 'failed' | 'neutral' =
    active === 'active' ? 'done'
    : active === 'failed' ? 'failed'
    : active === 'activating' || active === 'reloading' ? 'neutral'
    : 'cancelled';
  const label = sub && sub !== 'running' && sub !== 'dead' ? `${active} (${sub})` : active;
  return <Pill tone={tone}>{label}</Pill>;
}

function formatUptime(sec: number): string {
  if (sec < 0) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ConversationTab({ agentId }: { agentId: string }) {
  const { data, loading, error } = useFetch<{ turns: ConvoTurn[] }>(
    `/api/agents/${agentId}/conversation?chatId=${encodeURIComponent(chatId)}&limit=10`,
  );
  const turns = data?.turns ?? [];

  if (loading) return <Loading />;
  if (error) return <ErrorBlock error={error} />;
  if (turns.length === 0) return <Empty text="No conversation history yet." />;

  return (
    <div class="space-y-2">
      {turns.map((t, i) => (
        <div
          key={i}
          class={[
            'rounded-lg px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap',
            t.role === 'user'
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)] border border-[var(--color-accent-soft)]'
              : 'bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-muted)]',
          ].join(' ')}
        >
          <div class="text-[10px] text-[var(--color-text-faint)] uppercase tracking-wider mb-1">
            {t.role}
            {t.created_at && <span class="ml-2 normal-case tracking-normal">{formatRelativeTime(t.created_at)}</span>}
          </div>
          <div class="line-clamp-6">{t.content}</div>
        </div>
      ))}
    </div>
  );
}

function TasksTab({ agentId }: { agentId: string }) {
  const { data, loading, error } = useFetch<{ tasks: ScheduledTask[] }>(`/api/agents/${agentId}/tasks`);
  const tasks = data?.tasks ?? [];

  if (loading) return <Loading />;
  if (error) return <ErrorBlock error={error} />;
  if (tasks.length === 0) return <Empty text={`No scheduled tasks for ${agentId}.`} />;

  return (
    <div class="space-y-1.5">
      {tasks.map((t) => (
        <div key={t.id} class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-2.5">
          <div class="text-[12px] text-[var(--color-text)] line-clamp-2 mb-1">{t.prompt}</div>
          <div class="flex items-center gap-2 text-[10.5px] text-[var(--color-text-faint)]">
            <span class="font-mono">{t.schedule}</span>
            <span>·</span>
            <span class="tabular-nums">next: {formatRelativeTime(t.next_run)}</span>
            <Pill tone={t.status === 'paused' ? 'cancelled' : 'done'}>{t.status}</Pill>
            {t.last_status && (
              <Pill tone={t.last_status === 'success' ? 'done' : 'failed'}>last: {t.last_status}</Pill>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function HiveTab({ agentId }: { agentId: string }) {
  const { data, loading, error } = useFetch<{ entries: HiveEntry[] }>(`/api/hive-mind?agent=${agentId}&limit=30`);
  const entries = data?.entries ?? [];

  if (loading) return <Loading />;
  if (error) return <ErrorBlock error={error} />;
  if (entries.length === 0) return <Empty text={`No hive mind activity for ${agentId} yet.`} />;

  return (
    <div class="space-y-1">
      {entries.map((e) => (
        <div key={e.id} class="flex items-start gap-3 px-3 py-2 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded text-[11.5px]">
          <span class="text-[var(--color-text-faint)] tabular-nums whitespace-nowrap shrink-0">
            {formatRelativeTime(e.created_at)}
          </span>
          <span class="font-mono text-[10.5px] text-[var(--color-text-muted)] whitespace-nowrap shrink-0">
            {e.action}
          </span>
          <span class="text-[var(--color-text)] line-clamp-2">{e.summary}</span>
        </div>
      ))}
    </div>
  );
}

function SendTab({ agent }: { agent: Agent }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(5);
  const [busy, setBusy] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);

  async function send() {
    const titleTrimmed = title.trim();
    const promptTrimmed = prompt.trim();
    if (!promptTrimmed) {
      pushToast({ tone: 'warn', title: 'Prompt required' });
      return;
    }
    setBusy(true);
    try {
      const res = await apiPost<{ task: { id: string } }>('/api/mission/tasks/create', {
        title: titleTrimmed || promptTrimmed.slice(0, 80),
        prompt: promptTrimmed,
        assigned_agent: agent.id,
        priority,
      });
      setLastTaskId(res.task.id);
      setTitle('');
      setPrompt('');
      pushToast({
        tone: 'success',
        title: `Task queued for ${agent.name || agent.id}`,
        description: `Task ID: ${res.task.id}. It'll pick this up within ~60s.`,
        durationMs: 6000,
      });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Send failed', description: err?.message || String(err), durationMs: 7000 });
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // Cmd/Ctrl+Enter to fire.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!busy) send();
    }
  }

  return (
    <div class="space-y-3">
      <div class="text-[11.5px] text-[var(--color-text-muted)]">
        Fire a one-off task to <b class="text-[var(--color-text)]">{agent.name || agent.id}</b>.
        It gets queued in the mission system and the agent picks it up within ~60 seconds.
      </div>

      <Field label="Title" hint="Short label for the dashboard (optional — auto-generated from prompt if blank)">
        <input
          type="text"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          placeholder="Research latest abliterated 32B models"
          maxLength={200}
          class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </Field>

      <Field label="Prompt" hint="Cmd/Ctrl+Enter to send">
        <textarea
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          rows={6}
          placeholder="What do you want this agent to do?"
          maxLength={10000}
          class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] resize-vertical font-mono"
        />
      </Field>

      <div class="flex items-center gap-3">
        <Field label="Priority">
          <select
            value={String(priority)}
            onChange={(e) => setPriority(parseInt((e.target as HTMLSelectElement).value, 10))}
            class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="0">0 (low)</option>
            <option value="3">3</option>
            <option value="5">5 (normal)</option>
            <option value="7">7</option>
            <option value="10">10 (urgent)</option>
          </select>
        </Field>

        <div class="flex-1" />
        <button
          type="button"
          onClick={send}
          disabled={busy || !prompt.trim()}
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send size={12} /> {busy ? 'Queueing…' : 'Send task'}
        </button>
      </div>

      {lastTaskId && (
        <div class="text-[11px] text-[var(--color-text-faint)] font-mono">
          Last queued: {lastTaskId}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: any }) {
  return (
    <div>
      <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">{label}</label>
      {children}
      {hint && <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1">{hint}</div>}
    </div>
  );
}

interface LogLine { t: number; text: string; isStderr: boolean; }

function LogsTab({ agentId }: { agentId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'closed'>('connecting');
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // EventSource only allows GET, no custom headers — token is required
    // in the query string to pass through the dashboard's auth gate.
    const url = `/api/agents/${encodeURIComponent(agentId)}/logs?token=${encodeURIComponent(dashboardToken)}`;
    const es = new EventSource(url);
    setStatus('connecting');

    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus('error');
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      const text = ev.data.replace(/\\n/g, '\n');
      const isStderr = text.startsWith('[stderr]') || text.startsWith('[spawn error]');
      setLines((prev) => {
        const next = [...prev, { t: Date.now(), text, isStderr }];
        // Keep last 2000 lines so the DOM doesn't explode on long sessions.
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    };

    return () => { es.close(); setStatus('closed'); };
  }, [agentId]);

  useEffect(() => {
    if (!autoscroll || paused) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoscroll, paused]);

  function clear() { setLines([]); }
  function jumpToBottom() {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoscroll(true);
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2 text-[11px]">
        <span class={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${
          status === 'live' ? 'bg-[var(--color-status-done)]/15 text-[var(--color-status-done)]' :
          status === 'error' ? 'bg-[var(--color-status-failed)]/15 text-[var(--color-status-failed)]' :
          'bg-[var(--color-elevated)] text-[var(--color-text-muted)]'
        }`}>
          <span class="w-1.5 h-1.5 rounded-full" style={{
            backgroundColor: status === 'live' ? 'var(--color-status-done)' :
              status === 'error' ? 'var(--color-status-failed)' :
              'var(--color-text-faint)',
          }}/>
          {status}
        </span>
        <span class="text-[var(--color-text-faint)] tabular-nums">{lines.length} lines</span>
        <div class="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] transition-colors"
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <Play size={11} /> : <Pause size={11} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={jumpToBottom}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] transition-colors"
            title="Jump to bottom"
          >
            <ArrowDown size={11} />
          </button>
          <button
            type="button"
            onClick={clear}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] transition-colors"
            title="Clear screen"
          >
            <Eraser size={11} /> Clear
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          // If the user scrolls away from the bottom, pause autoscroll.
          // If they scroll back to the bottom, re-enable.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          if (atBottom !== autoscroll) setAutoscroll(atBottom);
        }}
        class="font-mono text-[11px] leading-snug bg-[#0a0a0a] border border-[var(--color-border)] rounded p-2 overflow-y-auto"
        style={{ height: '420px' }}
      >
        {lines.length === 0 && (
          <div class="text-[var(--color-text-faint)] italic">
            {status === 'connecting' ? 'Connecting to log stream…' : 'No log lines yet.'}
          </div>
        )}
        {lines.map((l, i) => (
          <div
            key={i}
            class="whitespace-pre-wrap break-all"
            style={{ color: l.isStderr ? 'var(--color-status-failed)' : 'var(--color-text-muted)' }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tiny helpers ───────────────────────────────────────────────────

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-2.5">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-0.5">{label}</div>
      <div class="text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
    </div>
  );
}

function Section({ label, children }: any) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">{label}</div>
      <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3 space-y-1.5">
        {children}
      </div>
    </div>
  );
}

function Row({ label, children }: any) {
  return (
    <div class="flex items-center justify-between text-[12px]">
      <span class="text-[var(--color-text-muted)]">{label}</span>
      {children}
    </div>
  );
}

function Loading() { return <div class="text-[11px] text-[var(--color-text-faint)] py-6 text-center">Loading…</div>; }
function Empty({ text }: { text: string }) { return <div class="text-[11.5px] text-[var(--color-text-faint)] py-8 text-center">{text}</div>; }
function ErrorBlock({ error }: { error: string }) {
  return (
    <div class="text-[var(--color-status-failed)] text-[11.5px] font-mono p-3 bg-[var(--color-elevated)] border border-[var(--color-status-failed)] rounded">
      {error}
    </div>
  );
}
