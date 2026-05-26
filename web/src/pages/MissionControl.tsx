import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Plus, Wand2, Trash2, X } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { Pill, StatusDot } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { SpecialistFloor } from '@/components/SpecialistFloor';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch, apiDelete } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { workspaceName } from '@/lib/personalization';

interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  created_by: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

interface Agent { id: string; name: string; description: string; running: boolean; }

const TERMINAL: MissionTask['status'][] = ['completed', 'failed', 'cancelled'];

type TabKey = 'queue' | 'active' | 'completed' | 'floor';

export function MissionControl() {
  const [location, navigate] = useLocation();
  const tasks = useFetch<{ tasks: MissionTask[] }>('/api/mission/tasks', 8_000);
  const agents = useFetch<{ agents: Agent[] }>('/api/agents', 60_000);

  const [createOpen, setCreateOpen] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [tab, setTab] = useState<TabKey>('queue');

  // ?new=1 from the command palette opens the create modal.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('new') === '1') {
      setCreateOpen(true);
      url.searchParams.delete('new');
      navigate(url.pathname);
    }
  }, [location]);

  // ── Group tasks by lifecycle state ──
  // queue     = waiting to run (status='queued') OR not yet assigned to a specialist
  // active    = currently running (status='running')
  // completed = recently finished (status in TERMINAL) — capped at 50, newest first
  const { queue, active, completed } = useMemo(() => {
    const all = tasks.data?.tasks ?? [];
    const queue = all.filter((t) => t.status === 'queued' || !t.assigned_agent);
    const active = all.filter((t) => t.status === 'running');
    const completed = all
      .filter((t) => TERMINAL.includes(t.status))
      .slice()
      .sort((a, b) => (b.completed_at || b.started_at || b.created_at) - (a.completed_at || a.started_at || a.created_at))
      .slice(0, 50);
    return { queue, active, completed };
  }, [tasks.data]);

  async function autoAssignAll() {
    setBulkAssigning(true);
    try {
      const res = await apiPost<{ assigned: number }>('/api/mission/tasks/auto-assign-all');
      tasks.refresh();
      if (typeof res?.assigned === 'number') {
        pushToast({
          tone: 'success',
          title: 'Auto-assigned',
          description: `${res.assigned} task${res.assigned === 1 ? '' : 's'} routed.`,
        });
      }
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Auto-assign failed', description: err?.message || String(err) });
    } finally { setBulkAssigning(false); }
  }

  const loading = (tasks.loading || agents.loading) && !tasks.data;
  const error = tasks.error || agents.error;
  const wsName = workspaceName.value;
  const headerTitle = wsName && wsName !== 'ClaudeClaw' ? `${wsName} · Tasks` : 'Mission Control';

  // Floor tab renders SpecialistFloor and does not use `shown`; fall back
  // to completed list shape for the other tabs so types stay consistent.
  const shown = tab === 'queue' ? queue : tab === 'active' ? active : tab === 'completed' ? completed : completed;
  const agentList = agents.data?.agents ?? [];
  const agentById = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agentList) m.set(a.id, a);
    return m;
  }, [agentList]);

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title={headerTitle}
        actions={
          <>
            {queue.length > 0 && (
              <button
                type="button"
                onClick={autoAssignAll}
                disabled={bulkAssigning}
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] border border-[var(--color-border)] transition-colors disabled:opacity-40"
              >
                <Wand2 size={13} /> {bulkAssigning ? 'Assigning…' : `Auto-route ${queue.length}`}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-semibold bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
            >
              <Plus size={14} /> New Task
            </button>
          </>
        }
        tabs={
          <>
            <Tab label="Queue"     count={queue.length}     active={tab === 'queue'}     onClick={() => setTab('queue')} />
            <Tab label="Active"    count={active.length}    active={tab === 'active'}    onClick={() => setTab('active')} />
            <Tab label="Completed" count={completed.length} active={tab === 'completed'} onClick={() => setTab('completed')} />
            <Tab label="Floor"     active={tab === 'floor'}     onClick={() => setTab('floor')} />
          </>
        }
      />

      {/* Floor tab is the live specialist roster view — has its own data
       *  fetches (specialists + stats), so the task-list error/loading
       *  state from above does not apply. Render it stand-alone. */}
      {tab === 'floor' && <SpecialistFloor />}

      {tab !== 'floor' && error && <PageState error={error} />}
      {tab !== 'floor' && loading && <PageState loading />}

      {tab !== 'floor' && !loading && !error && (
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div class="max-w-3xl mx-auto px-4 md:px-6 py-5 space-y-2">
            {shown.length === 0 ? (
              <EmptyState tab={tab} />
            ) : (
              shown.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  agent={t.assigned_agent ? agentById.get(t.assigned_agent) : undefined}
                  agents={agentList}
                  onChange={tasks.refresh}
                />
              ))
            )}
          </div>
        </div>
      )}

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        agents={agentList}
        onCreated={tasks.refresh}
      />
    </div>
  );
}

