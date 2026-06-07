import { useState, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  Plus, FolderOpen, Trash2, Pencil, Archive,
  Circle, CircleDot, CheckCircle2, Target, ListChecks,
  FileText, Link2, StickyNote, Lightbulb, Video, Sparkles,
  Loader2, ExternalLink, BookOpen,
} from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch, apiDelete } from '@/lib/api';

// ── Types (mirror src/db.ts) ────────────────────────────────────────────────
interface ProjectSummary {
  id: string; name: string; description: string; instructions: string;
  status: string; color: string; created_at: number; updated_at: number;
  last_worked_at: number | null;
  goal_count: number; task_count: number; task_done_count: number; research_count: number;
}
interface Project {
  id: string; name: string; description: string; instructions: string;
  status: string; color: string; created_at: number; updated_at: number;
  last_worked_at: number | null;
}
interface ProjectItem {
  id: string; project_id: string; kind: string; category: string | null;
  title: string; content: string; url: string | null; source: string | null;
  status: string | null; assigned_agent: string | null; metadata: string | null;
  pinned: number; sort_order: number; created_by: string;
  created_at: number; updated_at: number;
}

type DetailTab = 'research' | 'goals' | 'tasks' | 'instructions';

const RESEARCH_CATS: Array<{ key: string; label: string; icon: typeof FileText }> = [
  { key: 'paper', label: 'Papers', icon: FileText },
  { key: 'source', label: 'Sources', icon: Link2 },
  { key: 'note', label: 'Notes', icon: StickyNote },
  { key: 'video_idea', label: 'Video ideas', icon: Lightbulb },
  { key: 'key_point', label: 'Key points', icon: ListChecks },
  { key: 'transcript', label: 'Transcripts', icon: FileText },
  { key: 'research_video', label: 'Research videos', icon: Video },
  { key: 'video_link', label: 'Video links', icon: Link2 },
  { key: 'analysis', label: 'Analysis', icon: Sparkles },
];
const CAT_LABEL: Record<string, string> = Object.fromEntries(RESEARCH_CATS.map((c) => [c.key, c.label]));

const inputClass =
  'w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[12px] px-3 py-2 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors';
const labelClass = 'block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1';

function primaryBtn(extra = '') {
  return `press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity ${extra}`;
}

// ── Page ────────────────────────────────────────────────────────────────────
export function Workspace() {
  const projectsState = useFetch<{ projects: ProjectSummary[] }>('/api/projects', 8_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const projects = projectsState.data?.projects ?? [];

  useEffect(() => {
    if (selectedId && !projects.some((p) => p.id === selectedId)) setSelectedId(null);
    if (!selectedId && projects.length > 0) setSelectedId(projects[0].id);
  }, [projects, selectedId]);

  const coldLoading = projectsState.loading && !projectsState.data;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Workspace"
        actions={
          <button type="button" class={primaryBtn()} onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New Project
          </button>
        }
      />

      {coldLoading && <PageState loading />}
      {projectsState.error && <PageState error={projectsState.error} />}

      {!coldLoading && !projectsState.error && (
        <div class="flex-1 min-h-0 flex">
          {/* Project list */}
          <aside class="w-[270px] shrink-0 border-r border-[var(--color-border)] overflow-y-auto">
            {projects.length === 0 ? (
              <div class="p-5 text-[12px] text-[var(--color-text-muted)] text-center">
                No projects yet. Create one to start.
              </div>
            ) : (
              <div class="p-2 space-y-1">
                {projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    active={p.id === selectedId}
                    onClick={() => setSelectedId(p.id)}
                  />
                ))}
              </div>
            )}
          </aside>

          {/* Detail */}
          <div class="flex-1 min-w-0 overflow-y-auto">
            {selectedId ? (
              <ProjectDetail
                key={selectedId}
                projectId={selectedId}
                onChanged={() => projectsState.refresh()}
                onDeleted={() => { setSelectedId(null); projectsState.refresh(); }}
              />
            ) : (
              <PageState
                empty
                emptyTitle="No project selected"
                emptyDescription="Create a project to organize goals, tasks, and a research library you build with Jarvis and the team."
              />
            )}
          </div>
        </div>
      )}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => { setCreateOpen(false); projectsState.refresh(); setSelectedId(id); }}
      />
    </div>
  );
}

