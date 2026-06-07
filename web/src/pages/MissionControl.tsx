import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Plus, Wand2, Trash2, X, Shuffle } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { SpecialistFloor } from '@/components/SpecialistFloor';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch, apiDelete } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { workspaceName } from '@/lib/personalization';
import { TERMINAL, partitionTasks, statusTone, hasMoreHistory, type MissionTask } from './missionTasks';

interface Agent { id: string; name: string; description: string; running: boolean; }

const HISTORY_PAGE = 30;

type TabKey = 'queue' | 'active' | 'completed' | 'floor';

export function MissionControl() {
  const [location, navigate] = useLocation();
  const tasks = useFetch<{ tasks: MissionTask[] }>('/api/mission/tasks', 8_000);
  const agents = useFetch<{ agents: Agent[] }>('/api/agents', 60_000);

  const [createOpen, setCreateOpen] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [tab, setTab] = useState<TabKey>('queue');
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [detailTask, setDetailTask] = useState<MissionTask | null>(null);

  // The Completed tab is a true archive backed by /api/mission/history
  // (paginated, with a real total) rather than a client-side slice of the
  // live task poll. Fetched continuously so the tab badge stays truthful.
  const history = useFetch<{ tasks: MissionTask[]; total: number }>(
    `/api/mission/history?limit=${historyLimit}&offset=0`,
    12_000,
  );

  // ?new=1 from the command palette opens the create modal.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('new') === '1') {
      setCreateOpen(true);
      url.searchParams.delete('new');
      navigate(url.pathname);
    }
  }, [location]);

  // ── Group live tasks by lifecycle state ──
  // queue  = waiting to run (status='queued') OR not yet assigned, excluding
  //          anything already terminal.
  // active = currently running (status='running').
  // Completed/terminal tasks come from the history archive, not this poll.
  const { queue, active } = useMemo(
    () => partitionTasks(tasks.data?.tasks ?? []),
    [tasks.data],
  );

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

  const isCompleted = tab === 'completed';
  const historyTotal = history.data?.total ?? 0;
  const loading = isCompleted
    ? history.loading && !history.data
    : (tasks.loading || agents.loading) && !tasks.data;
  const error = isCompleted ? history.error : (tasks.error || agents.error);
  const wsName = workspaceName.value;
  const headerTitle = wsName && wsName !== 'ClaudeClaw' ? `${wsName} · Tasks` : 'Mission Control';

  // Floor tab renders SpecialistFloor and does not use `shown`. Completed
  // pulls from the history archive; the other list tabs use the live poll.
  const shown = tab === 'queue' ? queue
    : tab === 'active' ? active
    : tab === 'completed' ? (history.data?.tasks ?? [])
    : [];
  const agentList = agents.data?.agents ?? [];
  const agentById = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agentList) m.set(a.id, a);
    return m;
  }, [agentList]);

  function refreshAll() {
    tasks.refresh();
    history.refresh();
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title={headerTitle}
        breadcrumb="Operations"
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
            <Tab label="Queue"     count={queue.length}   active={tab === 'queue'}     onClick={() => setTab('queue')} />
            <Tab label="Active"    count={active.length}  active={tab === 'active'}    onClick={() => setTab('active')} />
            <Tab label="Completed" count={historyTotal}   active={tab === 'completed'} onClick={() => setTab('completed')} />
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
              <>
                {shown.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    agent={t.assigned_agent ? agentById.get(t.assigned_agent) : undefined}
                    onOpen={() => setDetailTask(t)}
                    onChange={refreshAll}
                  />
                ))}
                {isCompleted && hasMoreHistory(shown.length, historyTotal) && (
                  <div class="pt-2 flex justify-center">
                    <button
                      type="button"
                      onClick={() => setHistoryLimit((n) => n + HISTORY_PAGE)}
                      class="press-target px-4 py-1.5 rounded-full text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-elevated)] transition-colors"
                    >
                      Load more ({shown.length} of {historyTotal})
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        agents={agentList}
        onCreated={refreshAll}
      />

      <TaskDetailsModal
        open={detailTask !== null}
        onClose={() => setDetailTask(null)}
        task={detailTask}
        agents={agentList}
        onChange={refreshAll}
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
    ? { title: 'No finished tasks yet', sub: 'Completed, failed, and cancelled tasks land here as a searchable archive.' }
    : { title: 'Floor view', sub: 'Live specialist roster.' };
  return (
    <div class="text-center py-16 px-6">
      <div class="text-[15px] font-medium text-[var(--color-text)]">{copy.title}</div>
      <div class="text-[12.5px] text-[var(--color-text-faint)] mt-1.5 max-w-md mx-auto leading-relaxed">{copy.sub}</div>
    </div>
  );
}

// ── Task detail drill-in ────────────────────────────────────────────
// Opened by clicking a task title. Pulls a fresh copy via
// GET /api/mission/tasks/:id so a running task shows its latest result,
// and hosts the lifecycle actions: reassign (queued-only, PATCH), auto-
// route, cancel, and delete. Falls back to the row's copy until the
// detail fetch lands.
function TaskDetailsModal({
  open, onClose, task, agents, onChange,
}: {
  open: boolean;
  onClose: () => void;
  task: MissionTask | null;
  agents: Agent[];
  onChange: () => void;
}) {
  const detail = useFetch<{ task: MissionTask }>(
    open && task ? `/api/mission/tasks/${task.id}` : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [pickAgent, setPickAgent] = useState('');

  const t = detail.data?.task ?? task;
  if (!t) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;

  const isQueued = t.status === 'queued';
  const isRunning = t.status === 'running';
  const isTerminal = TERMINAL.includes(t.status);

  async function reassign() {
    if (!pickAgent) return;
    setBusy('reassign');
    try {
      // Backend only reassigns while the task is still queued; a task that
      // just started running returns ok:false. Report that honestly rather
      // than claiming a move that did not happen.
      const res = await apiPatch<{ ok: boolean }>(`/api/mission/tasks/${t!.id}`, { assigned_agent: pickAgent });
      if (res?.ok) {
        pushToast({ tone: 'success', title: 'Reassigned', description: `→ @${pickAgent}` });
        setPickAgent('');
      } else {
        pushToast({ tone: 'error', title: 'Reassign failed', description: 'Task is no longer queued.' });
      }
      onChange(); detail.refresh();
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Reassign failed', description: err?.message || String(err) });
    } finally { setBusy(null); }
  }

  async function autoRoute() {
    setBusy('auto');
    try {
      const res = await apiPost<{ assigned_agent?: string }>(`/api/mission/tasks/${t!.id}/auto-assign`);
      pushToast({ tone: 'success', title: 'Routed', description: res.assigned_agent ? `→ @${res.assigned_agent}` : 'Routed.' });
      onChange(); detail.refresh();
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Route failed', description: err?.message || String(err) });
    } finally { setBusy(null); }
  }

  async function cancel() {
    setBusy('cancel');
    try { await apiPost(`/api/mission/tasks/${t!.id}/cancel`); onChange(); detail.refresh(); }
    catch (err: any) { pushToast({ tone: 'error', title: 'Cancel failed', description: err?.message || String(err) }); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!confirm('Delete this task?')) return;
    setBusy('delete');
    try { await apiDelete(`/api/mission/tasks/${t!.id}`); onChange(); onClose(); }
    catch (err: any) { pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err) }); }
    finally { setBusy(null); }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={'Task · ' + t.id.slice(0, 8)}
      width={580}
      footer={
        <>
          {isTerminal && (
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] border border-[var(--color-border)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
            >
              <Trash2 size={12} /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </button>
          )}
          {(isQueued || isRunning) && (
            <button
              type="button"
              onClick={cancel}
              disabled={busy !== null}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] border border-[var(--color-border)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
            >
              <X size={12} /> {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {isQueued && (
            <div class="ml-auto flex items-center gap-2">
              <select
                value={pickAgent}
                onChange={(e) => setPickAgent((e.target as HTMLSelectElement).value)}
                disabled={busy !== null}
                class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">Reassign to…</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
              <button
                type="button"
                onClick={reassign}
                disabled={!pickAgent || busy !== null}
                class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Shuffle size={12} /> {busy === 'reassign' ? 'Moving…' : 'Reassign'}
              </button>
              {!t.assigned_agent && (
                <button
                  type="button"
                  onClick={autoRoute}
                  disabled={busy !== null}
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
                >
                  <Wand2 size={12} /> {busy === 'auto' ? 'Routing…' : 'Auto-route'}
                </button>
              )}
            </div>
          )}
        </>
      }
    >
      <div class="space-y-3">
        <div class="flex items-center gap-2 flex-wrap">
          <Pill tone={statusTone(t.status)}>{t.status}</Pill>
          {t.assigned_agent && (
            <span class="text-[11.5px] text-[var(--color-text-muted)] font-mono uppercase tracking-[0.08em]">@{t.assigned_agent}</span>
          )}
        </div>
        <div>
          <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Title</div>
          <div class="text-[14px] text-[var(--color-text)] leading-snug">{t.title}</div>
        </div>
        {t.prompt && t.prompt !== t.title && (
          <div>
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Prompt</div>
            <div class="text-[12.5px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3">
              {t.prompt}
            </div>
          </div>
        )}
        {t.result && (
          <div>
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Result</div>
            <div class="text-[12.5px] text-[var(--color-text)] whitespace-pre-wrap leading-relaxed bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3">
              {t.result}
            </div>
          </div>
        )}
        {t.error && (
          <div>
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Error</div>
            <div class="text-[12px] text-[var(--color-status-failed)] whitespace-pre-wrap font-mono leading-relaxed">
              {t.error}
            </div>
          </div>
        )}
        <div class="grid grid-cols-3 gap-3 pt-1">
          <Stat label="Created" value={formatRelativeTime(t.created_at)} />
          <Stat label="Started" value={t.started_at ? formatRelativeTime(t.started_at) : 'not started'} />
          <Stat label="Finished" value={t.completed_at ? formatRelativeTime(t.completed_at) : 'pending'} />
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
// running what. Clicking the title opens the detail drill-in.
function TaskRow({
  task, agent, onOpen, onChange,
}: {
  task: MissionTask;
  agent?: Agent;
  onOpen: () => void;
  onChange: () => void;
}) {
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
            onClick={onOpen}
            class="text-[14.5px] text-[var(--color-text)] font-medium leading-snug text-left w-full hover:text-[var(--color-accent)] transition-colors"
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
            <Pill tone={statusTone(task.status)}>{task.status}</Pill>
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
      {task.error && (
        <div class="mt-2 text-[11.5px] text-[var(--color-status-failed)] line-clamp-2 font-mono">
          {task.error}
        </div>
      )}
    </div>
  );
}