function EmptyState({ tab }: { tab: TabKey }) {
  // Floor tab has its own empty/loading rendering inside SpecialistFloor;
  // this component is never instantiated for tab='floor', but TypeScript
  // wants the case covered. Default copy doubles as a safety net.
  const copy = tab === 'queue'
    ? { title: 'Queue is clear', sub: 'No tasks waiting. New tasks land here until J.A.R.V.I.S. routes them.' }
    : tab === 'active'
    ? { title: 'Nothing running', sub: 'When a task picks up, it shows here with the specialist working on it.' }
    : tab === 'completed'
    ? { title: 'No completed tasks yet', sub: 'Recently finished tasks (last 50) will appear here.' }
    : { title: 'Floor view', sub: 'Live specialist roster.' };
  return (
    <div class="text-center py-16 px-6">
      <div class="text-[15px] font-medium text-[var(--color-text)]">{copy.title}</div>
      <div class="text-[12.5px] text-[var(--color-text-faint)] mt-1.5 max-w-md mx-auto leading-relaxed">{copy.sub}</div>
    </div>
  );
}

// ── Columns ─────────────────────────────────────────────────────────

// Inbox is pinned leftmost and not draggable/resizable — it's a fixed
// landing zone for unassigned tasks. Width chosen to match the default
// agent column width but slightly narrower since inbox cards are simpler.
function TaskDetailsModal({
  open, onClose, task, agents, busy, onAutoAssign, onManualAssign, onDelete,
}: {
  open: boolean;
  onClose: () => void;
  task: MissionTask;
  agents: Agent[];
  busy: string | null;
  onAutoAssign: () => Promise<void> | void;
  onManualAssign: (agentId: string) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
}) {
  const [pickerAgent, setPickerAgent] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={'Task · ' + task.id.slice(0, 8)}
      width={560}
      footer={
        <>
          <button
            type="button"
            onClick={() => onDelete()}
            disabled={busy !== null}
            class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] border border-[var(--color-border)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
          >
            <Trash2 size={12} /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
          <div class="ml-auto flex items-center gap-2">
            <select
              value={pickerAgent}
              onChange={(e) => setPickerAgent((e.target as HTMLSelectElement).value)}
              disabled={busy !== null}
              class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Assign to…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
            <button
              type="button"
              onClick={() => pickerAgent && onManualAssign(pickerAgent)}
              disabled={!pickerAgent || busy !== null}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'manual' ? 'Assigning…' : 'Assign'}
            </button>
            <button
              type="button"
              onClick={() => onAutoAssign()}
              disabled={busy !== null}
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
            >
              <Wand2 size={12} /> {busy === 'assign' ? 'Classifying…' : 'Auto-assign'}
            </button>
          </div>
        </>
      }
    >
      <div class="space-y-3">
        <div>
          <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Title</div>
          <div class="text-[14px] text-[var(--color-text)] leading-snug">{task.title}</div>
        </div>
        {task.prompt && task.prompt !== task.title && (
          <div>
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Prompt</div>
            <div class="text-[12.5px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3">
              {task.prompt}
            </div>
          </div>
        )}
        <div class="grid grid-cols-2 gap-3 pt-1">
          <Stat label="Created" value={formatRelativeTime(task.created_at)} />
          <Stat label="Created by" value={task.created_by || 'dashboard'} />
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">{label}</div>
      <div class="text-[12.5px] text-[var(--color-text)] tabular-nums">{value}</div>
    </div>
  );
}


// ── Create modal ───────────────────────────────────────────────────

function CreateTaskModal({
  open, onClose, onCreated,
}: {
  open: boolean; onClose: () => void; agents: Agent[]; onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function close() {
    setTitle(''); setPrompt(''); setErr(null);
    onClose();
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      // Every task lands with Jarvis (main). He decides which specialist
      // handles it via the intelligentRoute system in his persona. No
      // priority — every task is executed to the highest standard.
      // Backend still accepts priority and assigned_agent for CLI/Telegram
      // compatibility; UI just always sends main + no priority.
      const body = {
        title: title.trim(),
        prompt: prompt.trim(),
        assigned_agent: 'main',
      };
      await apiPost<{ task: MissionTask }>('/api/mission/tasks', body);
      onCreated();
      close();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="New mission task"
      width={520}
      footer={
        <>
          <button type="button" onClick={close} class="px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !title.trim() || !prompt.trim()}
            class="ml-auto px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div class="space-y-3">
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Title</label>
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="Short label (max 200 chars)"
            maxLength={200}
            autoFocus
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Prompt</label>
          <textarea
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Full instructions for the agent. Max 10000 chars."
            maxLength={10000}
            rows={6}
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)] resize-none font-mono"
          />
          <div class="text-[10px] text-[var(--color-text-faint)] mt-0.5 tabular-nums">{prompt.length} / 10000</div>
        </div>
        <div class="text-[10.5px] text-[var(--color-text-faint)] flex items-center gap-1.5">
          <span class="size-1.5 rounded-full bg-[var(--color-accent)]" />
          Routed to J.A.R.V.I.S. He picks the right specialist via intelligentRoute.
        </div>
        {err && <div class="text-[var(--color-status-failed)] text-[11px]">{err}</div>}
      </div>
    </Modal>
  );
}