function ProjectRow({ project, active, onClick }: { project: ProjectSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={[
        'press-target w-full text-left px-3 py-2.5 rounded-[14px] transition-colors',
        active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-elevated)]',
      ].join(' ')}
    >
      <div class="flex items-center gap-2">
        <span class={[
          'inline-flex items-center justify-center w-7 h-7 rounded-[10px] shrink-0',
          active ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)]',
        ].join(' ')}>
          <FolderOpen size={15} />
        </span>
        <span class="flex-1 min-w-0">
          <span class="block text-[13.5px] font-semibold text-[var(--color-text)] truncate">{project.name}</span>
          <span class="block text-[11px] text-[var(--color-text-faint)] truncate">
            {project.task_count > 0 && `${project.task_done_count}/${project.task_count} tasks`}
            {project.task_count > 0 && project.research_count > 0 && ' · '}
            {project.research_count > 0 && `${project.research_count} research`}
            {project.task_count === 0 && project.research_count === 0 && (project.status === 'archived' ? 'archived' : 'empty')}
          </span>
        </span>
      </div>
    </button>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────
function ProjectDetail({ projectId, onChanged, onDeleted }: { projectId: string; onChanged: () => void; onDeleted: () => void }) {
  const detail = useFetch<{ project: Project; items: ProjectItem[] }>(`/api/projects/${projectId}`, 6_000);
  const [tab, setTab] = useState<DetailTab>('research');
  const [editOpen, setEditOpen] = useState(false);

  const project = detail.data?.project;
  const items = detail.data?.items ?? [];
  const goals = items.filter((i) => i.kind === 'goal');
  const tasks = items.filter((i) => i.kind === 'task');
  const research = items.filter((i) => i.kind === 'research');

  function refresh() { detail.refresh(); onChanged(); }

  if (detail.loading && !detail.data) return <PageState loading />;
  if (detail.error) return <PageState error={detail.error} />;
  if (!project) return <PageState empty emptyTitle="Project not found" />;

  return (
    <div class="max-w-3xl mx-auto px-5 md:px-7 py-5">
      {/* Header */}
      <div class="flex items-start gap-3 mb-1">
        <h2 class="flex-1 text-[22px] font-bold text-[var(--color-text)] tracking-tight">{project.name}</h2>
        <button type="button" class="press-target inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors" title="Edit project" onClick={() => setEditOpen(true)}>
          <Pencil size={14} />
        </button>
      </div>
      {project.description && <p class="text-[13.5px] text-[var(--color-text-muted)] mb-4">{project.description}</p>}
      {project.status === 'archived' && (
        <div class="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)] mb-3"><Archive size={12} /> Archived</div>
      )}

      {/* Detail tabs */}
      <div class="flex justify-center mb-5">
        <div class="inline-flex items-center gap-0.5 p-1 rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)]">
          <Tab label="Research" active={tab === 'research'} count={research.length} onClick={() => setTab('research')} />
          <Tab label="Goals" active={tab === 'goals'} count={goals.length} onClick={() => setTab('goals')} />
          <Tab label="Tasks" active={tab === 'tasks'} count={tasks.length} onClick={() => setTab('tasks')} />
          <Tab label="Instructions" active={tab === 'instructions'} onClick={() => setTab('instructions')} />
        </div>
      </div>

      {tab === 'research' && <ResearchSection projectId={projectId} research={research} onRefresh={refresh} />}
      {tab === 'goals' && <GoalsSection projectId={projectId} goals={goals} onRefresh={refresh} />}
      {tab === 'tasks' && <TasksSection projectId={projectId} tasks={tasks} onRefresh={refresh} />}
      {tab === 'instructions' && <InstructionsSection project={project} onRefresh={refresh} />}

      <EditProjectModal
        open={editOpen}
        project={project}
        onClose={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); refresh(); }}
        onDeleted={() => { setEditOpen(false); onDeleted(); }}
      />
    </div>
  );
}

