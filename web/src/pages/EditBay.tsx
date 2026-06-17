import { useState, useMemo, useRef } from 'preact/hooks';
import { Loader2, Film, RefreshCw, Trash2, Download, Plus, FolderOpen, Mic, ShieldCheck, Play, Check } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch, apiDelete, tokenizedSseUrl } from '@/lib/api';

// Edit Bay (E1): render jobs that turn library videos into finished clips
// (word-synced animated captions via whisper + Remotion, rendered locally).

interface RenderJob {
  id: string; item_id: string | null; kind: string; status: string;
  spec: string | null; output_file: string | null; error: string | null;
  item_label: string | null; item_author: string | null;
  created_at: number; updated_at: number;
}
interface LibraryVideo {
  id: string; media_type: string | null; media_file: string | null;
  content_angle: string | null; caption: string | null; url: string;
  author_handle: string | null; author_name: string | null; duration_s: number | null;
}
interface EditProject {
  id: string; title: string; status: string;
  item_ids: string | null; idea_notes: string | null; script: string | null;
  script_labels: string | null; brief: string | null; aspect: string;
  voiceover_file: string | null; render_job_id: string | null;
  created_at: number; updated_at: number;
  job?: RenderJob | null;
}
interface LabelClaim { claim: string; verdict: string; summary: string; sources: Array<{ url: string; what_it_shows: string }> }

const ACTIVE = new Set(['queued', 'preparing', 'rendering']);