// ── Task row ────────────────────────────────────────────────────────────
// One row per task in the tab list. Cyan left-border accent encodes the
// lifecycle state at a glance:
//   running → full cyan      queued → faint cyan
//   failed  → red             terminal → muted gray
// On the Active tab, the row shows the specialist callsign prominently
// (which agent is doing the work) so you can tell at a glance who's
// running what.
function TaskRow({
  task, agent, onChange,
}: {
  task: MissionTask;
  agent?: Agent;
  agents: Agent[];
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel() {
    setBusy('cancel');
    try { await apiPost(`/api/mission/tasks/${task.id}/cancel`); onChange(); }
    catch (err: any) { pushToast({ tone: 'error', title: 'Cancel failed', description: err?.message || String(err) }); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!confirm('Delete this task?')) return;
    setBusy('delete');
    try { await apiDelete(`/api/mission/tasks/${task.id}`); onChange(); }
    catch (err: any) { pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err) }); }
    finally { setBusy(null); }
  }

  async function autoAssign() {
    setBusy('assign');
    try {
      const res = await apiPost<{ ok: boolean; assigned_agent?: string }>(`/api/mission/tasks/${task.id}/auto-assign`);
      onChange();
      pushToast({
        tone: 'success',
        title: 'Routed',
        description: res.assigned_agent ? `→ @${res.assigned_agent}` : 'Routed.',
      });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Route failed', description: err?.message || String(err) });
    } finally { setBusy(null); }
  }

  const accentClass =
    task.status === 'running' ? 'border-l-[var(--color-accent)]' :
    task.status === 'queued'  ? 'border-l-[var(--color-accent)]/40' :
    task.status === 'failed'  ? 'border-l-[var(--color-status-failed)]' :
                                 'border-l-[var(--color-text-faint)]/30';

  return (
    <div
      class={[
        'glass border border-[var(--color-border)] border-l-2 rounded-2xl p-4 transition-colors',
        accentClass,
        'hover:border-[var(--color-border-strong)]',
      ].join(' ')}
    >
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            class="text-[14.5px] text-[var(--color-text)] font-medium leading-snug text-left w-full"
          >
            {task.title}
          </button>
          <div class="text-[11.5px] mt-1.5 flex items-center gap-2 flex-wrap">
            {/* Specialist attribution — prominent + pulsing dot when running */}
            {task.status === 'running' && agent && (
              <span class="inline-flex items-center gap-1.5 text-[var(--color-accent)] font-mono uppercase tracking-[0.08em] font-semibold">
                <span class="size-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                {agent.name || agent.id}
              </span>
            )}
            {task.status !== 'running' && agent && (
              <span class="text-[var(--color-text-muted)] font-mono uppercase tracking-[0.08em]">
                @{agent.id}
              </span>
            )}
            <Pill tone={task.status as any}>{task.status}</Pill>
            <span class="text-[var(--color-text-faint)] tabular-nums">
              {formatRelativeTime(task.completed_at || task.started_at || task.created_at)}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          {!task.assigned_agent && (
            <button
              type="button"
              onClick={autoAssign}
              disabled={busy !== null}
              class="press-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11.5px] font-semibold bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white transition-colors disabled:opacity-40"
              title="Route to the right specialist"
            >
              <Wand2 size={11} /> Route
            </button>
          )}
          {(task.status === 'queued' || task.status === 'running') && (
            <button
              type="button"
              onClick={cancel}
              disabled={busy !== null}
              class="press-target p-2 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40"
              title="Cancel"
            >
              <X size={13} />
            </button>
          )}
          {TERMINAL.includes(task.status) && (
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              class="press-target p-2 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40"
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
      {expanded && task.prompt && task.prompt !== task.title && (
        <div class="mt-3 text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed border-t border-[var(--color-border)] pt-3">
          {task.prompt}
        </div>
      )}
      {expanded && task.result && (
        <div class="mt-3 text-[12.5px] text-[var(--color-text)] whitespace-pre-wrap leading-relaxed border-t border-[var(--color-border)] pt-3">
          {task.result}
        </div>
      )}
      {task.error && (
        <div class="mt-2 text-[11.5px] text-[var(--color-status-failed)] line-clamp-2 font-mono">
          {task.error}
        </div>
      )}
    </div>
  );
}