// ── Research section ─────────────────────────────────────────────────────────
function ResearchSection({ projectId, research, onRefresh }: { projectId: string; research: ProjectItem[]; onRefresh: () => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function runResearch() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setErr(null);
    try {
      await apiPost(`/api/projects/${projectId}/research`, { query: q });
      setQuery('');
      onRefresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div class="space-y-5">
      {/* Research with Jarvis composer */}
      <div class="glass border border-[var(--color-border)] rounded-[18px] p-4">
        <div class="flex items-center gap-2 mb-2">
          <Sparkles size={15} class="text-[var(--color-accent)]" />
          <span class="text-[13px] font-semibold text-[var(--color-text)]">Research with Jarvis and the team</span>
        </div>
        <textarea
          value={query}
          onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)}
          placeholder="Ask a research question. Jarvis runs the regular team and an uncensored cross-check, then files a report here."
          rows={3}
          class={inputClass + ' resize-none'}
        />
        {err && <div class="text-[var(--color-status-failed)] text-[11px] mt-1">{err}</div>}
        <div class="flex items-center justify-between mt-2">
          <span class="text-[11px] text-[var(--color-text-faint)]">Runs sleuth + oracle, then prism + heretic for a bias delta.</span>
          <button type="button" class={primaryBtn()} disabled={busy || !query.trim()} onClick={runResearch}>
            {busy ? <Loader2 size={14} class="animate-spin" /> : <Sparkles size={14} />} Research
          </button>
        </div>
      </div>

      {/* Library header */}
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-[12px] uppercase tracking-wider text-[var(--color-text-faint)]">
          <BookOpen size={13} /> Research library
        </div>
        <button type="button" class="press-target inline-flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:opacity-80" onClick={() => setAddOpen(true)}>
          <Plus size={13} /> Add entry
        </button>
      </div>

      {research.length === 0 ? (
        <div class="text-center py-10 text-[12px] text-[var(--color-text-muted)]">
          Nothing here yet. Run a research question above, or add papers, sources, transcripts, and video ideas manually.
        </div>
      ) : (
        <div class="space-y-2">
          {research.map((item) => (
            <ResearchCard key={item.id} item={item} onRefresh={onRefresh} />
          ))}
        </div>
      )}

      <AddResearchModal projectId={projectId} open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); onRefresh(); }} />
    </div>
  );
}

