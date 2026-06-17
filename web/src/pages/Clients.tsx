import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Plus, Loader2, Briefcase, Trash2, FileText, Copy, Sparkles, Search, Folder, Send, X as XIcon } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill, type Tone } from '@/components/Pill';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch, apiDelete, tokenizedSseUrl } from '@/lib/api';

// Clients room: the operating system for the AI agency lane (Oswalt's AI
// Solutions). Pipeline of local service businesses + per-client artifacts.
// First demo generator: same-day service texts from a pasted route sheet,
// the Good Nature CEO's stated need and the quarterly-pitch centerpiece.

interface Client {
  id: string; company: string;
  contact_name: string | null; contact_role: string | null; contact_info: string | null;
  industry: string | null; location: string | null;
  stage: string; pain_points: string | null; notes: string | null;
  next_action: string | null; next_action_due: number | null;
  monthly_value: number | null;
  contacted_at: number | null; replied_at: number | null;
  last_touch_at: number | null; next_touch_at: number | null;
  created_at: number; updated_at: number;
}

interface Artifact {
  id: string; client_id: string; kind: string; title: string | null;
  content: string | null; created_at: number;
}

const STAGES = ['lead', 'contacted', 'pitched', 'pilot', 'active', 'closed_won', 'closed_lost'] as const;
const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead', contacted: 'Contacted', pitched: 'Pitched', pilot: 'Pilot',
  active: 'Active', closed_won: 'Won', closed_lost: 'Lost',
};
const STAGE_TONE: Record<string, Tone> = {
  lead: 'neutral', contacted: 'queued', pitched: 'medium', pilot: 'running',
  active: 'done', closed_won: 'done', closed_lost: 'failed',
};

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Whole-day difference from today to ts (local): -1 = yesterday, 0 = today. */
function dayDiff(ts: number): number {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(ts * 1000); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function dueLabel(ts: number): string {
  const d = dayDiff(ts);
  if (d < 0) return `overdue ${-d}d`;
  if (d === 0) return 'due today';
  if (d === 1) return 'tomorrow';
  return `in ${d}d`;
}

function shortDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toDateInput(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Date input -> epoch at 9am local, so "due today" stays true all day. */
function fromDateInput(v: string): number | null {
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(new Date(y, m - 1, d, 9, 0, 0).getTime() / 1000);
}

export function Clients() {
  const [stageFilter, setStageFilter] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const listPath = useMemo(
    () => `/api/clients${stageFilter ? `?stage=${stageFilter}` : ''}`,
    [stageFilter],
  );
  const list = useFetch<{ clients: Client[] }>(listPath, 15_000);
  const clients = list.data?.clients ?? [];

  const dueCount = clients.filter((c) => c.next_touch_at && dayDiff(c.next_touch_at) <= 0).length;
  const visible = dueOnly
    ? clients.filter((c) => c.next_touch_at && dayDiff(c.next_touch_at) <= 0)
        .sort((a, b) => (a.next_touch_at ?? 0) - (b.next_touch_at ?? 0))
    : clients;

  const pipelineValue = clients
    .filter((c) => c.stage === 'active')
    .reduce((s, c) => s + (c.monthly_value ?? 0), 0);

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Clients"
        actions={
          <button type="button" onClick={() => setAdding(true)}
            class="press-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[12px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            <Plus size={12} /> Add client
          </button>
        }
      />

      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pb-6 space-y-4">
        <div class="flex items-center gap-2 flex-wrap pt-1">
          <button type="button" onClick={() => setStageFilter('')}
            class={`press-target px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${!stageFilter ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
            All {clients.length ? `(${clients.length})` : ''}
          </button>
          {STAGES.map((s) => (
            <button key={s} type="button" onClick={() => setStageFilter(s)}
              class={`press-target px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${stageFilter === s ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
              {STAGE_LABEL[s]}
            </button>
          ))}
          {(dueCount > 0 || dueOnly) && (
            <button type="button" onClick={() => setDueOnly(!dueOnly)}
              class={`press-target px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-colors ${dueOnly ? 'border-transparent bg-amber-500/15 text-amber-400' : 'border-amber-500/40 text-amber-400'}`}>
              Follow-ups due ({dueCount})
            </button>
          )}
          {pipelineValue > 0 && (
            <span class="ml-auto text-[12px] text-[var(--color-text-muted)]">${pipelineValue.toFixed(0)}/mo active</span>
          )}
        </div>

        <PageState
          loading={list.loading && !list.data}
          error={list.error}
          empty={!list.loading && !list.error && clients.length === 0}
          emptyTitle="No clients yet"
          emptyDescription="Add the first business to the pipeline. Good Nature is the natural first card."
        />

        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {visible.map((c) => (
            <button key={c.id} type="button" onClick={() => setOpenId(c.id)}
              class="press-target text-left rounded-[16px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 hover:border-[var(--color-accent)]/50 transition-colors">
              <div class="flex items-center gap-2">
                <Briefcase size={14} class="text-[var(--color-text-faint)] shrink-0" />
                <span class="text-[13px] font-semibold text-[var(--color-text)] truncate">{c.company}</span>
                <span class="ml-auto"><Pill tone={STAGE_TONE[c.stage] ?? 'neutral'}>{STAGE_LABEL[c.stage] ?? c.stage}</Pill></span>
              </div>
              <div class="text-[11.5px] text-[var(--color-text-muted)] mt-1.5 truncate">
                {[c.contact_name, c.industry, c.location].filter(Boolean).join(' · ') || 'no details yet'}
              </div>
              {(c.contacted_at || c.replied_at || c.next_touch_at) && (
                <div class="flex items-center gap-2 flex-wrap mt-1 text-[11px]">
                  {c.replied_at ? (
                    <span class="text-emerald-400">replied {ago(c.replied_at)}</span>
                  ) : c.contacted_at ? (
                    <span class="text-[var(--color-text-muted)]">contacted {ago(c.contacted_at)} · awaiting reply</span>
                  ) : null}
                  {c.next_touch_at && (
                    <span class={dayDiff(c.next_touch_at) <= 0 ? 'text-amber-400 font-semibold' : 'text-[var(--color-text-faint)]'}>
                      follow-up {dueLabel(c.next_touch_at)}
                    </span>
                  )}
                </div>
              )}
              {c.next_action && (
                <div class="text-[11.5px] text-[var(--color-accent)] mt-1 truncate">Next: {c.next_action}</div>
              )}
              <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1.5">updated {ago(c.updated_at)}</div>
            </button>
          ))}
        </div>
      </div>

      {adding && <AddClientModal onClose={() => setAdding(false)} onAdded={() => { setAdding(false); list.refresh(); }} />}
      {openId && <ClientDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => list.refresh()} />}
    </div>
  );
}

function AddClientModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [company, setCompany] = useState('');
  const [contact, setContact] = useState('');
  const [industry, setIndustry] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!company.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost('/api/clients', { company, contact_name: contact || null, industry: industry || null, location: location || null });
      onAdded();
    } catch (e: any) {
      setErr(e?.body?.error || 'Could not add client.');
      setBusy(false);
    }
  }

  const field = 'w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-2 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors';
  return (
    <Modal open onClose={onClose} title="Add client" width={460}>
      <div class="space-y-2.5">
        <input class={field} placeholder="Company (required)" value={company} onInput={(e) => setCompany((e.target as HTMLInputElement).value)} />
        <input class={field} placeholder="Contact name" value={contact} onInput={(e) => setContact((e.target as HTMLInputElement).value)} />
        <input class={field} placeholder="Industry (lawn care, HVAC, ...)" value={industry} onInput={(e) => setIndustry((e.target as HTMLInputElement).value)} />
        <input class={field} placeholder="Location" value={location} onInput={(e) => setLocation((e.target as HTMLInputElement).value)} />
        {err && <div class="text-[12px] text-red-400">{err}</div>}
        <button type="button" disabled={busy || !company.trim()} onClick={() => void save()}
          class="press-target w-full py-2 rounded-[10px] text-[13px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-40">
          {busy ? <Loader2 size={13} class="animate-spin inline" /> : 'Add to pipeline'}
        </button>
      </div>
    </Modal>
  );
}

function artifactStatus(a: Artifact): string {
  const m = (a.content ?? '').match(/"status":"(queued|running|ready|failed)"/);
  return m?.[1] ?? 'ready';
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** Measured token burn from the job's usage summary (cheap regex; full JSON
 *  parse only happens in the artifact modal). */