// ── Projects: the faceless workbench (Gabe drives; nothing renders unpicked) ──
function ProjectsSection({ videos }: { videos: LibraryVideo[] }) {
  const projState = useFetch<{ projects: EditProject[] }>('/api/edit-projects', 8_000);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const projects = projState.data?.projects ?? [];

  async function create() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const r = await apiPost<{ project: EditProject }>('/api/edit-projects', { title });
      setNewTitle('');
      projState.refresh();
      setOpenId(r.project.id);
    } catch { /* surfaced by refresh */ } finally { setCreating(false); }
  }

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Projects</span>
        <input
          value={newTitle}
          onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder="New project title (the video you want to make)..."
          class="flex-1 max-w-[420px] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors"
        />
        <button type="button" onClick={() => void create()} disabled={creating || !newTitle.trim()}
          class="press-target inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11.5px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-50">
          {creating ? <Loader2 size={12} class="animate-spin" /> : <Plus size={12} />} Create
        </button>
      </div>

      {projects.length === 0 ? (
        <div class="text-[12px] text-[var(--color-text-muted)]">No projects yet. Create one, pick your clips, work the idea, approve the script, render.</div>
      ) : (
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {projects.map((p) => (
            <button key={p.id} type="button" onClick={() => setOpenId(p.id)}
              class="press-target text-left rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 hover:border-[var(--color-accent)]/50 transition-colors">
              <div class="flex items-center gap-2">
                <FolderOpen size={14} class="text-[var(--color-accent)] shrink-0" />
                <span class="text-[12.5px] font-semibold text-[var(--color-text)] truncate flex-1">{p.title}</span>
                {statusChip(p.job?.status ?? p.status)}
              </div>
              <div class="text-[10.5px] text-[var(--color-text-faint)] pt-1">
                {(() => { try { return JSON.parse(p.item_ids ?? '[]').length; } catch { return 0; } })()} clip(s)
                {p.voiceover_file ? ' · voiceover ✓' : ''}
                {p.script ? ' · script ✓' : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      {openId && <ProjectEditor id={openId} videos={videos} onClose={() => { setOpenId(null); projState.refresh(); }} />}
    </div>
  );
}

function ProjectEditor({ id, videos, onClose }: { id: string; videos: LibraryVideo[]; onClose: () => void }) {
  const state = useFetch<{ project: EditProject; items: Array<{ id: string; label: string }>; job: RenderJob | null }>(`/api/edit-projects/${id}`, 5_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ idea_notes?: string; script?: string; brief?: string } | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const p = state.data?.project;
  if (!p) return <Modal open onClose={onClose} title="Project" width={820}>{state.error ? <PageState error={state.error} /> : <PageState loading />}</Modal>;

  const itemIds: string[] = (() => { try { return p.item_ids ? JSON.parse(p.item_ids) : []; } catch { return []; } })();
  const labels: { status?: string; claims?: LabelClaim[]; error?: string } = (() => {
    try { return p.script_labels ? JSON.parse(p.script_labels) : {}; } catch { return {}; }
  })();
  const job = state.data?.job ?? null;
  const val = (field: 'idea_notes' | 'script' | 'brief') => draft?.[field] ?? p[field] ?? '';

  async function save(extra: Record<string, unknown> = {}) {
    setBusy('save'); setErr(null);
    try {
      await apiPatch(`/api/edit-projects/${id}`, { ...(draft ?? {}), ...extra });
      setDraft(null);
      state.refresh();
    } catch (e: any) { setErr(e?.body?.error || 'Save failed.'); } finally { setBusy(null); }
  }

  async function toggleClip(vid: string) {
    const next = itemIds.includes(vid) ? itemIds.filter((x) => x !== vid) : [...itemIds, vid].slice(0, 8);
    await save({ item_ids: next });
  }

  async function label() {
    setBusy('label'); setErr(null);
    try { await apiPost(`/api/edit-projects/${id}/label`, {}); state.refresh(); }
    catch (e: any) { setErr(e?.body?.error || 'Labeling failed to start.'); } finally { setBusy(null); }
  }

  async function uploadVo(file: File) {
    setBusy('vo'); setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(tokenizedSseUrl(`/api/edit-projects/${id}/voiceover`), { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `upload ${res.status}`);
      state.refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(null); }
  }

  async function render() {
    setBusy('render'); setErr(null);
    try {
      if (draft) await apiPatch(`/api/edit-projects/${id}`, draft);
      setDraft(null);
      await apiPost(`/api/edit-projects/${id}/render`, {});
      state.refresh();
    } catch (e: any) { setErr(e?.body?.error || 'Render failed to start.'); } finally { setBusy(null); }
  }

  const verdictChip = (v: string) =>
    v === 'confirmed' ? 'bg-emerald-500/20 text-emerald-300'
    : v === 'false' ? 'bg-red-500/25 text-red-300'
    : v === 'disputed' ? 'bg-orange-500/20 text-orange-300'
    : 'bg-slate-500/25 text-slate-300';

  return (
    <Modal open onClose={onClose} title={p.title} width={860}>
      <div class="space-y-3">
        {/* Clips */}
        <div class="space-y-1.5">
          <div class="flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Source clips ({itemIds.length})</span>
            <button type="button" onClick={() => setPickOpen((v) => !v)}
              class="press-target px-2 py-0.5 rounded-full text-[10.5px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              {pickOpen ? 'done picking' : '+ pick clips'}
            </button>
          </div>
          {(state.data?.items ?? []).map((it) => (
            <div key={it.id} class="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
              <Film size={11} class="shrink-0" /> <span class="truncate flex-1">{it.label}</span>
              <button type="button" onClick={() => void toggleClip(it.id)} class="press-target text-red-400/80 hover:text-red-400"><Trash2 size={11} /></button>
            </div>
          ))}
          {pickOpen && (
            <div class="max-h-[200px] overflow-y-auto space-y-0.5 rounded-[10px] border border-[var(--color-border)] p-2">
              {videos.filter((v) => !itemIds.includes(v.id)).map((v) => (
                <button key={v.id} type="button" onClick={() => void toggleClip(v.id)}
                  class="press-target w-full text-left px-2 py-1 rounded-[8px] text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)] truncate">
                  + {(v.content_angle || v.caption || v.url).split('\n')[0].slice(0, 80)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Idea + script + brief */}
        <div>
          <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">The message (worked out with Jarvis)</div>
          <textarea value={val('idea_notes')} onInput={(e) => setDraft((d) => ({ ...d, idea_notes: (e.target as HTMLTextAreaElement).value }))}
            rows={2} placeholder="What this video needs to say and how..."
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]" />
        </div>
        <div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Script / voiceover text</span>
            <button type="button" onClick={() => void label()} disabled={!!busy || labels.status === 'running' || !val('script').trim()}
              class="press-target inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] border border-sky-500/50 text-sky-300 disabled:opacity-50">
              {labels.status === 'running' ? <><Loader2 size={10} class="animate-spin" /> checking facts</> : <><ShieldCheck size={10} /> Label facts (never blocks)</>}
            </button>
          </div>
          <textarea value={val('script')} onInput={(e) => setDraft((d) => ({ ...d, script: (e.target as HTMLTextAreaElement).value }))}
            rows={5} placeholder="The words — yours to read, or framing for the edit..."
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]" />
          {labels.status === 'done' && (labels.claims ?? []).length > 0 && (
            <div class="space-y-1 pt-1">
              {(labels.claims ?? []).map((cl, i) => (
                <div key={i} class="text-[11.5px] text-[var(--color-text-muted)] flex items-start gap-1.5">
                  <span class={`mt-0.5 shrink-0 px-1 rounded text-[9px] font-bold ${verdictChip(cl.verdict)}`}>{cl.verdict.toUpperCase()}</span>
                  <span>{cl.claim}{cl.sources?.[0] ? <a href={cl.sources[0].url} target="_blank" rel="noreferrer" class="text-[var(--color-accent)] pl-1">src</a> : null}</span>
                </div>
              ))}
            </div>
          )}
          {labels.status === 'failed' && <div class="text-[11px] text-red-300">Labeling failed: {labels.error}</div>}
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Render direction (what the editor should do)</div>
          <textarea value={val('brief')} onInput={(e) => setDraft((d) => ({ ...d, brief: (e.target as HTMLTextAreaElement).value }))}
            rows={2} placeholder="e.g. open on the crowd shot, cut on the beat, title at 0:02, keep it dramatic..."
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]" />
        </div>

        {/* Voiceover + aspect + actions */}
        <div class="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="audio/*" class="hidden"
            onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void uploadVo(f); }} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy === 'vo'}
            class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[12px] text-[12px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            {busy === 'vo' ? <Loader2 size={12} class="animate-spin" /> : <Mic size={12} />} {p.voiceover_file ? 'Replace voiceover' : 'Upload your voiceover'}
          </button>
          {p.voiceover_file && <span class="text-[10.5px] text-emerald-400">voiceover ✓</span>}
          <div class="inline-flex rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] p-0.5">
            {(['9:16', '16:9', '1:1'] as const).map((a) => (
              <button key={a} type="button" onClick={() => void save({ aspect: a })}
                class={`press-target px-2.5 py-1 rounded-full text-[10.5px] font-semibold ${p.aspect === a ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)]'}`}>
                {a}
              </button>
            ))}
          </div>
          <div class="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => void save()} disabled={!!busy || !draft}
              class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[12px] text-[12px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50">
              {busy === 'save' ? <Loader2 size={12} class="animate-spin" /> : <Check size={12} />} Save
            </button>
            <button type="button" onClick={() => void render()} disabled={!!busy || itemIds.length === 0}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] text-[12px] font-semibold bg-emerald-600 text-white disabled:opacity-50">
              {busy === 'render' ? <><Loader2 size={13} class="animate-spin" /> Starting...</> : <><Play size={13} /> Render</>}
            </button>
          </div>
        </div>

        {/* Latest render */}
        {job && (
          <div class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-elevated)]/40 p-2.5 space-y-2">
            <div class="flex items-center gap-2">
              {statusChip(job.status)}
              <span class="text-[11px] text-[var(--color-text-faint)]">latest render</span>
              {(job.status === 'ready' || job.status === 'qc_failed') && (
                <a href={tokenizedSseUrl(`/api/renders/${job.id}/output`)} download={`project-${p.id}.mp4`}
                  class="press-target ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  <Download size={11} /> Download
                </a>
              )}
            </div>
            {job.error && <div class="text-[11.5px] text-red-300">{job.error}</div>}
            {(job.status === 'ready' || job.status === 'qc_failed') && (
              <video src={tokenizedSseUrl(`/api/renders/${job.id}/output`)} controls playsInline preload="metadata"
                class="max-h-[380px] rounded-[12px] bg-black mx-auto" />
            )}
          </div>
        )}

        {err && <div class="text-[11.5px] text-red-300">{err}</div>}
      </div>
    </Modal>
  );
}

function statusChip(status: string) {
  if (status === 'ready') return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">ready</span>;
  if (ACTIVE.has(status)) return (
    <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 inline-flex items-center gap-1">
      <Loader2 size={9} class="animate-spin" /> {status}
    </span>
  );
  if (status === 'qc_failed') return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-500/15 text-orange-400">QC failed</span>;
  if (['idea', 'approved', 'done', 'archived'].includes(status)) {
    return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--color-elevated)] text-[var(--color-text-muted)]">{status}</span>;
  }
  return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/15 text-red-400">failed</span>;
}

export function EditBay() {
  const jobsState = useFetch<{ jobs: RenderJob[] }>('/api/renders', 5_000);
  const libState = useFetch<{ items: LibraryVideo[] }>('/api/library?status=ready&limit=100', 30_000);
  const [picking, setPicking] = useState(false);
  const [aspect, setAspect] = useState<'9:16' | '16:9'>('9:16');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const jobs = jobsState.data?.jobs ?? [];
  const videos = useMemo(
    () => (libState.data?.items ?? []).filter((i) => i.media_type === 'video' && i.media_file),
    [libState.data],
  );
  const cold = jobsState.loading && !jobsState.data;

  async function queueRender(itemId: string) {
    setBusy(itemId); setMsg(null);
    try {
      await apiPost('/api/renders', { item_id: itemId, aspect });
      setPicking(false);
      jobsState.refresh();
    } catch (e: any) {
      setMsg(e?.body?.error || 'Could not queue the render.');
    } finally { setBusy(null); }
  }

  async function retry(job: RenderJob) {
    setBusy(job.id);
    try { await apiPost(`/api/renders/${job.id}/retry`, {}); jobsState.refresh(); }
    catch (e: any) { setMsg(e?.body?.error || 'Retry failed.'); }
    finally { setBusy(null); }
  }

  async function remove(job: RenderJob) {
    if (!confirm('Delete this render and its output file?')) return;
    setBusy(job.id);
    try { await apiDelete(`/api/renders/${job.id}`); jobsState.refresh(); }
    catch { /* surfaced by poll */ } finally { setBusy(null); }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Edit Bay"
        actions={
          <button type="button" onClick={() => setPicking((p) => !p)}
            class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity">
            <Plus size={14} /> New render
          </button>
        }
      />

      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pb-6 space-y-3">
        {msg && <div class="text-[11.5px] text-red-300">{msg}</div>}

        <ProjectsSection videos={videos} />

        {/* Picker: caption any library video */}
        {picking && (
          <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
            <div class="flex items-center gap-2">
              <span class="text-[12px] font-semibold text-[var(--color-text)]">Caption a library video</span>
              <div class="inline-flex rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] p-0.5 ml-auto">
                {(['9:16', '16:9'] as const).map((a) => (
                  <button key={a} type="button" onClick={() => setAspect(a)}
                    class={`press-target px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${aspect === a ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)]'}`}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            {videos.length === 0 ? (
              <div class="text-[12px] text-[var(--color-text-muted)]">No ready videos in the library yet.</div>
            ) : (
              <div class="max-h-[300px] overflow-y-auto space-y-1">
                {videos.map((v) => (
                  <button key={v.id} type="button" disabled={busy === v.id} onClick={() => void queueRender(v.id)}
                    class="press-target w-full text-left px-2.5 py-1.5 rounded-[10px] text-[12px] text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)] transition-colors flex items-center gap-2">
                    {busy === v.id ? <Loader2 size={12} class="animate-spin shrink-0" /> : <Film size={12} class="shrink-0" />}
                    <span class="truncate flex-1">{(v.content_angle || v.caption || v.url).split('\n')[0].slice(0, 90)}</span>
                    <span class="text-[10px] text-[var(--color-text-faint)] shrink-0">{v.author_handle ?? v.author_name ?? ''}{v.duration_s ? ` · ${Math.round(v.duration_s)}s` : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {cold && <PageState loading />}
        {jobsState.error && <PageState error={jobsState.error} />}

        {!cold && !jobsState.error && jobs.length === 0 && !picking && (
          <div class="py-16 text-center">
            <div class="text-[14px] font-medium text-[var(--color-text)] mb-1.5">No renders yet</div>
            <div class="text-[12px] text-[var(--color-text-muted)] max-w-md mx-auto">
              Hit "New render" to caption a library video: word-synced animated captions, rendered locally. Anchor-cut and faceless pipelines land here next.
            </div>
          </div>
        )}

        <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold pt-2">Renders</div>
        {jobs.map((job) => (
          <div key={job.id} class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              {statusChip(job.status)}
              <span class="text-[12px] font-medium text-[var(--color-text)] truncate flex-1">
                {job.item_label ?? job.id}
              </span>
              <span class="text-[10.5px] text-[var(--color-text-faint)]">
                {(() => { try { return JSON.parse(job.spec ?? '{}').aspect ?? ''; } catch { return ''; } })()}
                {job.item_author ? ` · ${job.item_author}` : ''}
              </span>
              {(job.status === 'failed' || job.status === 'qc_failed') && (
                <button type="button" onClick={() => void retry(job)} disabled={busy === job.id}
                  class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors">
                  <RefreshCw size={11} /> Retry
                </button>
              )}
              {job.status === 'ready' && (
                <a href={tokenizedSseUrl(`/api/renders/${job.id}/output`)} download={`render-${job.id}.mp4`}
                  class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
                  <Download size={11} /> Download
                </a>
              )}
              <button type="button" onClick={() => void remove(job)} disabled={busy === job.id}
                class="press-target inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] text-red-400/80 hover:text-red-400 transition-colors">
                <Trash2 size={11} />
              </button>
            </div>
            {(job.status === 'failed' || job.status === 'qc_failed') && job.error && (
              <div class="text-[11.5px] text-red-300">{job.error}</div>
            )}
            {(job.status === 'ready' || job.status === 'qc_failed') && (
              <video src={tokenizedSseUrl(`/api/renders/${job.id}/output`)} controls playsInline preload="metadata"
                class="max-h-[420px] rounded-[12px] bg-black mx-auto" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