function ResearchCard({ item, onRefresh }: { item: ProjectItem; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const cat = RESEARCH_CATS.find((c) => c.key === item.category);
  const Icon = cat?.icon ?? FileText;
  const running = item.status === 'running';
  const failed = item.status === 'failed';

  async function remove() {
    try { await apiDelete(`/api/projects/${item.project_id}/items/${item.id}`); onRefresh(); } catch { /* noop */ }
  }

  return (
    <div class="glass border border-[var(--color-border)] rounded-[16px] p-3.5">
      <div class="flex items-start gap-3">
        <span class="inline-flex items-center justify-center w-8 h-8 rounded-[11px] bg-[var(--color-elevated)] text-[var(--color-accent)] shrink-0">
          {running ? <Loader2 size={15} class="animate-spin" /> : <Icon size={15} />}
        </span>
        <div class="flex-1 min-w-0">
          <button type="button" class="block w-full text-left" onClick={() => setOpen((v) => !v)}>
            <div class="text-[13.5px] font-semibold text-[var(--color-text)] truncate">{item.title}</div>
            <div class="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--color-text-faint)]">
              <span class="px-1.5 py-0.5 rounded-full bg-[var(--color-elevated)]">{CAT_LABEL[item.category ?? ''] ?? 'Note'}</span>
              {item.source && <span class="truncate">{item.source}</span>}
              {running && <span class="text-[var(--color-accent)]">researching…</span>}
              {failed && <span class="text-[var(--color-status-failed)]">failed</span>}
            </div>
          </button>
          {open && (
            <div class="mt-2">
              {item.content && <div class="text-[12.5px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed">{item.content}</div>}
              {item.url && (
                <a href={item.url} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 mt-2 text-[12px] text-[var(--color-accent)] hover:opacity-80">
                  <ExternalLink size={12} /> Open link
                </a>
              )}
            </div>
          )}
        </div>
        <button type="button" class="press-target shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[var(--color-text-faint)] hover:text-[var(--color-status-failed)] transition-colors" title="Delete" onClick={remove}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

// ── Goals + Tasks sections ───────────────────────────────────────────────────
function GoalsSection({ projectId, goals, onRefresh }: { projectId: string; goals: ProjectItem[]; onRefresh: () => void }) {
  const [title, setTitle] = useState('');
  async function add() {
    const t = title.trim(); if (!t) return;
    try { await apiPost(`/api/projects/${projectId}/items`, { kind: 'goal', title: t }); setTitle(''); onRefresh(); } catch { /* noop */ }
  }
  return (
    <div class="space-y-3">
      <AddLine value={title} onInput={setTitle} onAdd={add} placeholder="Add a goal" icon={<Target size={14} />} />
      {goals.length === 0 ? (
        <Empty text="No goals yet. What is this project aiming for?" />
      ) : (
        <div class="space-y-1.5">{goals.map((g) => <CheckRow key={g.id} item={g} onRefresh={onRefresh} twoState />)}</div>
      )}
    </div>
  );
}

function TasksSection({ projectId, tasks, onRefresh }: { projectId: string; tasks: ProjectItem[]; onRefresh: () => void }) {
  const [title, setTitle] = useState('');
  async function add() {
    const t = title.trim(); if (!t) return;
    try { await apiPost(`/api/projects/${projectId}/items`, { kind: 'task', title: t }); setTitle(''); onRefresh(); } catch { /* noop */ }
  }
  return (
    <div class="space-y-3">
      <AddLine value={title} onInput={setTitle} onAdd={add} placeholder="Add a task" icon={<ListChecks size={14} />} />
      {tasks.length === 0 ? (
        <Empty text="No tasks yet. Break the work into steps." />
      ) : (
        <div class="space-y-1.5">{tasks.map((t) => <CheckRow key={t.id} item={t} onRefresh={onRefresh} />)}</div>
      )}
    </div>
  );
}

function CheckRow({ item, onRefresh, twoState }: { item: ProjectItem; onRefresh: () => void; twoState?: boolean }) {
  async function cycle() {
    const order = twoState ? ['open', 'done'] : ['open', 'doing', 'done'];
    const idx = order.indexOf(item.status ?? 'open');
    const next = order[(idx + 1) % order.length];
    try { await apiPatch(`/api/projects/${item.project_id}/items/${item.id}`, { status: next }); onRefresh(); } catch { /* noop */ }
  }
  async function remove() {
    try { await apiDelete(`/api/projects/${item.project_id}/items/${item.id}`); onRefresh(); } catch { /* noop */ }
  }
  const done = item.status === 'done';
  const doing = item.status === 'doing';
  return (
    <div class="group flex items-center gap-2.5 px-3 py-2 rounded-[12px] hover:bg-[var(--color-elevated)] transition-colors">
      <button type="button" onClick={cycle} class="press-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" title="Toggle status">
        {done ? <CheckCircle2 size={17} class="text-[var(--color-accent)]" /> : doing ? <CircleDot size={17} class="text-[var(--color-accent)]" /> : <Circle size={17} />}
      </button>
      <span class={['flex-1 text-[13.5px]', done ? 'line-through text-[var(--color-text-faint)]' : 'text-[var(--color-text)]'].join(' ')}>{item.title}</span>
      {doing && <span class="text-[10px] uppercase tracking-wider text-[var(--color-accent)]">doing</span>}
      <button type="button" onClick={remove} class="press-target shrink-0 opacity-0 group-hover:opacity-100 text-[var(--color-text-faint)] hover:text-[var(--color-status-failed)] transition-all" title="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// ── Instructions section ─────────────────────────────────────────────────────
function InstructionsSection({ project, onRefresh }: { project: Project; onRefresh: () => void }) {
  const [text, setText] = useState(project.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = text !== (project.instructions ?? '');

  async function save() {
    setBusy(true);
    try { await apiPatch(`/api/projects/${project.id}`, { instructions: text }); setSaved(true); onRefresh(); setTimeout(() => setSaved(false), 2000); }
    catch { /* noop */ } finally { setBusy(false); }
  }
  return (
    <div class="space-y-2">
      <p class="text-[12px] text-[var(--color-text-muted)]">
        Context Jarvis gets on every research run for this project. Describe the topic, audience, sources to prefer, and what a good answer looks like.
      </p>
      <textarea
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        rows={12}
        placeholder="e.g. This project tracks AI-agent frameworks for a YouTube series. Prefer primary sources and recent benchmarks. Always flag vendor hype."
        class={inputClass + ' resize-y font-mono text-[12.5px] leading-relaxed'}
      />
      <div class="flex items-center justify-end gap-3">
        {saved && <span class="text-[11px] text-[var(--color-accent)]">Saved</span>}
        <button type="button" class={primaryBtn()} disabled={busy || !dirty} onClick={save}>
          {busy ? <Loader2 size={14} class="animate-spin" /> : null} Save instructions
        </button>
      </div>
    </div>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────────
function AddLine({ value, onInput, onAdd, placeholder, icon }: { value: string; onInput: (v: string) => void; onAdd: () => void; placeholder: string; icon: ComponentChildren }) {
  return (
    <div class="flex items-center gap-2">
      <span class="text-[var(--color-text-faint)]">{icon}</span>
      <input
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
        placeholder={placeholder}
        class={inputClass}
      />
      <button type="button" class={primaryBtn()} disabled={!value.trim()} onClick={onAdd}><Plus size={14} /></button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div class="text-center py-9 text-[12px] text-[var(--color-text-muted)]">{text}</div>;
}

// ── Modals ───────────────────────────────────────────────────────────────────
function CreateProjectModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() { setName(''); setDescription(''); setInstructions(''); setErr(null); }
  function close() { reset(); onClose(); }

  async function submit() {
    const n = name.trim(); if (!n) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await apiPost<{ project: Project }>('/api/projects', { name: n, description: description.trim(), instructions: instructions.trim() });
      reset();
      onCreated(res.project.id);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={close} title="New project" width={540}
      footer={<><button type="button" class="press-target px-3.5 py-1.5 rounded-full text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={close}>Cancel</button>
        <button type="button" class={primaryBtn('ml-auto')} disabled={busy} onClick={submit}>{busy ? <Loader2 size={14} class="animate-spin" /> : <Plus size={14} />} Create</button></>}>
      <div class="space-y-3">
        <div>
          <label class={labelClass}>Name</label>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Project name" maxLength={200} autoFocus class={inputClass} />
        </div>
        <div>
          <label class={labelClass}>Description</label>
          <input value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} placeholder="One line about this project" maxLength={500} class={inputClass} />
        </div>
        <div>
          <label class={labelClass}>Instructions for Jarvis (optional)</label>
          <textarea value={instructions} onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)} rows={4} placeholder="Context the team gets on every research run for this project." class={inputClass + ' resize-none'} />
        </div>
        {err && <div class="text-[var(--color-status-failed)] text-[11px]">{err}</div>}
      </div>
    </Modal>
  );
}

function EditProjectModal({ open, project, onClose, onSaved, onDeleted }: { open: boolean; project: Project; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setName(project.name); setDescription(project.description); setConfirmDel(false); }, [project.id, open]);

  async function save() {
    const n = name.trim(); if (!n) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try { await apiPatch(`/api/projects/${project.id}`, { name: n, description }); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function toggleArchive() {
    setBusy(true);
    try { await apiPatch(`/api/projects/${project.id}`, { status: project.status === 'archived' ? 'active' : 'archived' }); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function del() {
    setBusy(true);
    try { await apiDelete(`/api/projects/${project.id}`); onDeleted(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit project" width={540}
      footer={<>
        <button type="button" class="press-target px-3.5 py-1.5 rounded-full text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onClose}>Cancel</button>
        <button type="button" class={primaryBtn('ml-auto')} disabled={busy} onClick={save}>Save</button>
      </>}>
      <div class="space-y-3">
        <div>
          <label class={labelClass}>Name</label>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={200} class={inputClass} />
        </div>
        <div>
          <label class={labelClass}>Description</label>
          <input value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} maxLength={500} class={inputClass} />
        </div>
        {err && <div class="text-[var(--color-status-failed)] text-[11px]">{err}</div>}
        <div class="pt-2 border-t border-[var(--color-border)] flex items-center gap-2">
          <button type="button" class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" disabled={busy} onClick={toggleArchive}>
            <Archive size={13} /> {project.status === 'archived' ? 'Unarchive' : 'Archive'}
          </button>
          {confirmDel ? (
            <button type="button" class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] bg-[var(--color-status-failed)] text-white" disabled={busy} onClick={del}>
              <Trash2 size={13} /> Confirm delete
            </button>
          ) : (
            <button type="button" class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] text-[var(--color-status-failed)] hover:bg-[color-mix(in_srgb,var(--color-status-failed)_12%,transparent)]" onClick={() => setConfirmDel(true)}>
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AddResearchModal({ projectId, open, onClose, onAdded }: { projectId: string; open: boolean; onClose: () => void; onAdded: () => void }) {
  const [category, setCategory] = useState('source');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() { setCategory('source'); setTitle(''); setUrl(''); setSource(''); setContent(''); setErr(null); }
  function close() { reset(); onClose(); }

  async function submit() {
    const t = title.trim(); if (!t) { setErr('Title is required'); return; }
    setBusy(true); setErr(null);
    try {
      await apiPost(`/api/projects/${projectId}/items`, { kind: 'research', category, title: t, url: url.trim(), source: source.trim(), content });
      reset(); onAdded();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={close} title="Add research entry" width={560}
      footer={<><button type="button" class="press-target px-3.5 py-1.5 rounded-full text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={close}>Cancel</button>
        <button type="button" class={primaryBtn('ml-auto')} disabled={busy} onClick={submit}>Add</button></>}>
      <div class="space-y-3">
        <div>
          <label class={labelClass}>Type</label>
          <select value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)} class={inputClass}>
            {RESEARCH_CATS.map((c) => <option value={c.key} key={c.key}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label class={labelClass}>Title</label>
          <input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder="Title" maxLength={300} autoFocus class={inputClass} />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class={labelClass}>Link (optional)</label>
            <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="https://" class={inputClass} />
          </div>
          <div>
            <label class={labelClass}>Source (optional)</label>
            <input value={source} onInput={(e) => setSource((e.target as HTMLInputElement).value)} placeholder="Author, channel, journal" class={inputClass} />
          </div>
        </div>
        <div>
          <label class={labelClass}>Notes / content (optional)</label>
          <textarea value={content} onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)} rows={5} placeholder="Key points, transcript, summary…" class={inputClass + ' resize-none'} />
        </div>
        {err && <div class="text-[var(--color-status-failed)] text-[11px]">{err}</div>}
      </div>
    </Modal>
  );
}