function artifactBurn(a: Artifact): string | null {
  const m = (a.content ?? '').match(/"usage":\{"legs":\d+,"tokens_in":(\d+),"tokens_out":(\d+)/);
  if (!m) return null;
  return `${fmtK(+m[1])} in / ${fmtK(+m[2])} out`;
}

/** Render text with URLs as clickable links; also catches bare
 *  linkedin.com/... references the research notes often contain. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+|(?:www\.)?linkedin\.com\/[\w\-/%.]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        const isUrl = /^https?:\/\//.test(p);
        const isBareLinkedin = !isUrl && /^(www\.)?linkedin\.com\//.test(p);
        if (!isUrl && !isBareLinkedin) return <span key={i}>{p}</span>;
        const href = isBareLinkedin ? `https://${p}` : p;
        const label = p.replace(/^https?:\/\/(www\.)?/, '').replace(/[),.]+$/, '');
        return (
          <a key={i} href={href} target="_blank" rel="noreferrer"
            class="text-[var(--color-accent)] hover:underline break-all">
            {label.slice(0, 48)}{label.length > 60 ? '…' : ''}
          </a>
        );
      })}
    </>
  );
}

/** Read-friendly text block: "LABEL: value" lines become labeled rows, other
 *  lines become bullets/paragraphs, URLs are clickable. Edit on demand. */
function TextSection({ label, value, bullets, onSave }: {
  label: string; value: string | null; bullets?: boolean; onSave: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const field = 'w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors';
  const lines = (value ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <div>
      <div class="flex items-center gap-2 mb-1">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
        <button type="button" onClick={() => setEditing(!editing)}
          class="press-target text-[10px] text-[var(--color-text-faint)] hover:text-[var(--color-accent)] uppercase tracking-wider">
          {editing ? 'done' : 'edit'}
        </button>
      </div>
      {editing ? (
        <textarea class={`${field} min-h-[200px] leading-relaxed`} value={value ?? ''}
          onBlur={(e) => { onSave((e.target as HTMLTextAreaElement).value || null); setEditing(false); }} />
      ) : lines.length === 0 ? (
        <div class="text-[12px] text-[var(--color-text-faint)]">empty</div>
      ) : (
        <div class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 space-y-1.5">
          {lines.map((line, i) => {
            const m = line.match(/^([A-Z][A-Z _/]{1,14}):\s*(.+)$/);
            if (m) {
              return (
                <div key={i} class="text-[12.5px] leading-relaxed">
                  <span class="inline-block min-w-[64px] mr-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">{m[1]}</span>
                  <span class="text-[var(--color-text)]"><Linkified text={m[2]} /></span>
                </div>
              );
            }
            return bullets ? (
              <div key={i} class="flex gap-2 text-[12.5px] leading-relaxed text-[var(--color-text)]">
                <span class="text-[var(--color-text-faint)] shrink-0">•</span>
                <span><Linkified text={line} /></span>
              </div>
            ) : (
              <p key={i} class="text-[12.5px] leading-relaxed text-[var(--color-text)]"><Linkified text={line} /></p>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ContactEntry { name?: string; role?: string; phone?: string; email?: string; linkedin?: string; note?: string }

function parseContacts(ci: string | null): { contacts: ContactEntry[] | null; raw: string | null } {
  if (!ci) return { contacts: null, raw: null };
  try {
    const j = JSON.parse(ci);
    if (Array.isArray(j?.contacts) && j.contacts.length) return { contacts: j.contacts, raw: null };
  } catch { /* legacy free text */ }
  return { contacts: null, raw: ci };
}

function ContactSection({ client }: { client: Client }) {
  const { contacts, raw } = parseContacts(client.contact_info);
  const [idx, setIdx] = useState(0);

  return (
    <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3 space-y-2">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Contact</div>
      {contacts ? (
        <>
          {contacts.length > 1 && (
            <select value={String(idx)} onChange={(e) => setIdx(parseInt((e.target as HTMLSelectElement).value, 10) || 0)}
              class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)]">
              {contacts.map((c, i) => (
                <option key={i} value={String(i)}>{[c.name, c.role].filter(Boolean).join(' · ') || `Contact ${i + 1}`}</option>
              ))}
            </select>
          )}
          {(() => {
            const c = contacts[Math.min(idx, contacts.length - 1)];
            return (
              <div class="space-y-1 text-[12.5px]">
                <div class="font-semibold text-[var(--color-text)]">{c.name ?? 'Company'}{c.role ? <span class="font-normal text-[var(--color-text-muted)]"> · {c.role}</span> : null}</div>
                {c.phone && (
                  <div class="flex items-center gap-2 text-[var(--color-text)]">
                    <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} class="text-[var(--color-accent)] hover:underline">{c.phone}</a>
                    <button type="button" title="Copy" onClick={() => { void navigator.clipboard.writeText(c.phone!); }} class="press-target opacity-60 hover:opacity-100"><Copy size={11} /></button>
                  </div>
                )}
                {c.email && (
                  <div class="flex items-center gap-2 text-[var(--color-text)]">
                    <a href={`mailto:${c.email}`} class="text-[var(--color-accent)] hover:underline break-all">{c.email}</a>
                    <button type="button" title="Copy" onClick={() => { void navigator.clipboard.writeText(c.email!); }} class="press-target opacity-60 hover:opacity-100"><Copy size={11} /></button>
                  </div>
                )}
                {c.linkedin && (
                  <div>
                    <a href={/^https?:\/\//.test(c.linkedin) ? c.linkedin : `https://${c.linkedin}`}
                      target="_blank" rel="noreferrer"
                      class="text-[var(--color-accent)] hover:underline text-[12px]">
                      LinkedIn profile →
                    </a>
                  </div>
                )}
                {c.note && <div class="text-[11.5px] text-[var(--color-text-muted)]"><Linkified text={c.note} /></div>}
              </div>
            );
          })()}
        </>
      ) : raw ? (
        <div class="text-[12.5px] text-[var(--color-text)] leading-relaxed"><Linkified text={raw} /></div>
      ) : (
        <div class="text-[12px] text-[var(--color-text-faint)]">No contact info yet. The deep dive finds and fills the decision-maker's contact automatically.</div>
      )}
    </div>
  );
}

function ClientDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  // Poll while open: deep dives / pitch drafts complete in the background.
  const state = useFetch<{ client: Client; artifacts: Artifact[] }>(`/api/clients/${id}`, 10_000);
  const client = state.data?.client;
  const artifacts = state.data?.artifacts ?? [];

  // The service-texts demo was built for Good Nature's specific text-ahead
  // problem and shows ONLY on their card (Gabe 2026-06-11: not on other
  // clients, not even other lawn companies). Everyone else: research flow.
  const showServiceTextsDemo = !!client && /good nature/i.test(client.company);

  const dives = artifacts.filter((a) => a.kind === 'deep_dive');
  const pitches = artifacts.filter((a) => a.kind === 'full_pitch');
  const demoSites = artifacts.filter((a) => a.kind === 'demo_site');
  const diveActive = dives.some((a) => ['queued', 'running'].includes(artifactStatus(a)));
  const diveReady = dives.some((a) => artifactStatus(a) === 'ready');
  const pitchActive = pitches.some((a) => ['queued', 'running'].includes(artifactStatus(a)));
  const siteActive = demoSites.some((a) => ['queued', 'running'].includes(artifactStatus(a)));
  const [researchErr, setResearchErr] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const latestReadyDive = dives.find((a) => artifactStatus(a) === 'ready') ?? null;

  async function openFolder() {
    try {
      const r = await apiPost<{ path: string; opened: boolean }>(`/api/clients/${id}/open-folder`);
      // If Explorer couldn't be launched from the server, show the path to copy.
      setFolderPath(r.opened ? null : r.path);
    } catch {
      setFolderPath('Could not resolve folder.');
    }
  }

  async function startResearch(path: 'deepdive' | 'pitch' | 'demosite') {
    setResearchErr(null);
    try {
      await apiPost(`/api/clients/${id}/${path}`);
      state.refresh();
    } catch (e: any) {
      setResearchErr(e?.body?.error || 'Could not start.');
    }
  }

  // Outreach tracking: log touches, set the next follow-up date.
  const touches = artifacts.filter((a) => a.kind === 'outreach');
  const docs = artifacts.filter((a) => a.kind !== 'outreach');
  const [channel, setChannel] = useState('call');
  const [touchNote, setTouchNote] = useState('');
  const [touchBusy, setTouchBusy] = useState(false);
  const [touchErr, setTouchErr] = useState<string | null>(null);

  async function logTouch(direction: 'out' | 'reply') {
    setTouchBusy(true);
    setTouchErr(null);
    try {
      await apiPost(`/api/clients/${id}/touch`, { direction, channel, note: touchNote.trim() || null });
      setTouchNote('');
      state.refresh();
      onChanged();
    } catch (e: any) {
      setTouchErr(e?.body?.error || 'Could not log it.');
    } finally {
      setTouchBusy(false);
    }
  }

  const [sheet, setSheet] = useState('');
  const [mode, setMode] = useState<'day_before' | 'after_service'>('day_before');
  const [visitDay, setVisitDay] = useState('tomorrow');
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);

  async function patch(p: Record<string, unknown>) {
    await apiPatch(`/api/clients/${id}`, p);
    state.refresh();
    onChanged();
  }

  async function generate() {
    if (!sheet.trim()) return;
    setGenBusy(true);
    setGenErr(null);
    try {
      await apiPost(`/api/clients/${id}/demo/service-texts`, { sheet, mode, visit_day: visitDay });
      setSheet('');
      state.refresh();
    } catch (e: any) {
      setGenErr(e?.body?.error || 'Generation failed.');
    } finally {
      setGenBusy(false);
    }
  }

  async function removeArtifact(aid: string) {
    await apiDelete(`/api/clients/${id}/artifacts/${aid}`);
    state.refresh();
  }

  async function removeClient() {
    if (!confirm('Remove this client and all artifacts?')) return;
    await apiDelete(`/api/clients/${id}`);
    onChanged();
    onClose();
  }

  if (!client) {
    return (
      <Modal open onClose={onClose} title="Client" width={760}>
        <PageState loading={state.loading} error={state.error} />
      </Modal>
    );
  }

  const field = 'w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors';

  return (
    <Modal open onClose={onClose} title={client.company} width={880}>
      <div class="space-y-3.5">
        {/* Stage + actions */}
        <div class="flex items-center gap-2 flex-wrap">
          <select value={client.stage} onChange={(e) => void patch({ stage: (e.target as HTMLSelectElement).value })}
            class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)]">
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          <span class="text-[11.5px] text-[var(--color-text-muted)]">
            {[client.contact_name, client.contact_role, client.industry, client.location].filter(Boolean).join(' · ')}
          </span>
          <button type="button" onClick={() => void removeClient()}
            class="press-target ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors">
            <Trash2 size={11} /> Remove
          </button>
        </div>

        {/* Outreach tracking: who's been touched, when to follow up */}
        <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3 space-y-2">
          <div class="flex items-center gap-2 flex-wrap">
            <div class="text-[12px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
              <Send size={13} class="text-[var(--color-accent)]" /> Outreach
            </div>
            <span class="text-[11.5px] text-[var(--color-text-muted)]">
              {client.replied_at
                ? `contacted ${client.contacted_at ? shortDate(client.contacted_at) : '—'} · replied ${shortDate(client.replied_at)}`
                : client.contacted_at
                  ? `contacted ${shortDate(client.contacted_at)} · awaiting reply`
                  : 'not contacted yet'}
            </span>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <select value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value)}
              class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)]">
              {['call', 'email', 'text', 'linkedin', 'in person', 'other'].map((ch) => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
            <input class="flex-1 min-w-[160px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors"
              value={touchNote} placeholder="optional note (left voicemail, talked to office manager, ...)"
              onInput={(e) => setTouchNote((e.target as HTMLInputElement).value)} />
            <button type="button" disabled={touchBusy} onClick={() => void logTouch('out')}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-40">
              {touchBusy ? <Loader2 size={12} class="animate-spin" /> : <Send size={12} />} I reached out
            </button>
            <button type="button" disabled={touchBusy} onClick={() => void logTouch('reply')}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40">
              They replied
            </button>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">Next follow-up</span>
            <input type="date" value={toDateInput(client.next_touch_at)}
              onChange={(e) => void patch({ next_touch_at: fromDateInput((e.target as HTMLInputElement).value) })}
              class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1 text-[12px] text-[var(--color-text)]" />
            {client.next_touch_at && (
              <>
                <span class={dayDiff(client.next_touch_at) <= 0 ? 'text-[11.5px] text-amber-400 font-semibold' : 'text-[11.5px] text-[var(--color-text-muted)]'}>
                  {dueLabel(client.next_touch_at)}
                </span>
                <button type="button" onClick={() => void patch({ next_touch_at: null })}
                  class="press-target text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text)] uppercase tracking-wider">
                  clear
                </button>
              </>
            )}
          </div>
          {touchErr && <div class="text-[12px] text-red-400">{touchErr}</div>}
          {touches.length > 0 && (
            <div class="space-y-1 pt-1 border-t border-[var(--color-border)]">
              {touches.map((t) => {
                let p: { direction?: string; channel?: string; note?: string; at?: number } = {};
                try { p = t.content ? JSON.parse(t.content) : {}; } catch { /* legacy */ }
                const out = p.direction === 'out';
                return (
                  <div key={t.id} class="flex items-start gap-2 text-[12px]">
                    <span class={`shrink-0 ${out ? 'text-[var(--color-accent)]' : 'text-emerald-400'}`}>{out ? '→' : '←'}</span>
                    <span class="text-[var(--color-text)]">{out ? 'reached out' : 'they replied'} via {p.channel ?? '?'}</span>
                    {p.note && <span class="text-[var(--color-text-muted)]">· {p.note}</span>}
                    <span class="ml-auto shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{p.at ? shortDate(p.at) : ago(t.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pain points + notes: formatted read views, edit on demand */}
        <TextSection label="Pain points" value={client.pain_points} bullets
          onSave={(v) => void patch({ pain_points: v })} />
        <TextSection label="Notes" value={client.notes}
          onSave={(v) => void patch({ notes: v })} />
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Next step (just a reminder note for you)</div>
          <input class={field} value={client.next_action ?? ''} placeholder="e.g. Call the owner Tuesday morning"
            onBlur={(e) => void patch({ next_action: (e.target as HTMLInputElement).value || null })} />
        </div>

        {/* Research flow: deep dive on your green light, pitch after approval */}
        <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3 space-y-2">
          <div class="text-[12px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
            <Sparkles size={13} class="text-[var(--color-accent)]" /> Research
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)]">
            Step 1: the deep dive verifies the business, ranks how we could help, checks what competitors do digitally, and proposes how to reach out.
            Step 2 (after you approve): a bespoke pitch document written for this company specifically.
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button type="button" disabled={diveActive} onClick={() => void startResearch('deepdive')}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-40">
              {diveActive ? <Loader2 size={12} class="animate-spin" /> : <Search size={12} />}
              {diveActive ? 'Deep dive running…' : diveReady ? 'Re-run deep dive' : 'Run deep dive'}
            </button>
            <button type="button" disabled={!diveReady || pitchActive} onClick={() => void startResearch('pitch')}
              title={!diveReady ? 'Run the deep dive first' : ''}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-[var(--color-border)] text-[var(--color-text)] disabled:opacity-40">
              {pitchActive ? <Loader2 size={12} class="animate-spin" /> : <FileText size={12} />}
              {pitchActive ? 'Pitch drafting…' : 'Draft full pitch'}
            </button>
            <button type="button" disabled={!diveReady || siteActive} onClick={() => void startResearch('demosite')}
              title={!diveReady ? 'Run the deep dive first' : 'A modern landing-page concept for THEIR business, to show in the pitch'}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-[var(--color-border)] text-[var(--color-text)] disabled:opacity-40">
              {siteActive ? <Loader2 size={12} class="animate-spin" /> : <Sparkles size={12} />}
              {siteActive ? 'Demo site building…' : 'Build demo site'}
            </button>
            {latestReadyDive && (
              <button type="button" onClick={() => setOpenArtifact(latestReadyDive)}
                class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white transition-colors">
                <FileText size={12} /> View brief
              </button>
            )}
            <button type="button" onClick={() => void openFolder()}
              title="Opens this company's docs folder in your File Explorer (Desktop > Oswalts AI Solutions > Clients)"
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
              <Folder size={12} /> Open folder
            </button>
          </div>
          {researchErr && <div class="text-[12px] text-red-400">{researchErr}</div>}
          {folderPath && (
            <div class="text-[11.5px] text-[var(--color-text-muted)]">
              Folder: <span class="font-mono text-[var(--color-text)]">{folderPath}</span>
              <button type="button" class="press-target ml-2 opacity-60 hover:opacity-100" title="Copy path"
                onClick={() => { void navigator.clipboard.writeText(folderPath); }}><Copy size={11} /></button>
            </div>
          )}
        </div>

        {/* Demo generator (route-visit businesses only; built for Good Nature) */}
        {showServiceTextsDemo && (
        <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3 space-y-2">
          <div class="text-[12px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
            <Sparkles size={13} class="text-[var(--color-accent)]" /> Service-texts demo
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as 'day_before' | 'after_service')}
              class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)]">
              <option value="day_before">Day-before notice (we'll be out + planned service)</option>
              <option value="after_service">After-service recap (what we did today)</option>
            </select>
            {mode === 'day_before' && (
              <input class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-3 py-1.5 text-[12px] text-[var(--color-text)] w-[130px]"
                value={visitDay} onInput={(e) => setVisitDay((e.target as HTMLInputElement).value)} placeholder="tomorrow" title="Default visit day (per-row 6th column overrides, e.g. Saturday / Monday for Friday sends)" />
            )}
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)]">
            Paste a route sheet (one visit per line: customer, address, services, tech, notes, visit day; comma / tab / pipe separated).
            {mode === 'day_before'
              ? ' Generates the day-before "we\'ll be out and here\'s the planned service" notice per customer. Friday sends: put Saturday or Monday in the 6th column per row.'
              : ' Generates the same-day "here\'s exactly what we did" recap per customer.'}
          </div>
          <textarea class={`${field} min-h-[96px] font-mono text-[11.5px]`} value={sheet}
            placeholder={'Sarah Mitchell, 1284 Maple Ave, aeration + overseeding, Mike\nDan Kowalski, 77 Birchwood Dr, organic fertilization round 3, Mike, gate code 4412, Saturday'}
            onInput={(e) => setSheet((e.target as HTMLTextAreaElement).value)} />
          {genErr && <div class="text-[12px] text-red-400">{genErr}</div>}
          <button type="button" disabled={genBusy || !sheet.trim()} onClick={() => void generate()}
            class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-40">
            {genBusy ? <Loader2 size={12} class="animate-spin" /> : <Sparkles size={12} />} Generate texts
          </button>
        </div>
        )}

        {/* Contact: decision-maker info, auto-filled by the deep dive */}
        <ContactSection client={client} />

        {/* Artifacts */}
        <div class="space-y-1.5">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Artifacts</div>
          {docs.length === 0 && <div class="text-[11.5px] text-[var(--color-text-muted)]">None yet. Run a deep dive above; results land here.</div>}
          {docs.map((a) => {
            const st = artifactStatus(a);
            return (
              <div key={a.id} class="flex items-center gap-2 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                <FileText size={13} class="text-[var(--color-text-faint)] shrink-0" />
                <button type="button" onClick={() => setOpenArtifact(a)} class="press-target text-left text-[12.5px] text-[var(--color-text)] truncate hover:text-[var(--color-accent)]">
                  {a.title ?? a.kind}
                </button>
                {st !== 'ready' && (
                  <Pill tone={st === 'failed' ? 'failed' : 'running'}>{st}</Pill>
                )}
                {a.kind === 'demo_site' && st === 'ready' && (
                  <a href={tokenizedSseUrl(`/api/clients/${id}/artifacts/${a.id}/site`)} target="_blank" rel="noreferrer"
                    class="press-target text-[11px] font-semibold text-[var(--color-accent)] hover:underline shrink-0">
                    Open site ↗
                  </a>
                )}
                {artifactBurn(a) && (
                  <span class="text-[10px] text-[var(--color-text-faint)] shrink-0" title="Measured token burn (in / out)">{artifactBurn(a)}</span>
                )}
                <span class="ml-auto text-[10.5px] text-[var(--color-text-faint)] shrink-0">{ago(a.created_at)}</span>
                <button type="button" title="Delete artifact" onClick={() => void removeArtifact(a.id)} class="press-target opacity-60 hover:opacity-100">
                  <XIcon size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {openArtifact && <ArtifactModal artifact={openArtifact} onClose={() => setOpenArtifact(null)} />}
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="space-y-1">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
      {children}
    </div>
  );
}

function ArtifactModal({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const parsed = (() => {
    try { return artifact.content ? JSON.parse(artifact.content) : null; } catch { return null; }
  })();
  const messages: Array<{ customer: string; sms: string }> = parsed?.messages ?? [];
  const status = parsed?.status as string | undefined;

  return (
    <Modal open onClose={onClose} title={artifact.title ?? artifact.kind} width={720}>
      <div class="space-y-3">
        {status === 'failed' && (
          <div class="text-[12px] text-red-400">Failed: {parsed?.error ?? 'unknown error'}. Re-run from the client card.</div>
        )}
        {(status === 'queued' || status === 'running') && (
          <div class="text-[12px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
            <Loader2 size={12} class="animate-spin" /> Working on it; this card updates automatically.
          </div>
        )}

        {/* Deep dive rendering */}
        {artifact.kind === 'deep_dive' && status === 'ready' && (
          <div class="space-y-3">
            <Section label="Profile">
              <p class="text-[12.5px] text-[var(--color-text)] leading-snug whitespace-pre-wrap">{parsed.profile}</p>
            </Section>
            <Section label="How we could help (ranked)">
              {(parsed.opportunities ?? []).map((o: any, i: number) => (
                <div key={i} class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 mb-1.5">
                  <div class="text-[12.5px] font-semibold text-[var(--color-text)]">{i + 1}. {o.title}</div>
                  <div class="text-[12px] text-[var(--color-text-muted)] mt-1"><b>Broken:</b> {o.whats_broken}</div>
                  <div class="text-[12px] text-[var(--color-text-muted)] mt-0.5"><b>We build:</b> {o.what_wed_build}</div>
                  <div class="text-[12px] text-[var(--color-accent)] mt-0.5"><b>Impact:</b> {o.business_impact}</div>
                </div>
              ))}
            </Section>
            {(parsed.review_themes ?? []).length > 0 && (
              <Section label="What customers keep saying">
                {(parsed.review_themes as string[]).map((t, i) => (
                  <div key={i} class="flex gap-2 text-[12px] text-[var(--color-text-muted)] mb-1">
                    <span class="text-[var(--color-text-faint)] shrink-0">•</span><span>{t}</span>
                  </div>
                ))}
              </Section>
            )}
            {(parsed.internal_ops_signals ?? []).length > 0 && (
              <Section label="Inside the business (public signals)">
                {(parsed.internal_ops_signals as string[]).map((t, i) => (
                  <div key={i} class="flex gap-2 text-[12px] text-[var(--color-text-muted)] mb-1">
                    <span class="text-[var(--color-accent)] shrink-0">→</span><span>{t}</span>
                  </div>
                ))}
              </Section>
            )}
            {(parsed.fixable_problems ?? []).length > 0 && (
              <Section label="Fixable problems we found">
                {(parsed.fixable_problems as any[]).map((f, i) => (
                  <div key={i} class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 mb-1.5">
                    <div class="text-[12.5px] font-semibold text-[var(--color-text)]">{f.problem}</div>
                    {f.evidence && <div class="text-[12px] text-[var(--color-text-muted)] mt-1"><b>Evidence:</b> {f.evidence}</div>}
                    {f.fix && <div class="text-[12px] text-[var(--color-accent)] mt-0.5"><b>Our fix:</b> {f.fix}</div>}
                  </div>
                ))}
              </Section>
            )}
            {(parsed.ads_status || parsed.social_status) && (
              <Section label="Marketing posture">
                {parsed.ads_status && <div class="text-[12px] text-[var(--color-text-muted)] mb-1"><b class="text-[var(--color-text)]">Advertising:</b> {parsed.ads_status}</div>}
                {parsed.social_status && <div class="text-[12px] text-[var(--color-text-muted)]"><b class="text-[var(--color-text)]">Social:</b> {parsed.social_status}</div>}
              </Section>
            )}
            <Section label="Competitors">
              {(parsed.competitors ?? []).map((c: any, i: number) => (
                <div key={i} class="text-[12px] text-[var(--color-text-muted)] mb-1">
                  <b class="text-[var(--color-text)]">{c.name}:</b> {c.digital_edge} <i>{c.implication}</i>
                </div>
              ))}
            </Section>
            {parsed.outreach && (
              <Section label="How to reach out">
                <div class="rounded-[12px] border border-[var(--color-accent)]/40 bg-[var(--color-surface)] px-3 py-2.5 text-[12px] text-[var(--color-text-muted)] space-y-0.5">
                  <div><b class="text-[var(--color-text)]">Who:</b> {parsed.outreach.who}</div>
                  <div><b class="text-[var(--color-text)]">Channel:</b> {parsed.outreach.channel}</div>
                  <div><b class="text-[var(--color-text)]">Angle:</b> {parsed.outreach.angle}</div>
                  {parsed.outreach.timing && <div><b class="text-[var(--color-text)]">Timing:</b> {parsed.outreach.timing}</div>}
                </div>
              </Section>
            )}
            {(parsed.sources ?? []).length > 0 && (
              <Section label="Sources">
                <div class="text-[11px] text-[var(--color-text-faint)] break-all">{(parsed.sources as string[]).join('  ·  ')}</div>
              </Section>
            )}
            {parsed.usage && (
              <div class="text-[11px] text-[var(--color-text-faint)]">
                Burn (measured): {fmtK(parsed.usage.tokens_in ?? 0)} in / {fmtK(parsed.usage.tokens_out ?? 0)} out
                {' '}· {parsed.usage.legs} legs · {((parsed.usage.duration_ms ?? 0) / 60000).toFixed(1)} min
                {parsed.usage.retries > 0 ? ` · ${parsed.usage.retries} retries` : ''}
              </div>
            )}
          </div>
        )}

        {/* Full pitch rendering */}
        {artifact.kind === 'full_pitch' && status === 'ready' && (
          <div class="space-y-2">
            <button type="button" onClick={() => { void navigator.clipboard.writeText(parsed.markdown ?? ''); }}
              class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <Copy size={11} /> Copy Markdown
            </button>
            <pre class="text-[12.5px] text-[var(--color-text)] whitespace-pre-wrap leading-relaxed font-sans">{parsed.markdown}</pre>
          </div>
        )}

        {/* Service-texts demo rendering */}
        {messages.map((m, i) => (
          <div key={i} class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
            <div class="flex items-center gap-2">
              <span class="text-[11.5px] font-semibold text-[var(--color-text)]">{m.customer}</span>
              <button type="button" title="Copy"
                onClick={() => { void navigator.clipboard.writeText(m.sms); }}
                class="press-target ml-auto opacity-60 hover:opacity-100"><Copy size={12} /></button>
            </div>
            <div class="text-[12.5px] text-[var(--color-text-muted)] mt-1 leading-snug">{m.sms}</div>
            <div class="text-[10px] text-[var(--color-text-faint)] mt-1">{m.sms.length} chars</div>
          </div>
        ))}

        {!parsed && (
          <pre class="text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap">{artifact.content ?? 'empty'}</pre>
        )}
      </div>
    </Modal>
  );
}
