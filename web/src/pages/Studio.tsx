import { useState, useMemo } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import {
  ExternalLink, Loader2, Film, Image as ImageIcon, MessageSquareText,
  Folder, Sparkles, Clapperboard, Flame, FileText, Check, X as XIcon, Copy, Radar, ShieldCheck, Video,
} from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiPost, tokenizedSseUrl } from '@/lib/api';

// ── Types (mirror the content-gate fields on src/db.ts LibraryItem) ──────────
interface StudioItem {
  id: string; url: string; platform: string; source: string;
  author_name: string | null; author_handle: string | null; caption: string | null;
  duration_s: number | null; media_type: string | null;
  media_file: string | null; thumbnail_path: string | null; oembed_html: string | null;
  transcript: string | null; tags: string | null; analysis: string | null;
  intent: string | null; track: string | null; platforms: string | null;
  content_score: number | null; content_angle: string | null;
  cluster_id: string | null;
  status: string; categories?: ItemCategory[];
}
interface ItemCategory { category_id: string; is_primary: number; subcategory: string; umbrella: string; }
interface ContentDraft {
  id: string; item_id: string; track: string; platform: string;
  status: string; brief: string | null; script: string | null;
  model_used: string | null; error: string | null;
  verification: string | null; verification_status: string | null;
  publish_kit: string | null;
  created_at: number; updated_at: number;
}
interface PublishKit { title: string; caption: string; hashtags: string[]; thumbnail_text: string }
interface BriefPayload {
  hook: string; angle: string; story_beats: string[];
  key_facts: Array<{ fact: string; source: string; needs_verification: boolean }>;
  why_now: string; format_notes: string;
}
interface ClaimVerdict {
  index: number; claim: string; verdict: 'confirmed' | 'false' | 'unverified' | 'disputed';
  confidence: string; summary: string; correction: string | null; dispute_reason?: string;
  sources: Array<{ url: string; what_it_shows: string }>;
}
interface VerificationResult {
  claims: ClaimVerdict[];
  summary: { confirmed: number; false: number; unverified: number; disputed: number };
}

const TRACK_TABS = [
  { key: '', label: 'All tracks' },
  { key: 'ai', label: 'AI (TikTok/YT)' },
  { key: 'real_world', label: 'Real-World (IG/X)' },
] as const;

const PLATFORM_OPTS: Record<string, Array<{ key: string; label: string }>> = {
  '':          [{ key: '', label: 'All' }, { key: 'tiktok', label: 'TikTok' }, { key: 'youtube', label: 'YouTube' }, { key: 'instagram', label: 'Instagram' }, { key: 'x', label: 'X' }],
  ai:          [{ key: '', label: 'All' }, { key: 'tiktok', label: 'TikTok' }, { key: 'youtube', label: 'YouTube' }],
  real_world:  [{ key: '', label: 'All' }, { key: 'instagram', label: 'Instagram' }, { key: 'x', label: 'X' }],
};

const SCORE_CHIPS = [
  { key: 0, label: 'All' },
  { key: 55, label: '55+' },
  { key: 70, label: '70+' },
  { key: 85, label: 'Strong 85+' },
];

function mediaUrl(item: StudioItem, file: string | null): string | null {
  if (!file) return null;
  return tokenizedSseUrl(`/api/library/${item.id}/media/${encodeURIComponent(file)}`);
}
function parsePlatforms(item: StudioItem): string[] {
  try { return item.platforms ? (JSON.parse(item.platforms) as string[]) : []; } catch { return []; }
}
function parseTags(item: StudioItem): string[] {
  try { return item.tags ? (JSON.parse(item.tags) as string[]) : []; } catch { return []; }
}
function fmtDuration(s: number | null): string {
  if (!s || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60); const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function scoreClasses(score: number): string {
  if (score >= 80) return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
  if (score >= 60) return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
  return 'bg-slate-500/20 text-slate-300 border-slate-500/40';
}
function trackChip(track: string | null) {
  if (track === 'ai') return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/20 text-indigo-300">AI track</span>;
  if (track === 'real_world') return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/20 text-rose-300">Real-World</span>;
  return null;
}
const PLATFORM_LABEL: Record<string, string> = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', x: 'X' };

// ── Page ─────────────────────────────────────────────────────────────────────
export function Studio() {
  const [track, setTrack] = useState('');
  const [platform, setPlatform] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);

  const listPath = useMemo(() => {
    const p = new URLSearchParams();
    if (track) p.set('track', track);
    if (platform) p.set('platform', platform);
    if (minScore > 0) p.set('min_score', String(minScore));
    const qs = p.toString();
    return `/api/library/studio${qs ? `?${qs}` : ''}`;
  }, [track, platform, minScore]);

  const listState = useFetch<{ items: StudioItem[]; total: number }>(listPath, 8_000);
  const items = listState.data?.items ?? [];
  const cold = listState.loading && !listState.data;
  const openItem = openId ? items.find((i) => i.id === openId) ?? null : null;

  // Same-story grouping: items sharing a cluster_id collapse into one card.
  // Items arrive score-desc, so the first of each group is the strongest take.
  const groups = useMemo(() => {
    const map = new Map<string, StudioItem[]>();
    for (const it of items) {
      const key = it.cluster_id ?? it.id;
      const arr = map.get(key);
      if (arr) arr.push(it); else map.set(key, [it]);
    }
    return map;
  }, [items]);
  const faces = useMemo(() => [...groups.values()].map((g) => g[0]), [groups]);
  const siblingsOf = (it: StudioItem) => (groups.get(it.cluster_id ?? it.id) ?? []).filter((s) => s.id !== it.id);

  const platformOpts = PLATFORM_OPTS[track] ?? PLATFORM_OPTS[''];

  async function sweepNow() {
    setSweeping(true); setSweepMsg(null);
    try {
      const s = await apiPost<{ added: Array<unknown>; errors: string[] }>('/api/library/sweep', {});
      setSweepMsg(s.added.length
        ? `Sweep found ${s.added.length} new opportunit${s.added.length === 1 ? 'y' : 'ies'}.`
        : (s.errors?.length ? `Sweep ran with errors: ${s.errors[0]}` : 'Sweep ran; nothing new worth a video right now.'));
      listState.refresh();
    } catch (e: any) {
      setSweepMsg(e?.body?.errors?.[0] || e?.body?.error || 'Sweep failed.');
    } finally { setSweeping(false); }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Content Studio"
        actions={
          <div class="flex items-center gap-2">
            <span class="hidden md:flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-faint)]">
              <Clapperboard size={13} /> Saves + live events, ranked
            </span>
            <button type="button" onClick={() => void sweepNow()} disabled={sweeping}
              class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-60 transition-colors">
              {sweeping ? <><Loader2 size={13} class="animate-spin" /> Sweeping (~2 min)</> : <><Radar size={13} /> Sweep live events</>}
            </button>
          </div>
        }
      />

      {/* Controls */}
      <div class="px-4 md:px-6 pb-3 space-y-2.5">
        <div class="flex flex-wrap items-center gap-2">
          {/* Track tabs */}
          <div class="inline-flex rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] p-0.5">
            {TRACK_TABS.map((t) => (
              <button key={t.key} type="button"
                onClick={() => { setTrack(t.key); setPlatform(''); }}
                class={`press-target px-3.5 py-1 rounded-full text-[12px] font-semibold transition-colors ${track === t.key ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Platform sub-filter */}
          <div class="flex items-center gap-1.5">
            {platformOpts.map((p) => (
              <button key={p.key} type="button"
                onClick={() => setPlatform(p.key)}
                class={`press-target px-2.5 py-1 rounded-full text-[11px] border transition-colors ${platform === p.key ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}>
                {p.label}
              </button>
            ))}
          </div>

          {/* Score threshold */}
          <div class="flex items-center gap-1.5 ml-auto">
            <Flame size={13} class="text-[var(--color-text-faint)]" />
            {SCORE_CHIPS.map((s) => (
              <button key={s.key} type="button"
                onClick={() => setMinScore(s.key)}
                class={`press-target px-2.5 py-1 rounded-full text-[11px] border transition-colors ${minScore === s.key ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {sweepMsg && <div class="text-[11.5px] text-[var(--color-text-muted)]">{sweepMsg}</div>}
      </div>

      {cold && <PageState loading />}
      {listState.error && <PageState error={listState.error} />}

      {!cold && !listState.error && (
        <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pb-6">
          {items.length === 0 ? (
            <div class="py-16 text-center">
              <div class="text-[14px] font-medium text-[var(--color-text)] mb-1.5">No content opportunities yet</div>
              <div class="text-[12px] text-[var(--color-text-muted)] max-w-md mx-auto">
                As you save posts, the gate flags the ones that fit your two tracks (AI empowerment, real-world truth-telling) and ranks them here by strength. Quant/finance and reference saves stay out of the way.
              </div>
            </div>
          ) : (
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {faces.map((item) => (
                <StudioCard key={item.id} item={item} siblingCount={siblingsOf(item).length} onOpen={() => setOpenId(item.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {openItem && (
        <StudioDrawer item={openItem} siblings={siblingsOf(openItem)} onOpenSibling={setOpenId}
          onClose={() => setOpenId(null)} onChanged={() => listState.refresh()} />
      )}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────
function StudioCard({ item, siblingCount = 0, onOpen }: { item: StudioItem; siblingCount?: number; onOpen: () => void }) {
  const thumb = mediaUrl(item, item.thumbnail_path);
  const tags = parseTags(item);
  const plats = parsePlatforms(item);
  const score = item.content_score ?? 0;
  const primaryCat = (item.categories ?? []).find((c) => c.is_primary) ?? (item.categories ?? [])[0];
  const MediaIcon = item.media_type === 'video' ? Film : item.media_type === 'photo' ? ImageIcon : MessageSquareText;

  return (
    <button type="button" onClick={onOpen}
      class="press-target text-left rounded-[16px] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-accent)]/50 transition-colors">
      <div class="aspect-video bg-[var(--color-elevated)] relative">
        {thumb ? (
          <img src={thumb} loading="lazy" class="w-full h-full object-cover" />
        ) : (
          <div class="w-full h-full flex items-center justify-center text-[var(--color-text-faint)]"><MediaIcon size={26} /></div>
        )}
        <span class={`absolute top-1.5 left-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold border tabular-nums ${scoreClasses(score)}`}>{score}</span>
        <span class="absolute top-1.5 right-1.5 inline-flex items-center gap-1">
          {siblingCount > 0 && (
            <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-violet-500/25 text-violet-300">+{siblingCount} on this story</span>
          )}
          {item.source === 'sweep' && (
            <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-cyan-500/25 text-cyan-300 uppercase tracking-wide">Live</span>
          )}
          {trackChip(item.track)}
        </span>
        {item.duration_s ? (
          <span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-medium">{fmtDuration(item.duration_s)}</span>
        ) : null}
      </div>
      <div class="p-2.5 space-y-1">
        {item.content_angle && (
          <div class="text-[12.5px] font-semibold text-[var(--color-text)] line-clamp-2 min-h-[2.4em]">{item.content_angle}</div>
        )}
        <div class="text-[11px] text-[var(--color-text-muted)] truncate">{item.author_handle || item.author_name || 'Unknown'}</div>
        {plats.length > 0 && (
          <div class="flex flex-wrap gap-1">
            {plats.map((p) => (
              <span key={p} class="px-1.5 py-0.5 rounded-full bg-[var(--color-elevated)] text-[10px] text-[var(--color-text-muted)]">{PLATFORM_LABEL[p] ?? p}</span>
            ))}
          </div>
        )}
        {primaryCat && (
          <div class="flex items-center gap-1 text-[10px] text-[var(--color-accent)]">
            <Folder size={10} class="shrink-0" />
            <span class="truncate">{primaryCat.umbrella} › {primaryCat.subcategory}</span>
          </div>
        )}
        {tags.length > 0 && (
          <div class="flex flex-wrap gap-1 pt-0.5">
            {tags.slice(0, 3).map((t) => (
              <span key={t} class="px-1.5 py-0.5 rounded-full bg-[var(--color-elevated)] text-[10px] text-[var(--color-text-faint)]">#{t}</span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────
function StudioDrawer({ item, siblings = [], onOpenSibling, onClose, onChanged }: {
  item: StudioItem; siblings?: StudioItem[]; onOpenSibling?: (id: string) => void;
  onClose: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const video = item.media_type === 'video' ? mediaUrl(item, item.media_file) : null;
  const photo = item.media_type === 'photo' ? mediaUrl(item, item.media_file) : null;
  const plats = parsePlatforms(item);
  const score = item.content_score ?? 0;
  const analysis: { hook_summary?: string; research_leads?: string[] } = (() => {
    try { return item.analysis ? JSON.parse(item.analysis) : {}; } catch { return {}; }
  })();

  async function fireResearch() {
    setBusy('research'); setMsg(null);
    try {
      await apiPost(`/api/library/${item.id}/research`, {});
      setMsg('Research started. Jarvis + the team verify the facts; the report lands in Projects > Content Library.');
      onChanged();
    } catch (err: any) {
      setMsg(err?.body?.error || 'Could not start research.');
    } finally { setBusy(null); }
  }

  return (
    <Modal open onClose={onClose} title={item.content_angle || item.author_handle || 'Content opportunity'} width={760}>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class={`px-2.5 py-0.5 rounded-full text-[12px] font-bold border tabular-nums ${scoreClasses(score)}`}>Score {score}</span>
          {trackChip(item.track)}
          {plats.map((p) => (
            <span key={p} class="px-2 py-0.5 rounded-full bg-[var(--color-elevated)] text-[11px] text-[var(--color-text-muted)]">{PLATFORM_LABEL[p] ?? p}</span>
          ))}
          <a href={item.url} target="_blank" rel="noreferrer"
            class="press-target ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            <ExternalLink size={11} /> {item.platform === 'x' ? 'Open on X' : item.platform === 'instagram' ? 'Open on Instagram' : 'Open source article'}
          </a>
        </div>

        {video && <video src={video} controls playsInline class="w-full max-h-[420px] rounded-[14px] bg-black" />}
        {photo && <img src={photo} class="w-full max-h-[420px] object-contain rounded-[14px] bg-black" />}
        {!video && !photo && item.oembed_html && (
          <div class="rounded-[14px] overflow-hidden bg-white p-2" dangerouslySetInnerHTML={{ __html: item.oembed_html }} />
        )}

        {item.content_angle && (
          <div class="rounded-[12px] border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2">
            <div class="text-[10px] uppercase tracking-wide text-[var(--color-accent)] font-semibold mb-0.5">Angle</div>
            <div class="text-[13px] text-[var(--color-text)]">{item.content_angle}</div>
          </div>
        )}

        {item.caption && <p class="text-[13px] text-[var(--color-text)] whitespace-pre-wrap">{item.caption}</p>}
        {analysis.hook_summary && <p class="text-[12px] text-[var(--color-text-muted)] italic">{analysis.hook_summary}</p>}

        {siblings.length > 0 && (
          <div class="rounded-[12px] border border-violet-500/30 bg-violet-500/10 px-3 py-2 space-y-1">
            <div class="text-[10px] uppercase tracking-wide text-violet-300 font-semibold">Same story · {siblings.length} more take{siblings.length > 1 ? 's' : ''}</div>
            {siblings.map((s) => (
              <button key={s.id} type="button" onClick={() => onOpenSibling?.(s.id)}
                class="press-target block w-full text-left text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
                <span class="tabular-nums font-semibold">{s.content_score ?? 0}</span>
                {s.source === 'sweep' ? ' · LIVE' : ''} · {(s.content_angle || s.caption || s.url).split('\n')[0].slice(0, 80)}
              </button>
            ))}
          </div>
        )}

        {item.transcript && (
          <details class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-elevated)]/40">
            <summary class="cursor-pointer px-3 py-2 text-[12px] font-semibold text-[var(--color-text-muted)]">Transcript</summary>
            <p class="px-3 pb-3 text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap max-h-[260px] overflow-y-auto">{item.transcript}</p>
          </details>
        )}

        <DraftPanel item={item} />

        <div class="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={() => void fireResearch()} disabled={busy === 'research'}
            class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[12px] text-[12px] font-semibold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            {busy === 'research' ? <Loader2 size={13} class="animate-spin" /> : <Sparkles size={13} />} Dig into this with the team
          </button>
        </div>
        {msg && <div class="text-[11.5px] text-[var(--color-text-muted)]">{msg}</div>}
      </div>
    </Modal>
  );
}

// ── Staged drafting: brief -> greenlight -> script ───────────────────────────
function DraftPanel({ item }: { item: StudioItem }) {
  const [, navigate] = useLocation();
  const draftsState = useFetch<{ drafts: ContentDraft[] }>(`/api/library/${item.id}/drafts`, 10_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const plats = parsePlatforms(item);
  const [platform, setPlatform] = useState(plats[0] ?? (item.track === 'real_world' ? 'instagram' : 'tiktok'));
  const [copied, setCopied] = useState(false);

  const drafts = draftsState.data?.drafts ?? [];
  // Newest draft only: if Gabe rejected the newest, the panel returns to
  // "Generate brief" rather than resurfacing an older draft.
  const latest = drafts[0] && drafts[0].status !== 'rejected' ? drafts[0] : null;

  async function draftBrief() {
    setBusy('brief'); setErr(null);
    try {
      await apiPost(`/api/library/${item.id}/draft-brief`, { platform });
    } catch (e: any) {
      setErr(e?.body?.draft?.error || e?.body?.error || 'Brief generation failed.');
    } finally { setBusy(null); draftsState.refresh(); }
  }

  async function greenlight(d: ContentDraft) {
    setBusy('script'); setErr(null);
    try {
      await apiPost(`/api/library/drafts/${d.id}/greenlight`, {});
    } catch (e: any) {
      setErr(e?.body?.draft?.error || e?.body?.error || 'Script generation failed.');
    } finally { setBusy(null); draftsState.refresh(); }
  }

  async function reject(d: ContentDraft) {
    setBusy('reject'); setErr(null);
    try { await apiPost(`/api/library/drafts/${d.id}/reject`, {}); }
    catch (e: any) { setErr(e?.body?.error || 'Could not discard the draft.'); }
    finally { setBusy(null); draftsState.refresh(); }
  }

  async function copyScript(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  }

  const brief: BriefPayload | null = (() => {
    try { return latest?.brief ? JSON.parse(latest.brief) : null; } catch { return null; }
  })();

  const verification: VerificationResult | null = (() => {
    try { return latest?.verification && latest.verification_status === 'done' ? JSON.parse(latest.verification) : null; } catch { return null; }
  })();
  const verdictByIndex = new Map<number, ClaimVerdict>((verification?.claims ?? []).map((c) => [c.index, c]));
  const verifying = latest?.verification_status === 'running';
  const flaggedCount = (brief?.key_facts ?? []).filter((f) => f.needs_verification).length;

  async function verify(d: ContentDraft) {
    setBusy('verify'); setErr(null);
    try { await apiPost(`/api/library/drafts/${d.id}/verify`, {}); }
    catch (e: any) { setErr(e?.body?.error || 'Could not start the fact-check.'); }
    finally { setBusy(null); draftsState.refresh(); }
  }

  return (
    <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)]/40 p-3 space-y-2.5">
      <div class="flex items-center gap-2">
        <FileText size={13} class="text-[var(--color-accent)]" />
        <span class="text-[12px] font-semibold text-[var(--color-text)]">Draft</span>
        {latest && (
          <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
            {latest.status} · {PLATFORM_LABEL[latest.platform] ?? latest.platform}
          </span>
        )}
      </div>

      {/* No live draft yet: pick platform, generate brief */}
      {!latest && (
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] p-0.5">
            {(plats.length ? plats : (item.track === 'real_world' ? ['instagram', 'x'] : ['tiktok', 'youtube'])).map((p) => (
              <button key={p} type="button" onClick={() => setPlatform(p)}
                class={`press-target px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${platform === p ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)]'}`}>
                {PLATFORM_LABEL[p] ?? p}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void draftBrief()} disabled={busy === 'brief'}
            class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] text-[12px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
            {busy === 'brief' ? <><Loader2 size={13} class="animate-spin" /> Writing brief (~30s)</> : <>Generate brief</>}
          </button>
        </div>
      )}

      {/* Failed draft (or a live draft whose brief is unreadable): honest error + escape hatch */}
      {latest && (latest.status === 'failed' || (!brief && (latest.status === 'brief' || latest.status === 'greenlit'))) && (
        <div class="space-y-2">
          <div class="text-[11.5px] text-red-300">{latest.error || (brief ? 'Generation failed.' : 'This draft has no readable brief.')}</div>
          <div class="flex flex-wrap items-center gap-2">
            {latest.status === 'failed' && latest.brief && (
              <button type="button" onClick={() => void greenlight(latest)} disabled={!!busy}
                class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[12px] text-[11.5px] border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors">
                {busy === 'script' ? <Loader2 size={12} class="animate-spin" /> : <Check size={12} />} Retry script
              </button>
            )}
            <button type="button" onClick={() => void reject(latest)} disabled={!!busy}
              class="press-target px-3 py-1.5 rounded-[12px] text-[11.5px] border border-[var(--color-border)] text-[var(--color-text-muted)]">
              Discard and start over
            </button>
          </div>
        </div>
      )}

      {/* Brief awaiting review */}
      {latest && brief && (latest.status === 'brief' || latest.status === 'greenlit') && (
        <div class="space-y-2">
          <div>
            <div class="text-[10px] uppercase tracking-wide text-[var(--color-accent)] font-semibold">Hook</div>
            <div class="text-[13px] font-semibold text-[var(--color-text)]">{brief.hook}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Angle</div>
            <div class="text-[12.5px] text-[var(--color-text)]">{brief.angle}</div>
          </div>
          {brief.story_beats?.length > 0 && (
            <div>
              <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Beats</div>
              <ol class="list-decimal list-inside space-y-0.5">
                {brief.story_beats.map((b, i) => <li key={i} class="text-[12px] text-[var(--color-text-muted)]">{b}</li>)}
              </ol>
            </div>
          )}
          {brief.key_facts?.length > 0 && (
            <div>
              <div class="flex items-center gap-2">
                <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Key facts</span>
                {verification && (
                  <span class="text-[10px] text-[var(--color-text-faint)]">
                    ✅{verification.summary.confirmed} ❌{verification.summary.false} ⚠️{verification.summary.disputed} ❓{verification.summary.unverified}
                  </span>
                )}
              </div>
              <ul class="space-y-1">
                {brief.key_facts.map((f, i) => {
                  const v = verdictByIndex.get(i);
                  const chip = v
                    ? v.verdict === 'confirmed' ? { label: 'CONFIRMED', cls: 'bg-emerald-500/20 text-emerald-300' }
                      : v.verdict === 'false' ? { label: 'FALSE', cls: 'bg-red-500/25 text-red-300' }
                      : v.verdict === 'disputed' ? { label: 'DISPUTED', cls: 'bg-orange-500/20 text-orange-300' }
                      : { label: 'UNVERIFIED', cls: 'bg-slate-500/25 text-slate-300' }
                    : f.needs_verification
                      ? { label: verifying ? 'CHECKING' : 'VERIFY', cls: 'bg-amber-500/20 text-amber-300' }
                      : { label: 'OK', cls: 'bg-emerald-500/20 text-emerald-300' };
                  return (
                    <li key={i} class="text-[12px] text-[var(--color-text-muted)]">
                      <div class="flex items-start gap-1.5">
                        <span class={`mt-0.5 shrink-0 px-1 rounded text-[9px] font-bold ${chip.cls}`}>{chip.label}</span>
                        <span>{f.fact}</span>
                      </div>
                      {v && (v.summary || v.correction || v.dispute_reason) && (
                        <div class="pl-6 text-[11px] text-[var(--color-text-faint)]">
                          {v.verdict === 'false' && v.correction ? <>Correction: {v.correction}</> : (v.dispute_reason ?? v.summary)}
                        </div>
                      )}
                      {v && v.sources.length > 0 && (
                        <details class="pl-6">
                          <summary class="cursor-pointer text-[10.5px] text-[var(--color-accent)]">{v.sources.length} source{v.sources.length > 1 ? 's' : ''}</summary>
                          <ul class="space-y-0.5 pt-0.5">
                            {v.sources.map((s, j) => (
                              <li key={j} class="text-[10.5px] text-[var(--color-text-faint)]">
                                <a href={s.url} target="_blank" rel="noreferrer" class="text-[var(--color-accent)] hover:underline break-all">{s.url}</a>
                                {s.what_it_shows ? ` — ${s.what_it_shows}` : ''}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {brief.why_now && <div class="text-[11.5px] text-[var(--color-text-muted)]"><span class="font-semibold">Why now:</span> {brief.why_now}</div>}
          {brief.format_notes && <div class="text-[11.5px] text-[var(--color-text-faint)] italic">{brief.format_notes}</div>}

          <div class="flex flex-wrap items-center gap-2 pt-1">
            {/* Fact-check auto-runs when the brief is created; this button is the manual re-kick for the failed case. */}
            {flaggedCount > 0 && !verification && !verifying && (
              <button type="button" onClick={() => void verify(latest)} disabled={!!busy}
                class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] text-[12px] font-semibold border border-sky-500/50 text-sky-300 hover:bg-sky-500/10 disabled:opacity-60 transition-colors">
                <ShieldCheck size={13} /> {latest.verification_status === 'failed' ? 'Re-run fact-check' : 'Verify facts'} ({flaggedCount})
              </button>
            )}
            {latest.verification_status === 'failed' && (
              <span class="text-[11px] text-red-300">Fact-check failed or was interrupted.</span>
            )}
            <button type="button" onClick={() => void greenlight(latest)} disabled={!!busy || (flaggedCount > 0 && latest.verification_status !== 'done')}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] text-[12px] font-semibold bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
              {busy === 'script' ? <><Loader2 size={13} class="animate-spin" /> Writing script (~40s)</>
                : verifying ? <><Loader2 size={13} class="animate-spin" /> Checking facts first (~5 min)</>
                : flaggedCount > 0 && latest.verification_status !== 'done' ? <><ShieldCheck size={13} /> Script unlocks after fact-check</>
                : latest.status === 'greenlit' ? <><Check size={13} /> Retry the script</>
                : <><Check size={13} /> Greenlight, write the script</>}
            </button>
            <button type="button" onClick={() => void reject(latest)} disabled={!!busy}
              class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[12px] text-[12px] border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors">
              <XIcon size={13} /> Reject
            </button>
          </div>
          {verification && verification.claims.length > 0 && verification.summary.confirmed === 0 && (
            <div class="rounded-[10px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300">
              None of the flagged claims could be confirmed. Your rule: no video without verified facts — recommend rejecting this one.
            </div>
          )}
          {verification && verification.summary.confirmed > 0 && (verification.summary.unverified > 0 || verification.summary.disputed > 0) && (
            <div class="text-[11px] text-amber-300/80">{verification.summary.unverified + verification.summary.disputed} claim{verification.summary.unverified + verification.summary.disputed > 1 ? 's' : ''} could not be confirmed — the script will hedge or flag them.</div>
          )}
        </div>
      )}

      {/* Script delivered */}
      {latest?.status === 'scripted' && latest.script && (
        <div class="space-y-2">
          <pre class="text-[12.5px] text-[var(--color-text)] whitespace-pre-wrap font-sans max-h-[340px] overflow-y-auto rounded-[10px] bg-[var(--color-bg)] border border-[var(--color-border)] p-3">{latest.script}</pre>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => navigate(`/prompter/${latest.id}`)}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] text-[12px] font-semibold bg-emerald-600 text-white hover:opacity-90 transition-opacity">
              <Video size={13} /> Record (teleprompter)
            </button>
            <button type="button" onClick={() => void copyScript(latest.script!)}
              class="press-target inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] text-[12px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity">
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy script</>}
            </button>
            <button type="button" onClick={() => void reject(latest)} disabled={!!busy}
              class="press-target px-3 py-1.5 rounded-[12px] text-[12px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
              Retake (discard, new brief)
            </button>
          </div>
          <ReceiptsKit script={latest.script} verification={verification} />
          <PublishKitPanel draft={latest} />
        </div>
      )}

      {err && <div class="text-[11.5px] text-red-300">{err}</div>}
    </div>
  );
}

// ── Receipts kit: the [ON SCREEN] cues in order, matched to verified sources ──
function ReceiptsKit({ script, verification }: { script: string; verification: VerificationResult | null }) {
  const cues = [...script.matchAll(/\[(?:ON )?SCREEN:\s*([^\]]+)\]/gi)].map((m) => m[1].trim());
  const sources = (verification?.claims ?? []).flatMap((c) => c.sources);
  if (cues.length === 0 && sources.length === 0) return null;

  const matchSources = (cue: string) => {
    const needle = cue.toLowerCase().trim();
    const tok = needle.split(/[\s,]/)[0];
    // Reverse match only on domain-like tokens; short words ("a", "the")
    // would false-match nearly every hostname.
    const tokDomainLike = tok.length >= 4 || tok.includes('.');
    return sources.filter((s) => {
      try {
        const host = new URL(s.url).hostname.replace(/^www\./, '');
        return needle.includes(host) || (tokDomainLike && host.includes(tok));
      } catch { return false; }
    });
  };
  const matchedUrls = new Set(cues.flatMap((c) => matchSources(c)).map((s) => s.url));
  const unmatched = sources.filter((s) => !matchedUrls.has(s.url));

  return (
    <div class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-elevated)]/40 p-3 space-y-1.5">
      <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Receipts for editing (in script order)</div>
      {cues.map((cue, i) => {
        const hits = matchSources(cue);
        return (
          <div key={i} class="text-[12px]">
            <span class="text-[var(--color-text)] font-medium">{i + 1}. [{cue}]</span>
            {hits.length > 0 ? hits.map((s, j) => (
              <div key={j} class="pl-4 text-[11px]">
                <a href={s.url} target="_blank" rel="noreferrer" class="text-[var(--color-accent)] hover:underline break-all">{s.url}</a>
                {s.what_it_shows ? <span class="text-[var(--color-text-faint)]"> — {s.what_it_shows}</span> : null}
              </div>
            )) : (
              <span class="pl-2 text-[11px] text-[var(--color-text-faint)]">no verified source matched — grab this asset manually</span>
            )}
          </div>
        );
      })}
      {unmatched.length > 0 && (
        <details>
          <summary class="cursor-pointer text-[11px] text-[var(--color-text-muted)]">{unmatched.length} more verified source{unmatched.length > 1 ? 's' : ''} (not cued in the script)</summary>
          {unmatched.map((s, j) => (
            <div key={j} class="pl-4 text-[11px]">
              <a href={s.url} target="_blank" rel="noreferrer" class="text-[var(--color-accent)] hover:underline break-all">{s.url}</a>
              {s.what_it_shows ? <span class="text-[var(--color-text-faint)]"> — {s.what_it_shows}</span> : null}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ── Publish kit: upload-time metadata with one-tap copy ─────────────────────
function PublishKitPanel({ draft }: { draft: ContentDraft }) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const kit: PublishKit | null = (() => {
    try { return draft.publish_kit ? JSON.parse(draft.publish_kit) : null; } catch { return null; }
  })();
  if (!kit) {
    return <div class="text-[11px] text-[var(--color-text-faint)]">Publish kit not generated (it rides along with new scripts; retake to get one).</div>;
  }

  async function copyField(field: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopiedField(field); setTimeout(() => setCopiedField(null), 1500); } catch { /* clipboard unavailable */ }
  }

  const tags = kit.hashtags.map((h) => `#${h}`).join(' ');
  const rows: Array<{ field: string; label: string; value: string }> = [
    { field: 'title', label: 'Title', value: kit.title },
    { field: 'caption', label: 'Caption', value: kit.caption },
    ...(tags ? [{ field: 'tags', label: 'Hashtags', value: tags }] : []),
    ...(kit.thumbnail_text ? [{ field: 'thumb', label: 'Thumbnail text', value: kit.thumbnail_text }] : []),
  ];

  return (
    <div class="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-elevated)]/40 p-3 space-y-2">
      <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)] font-semibold">Publish kit ({PLATFORM_LABEL[draft.platform] ?? draft.platform})</div>
      {rows.map((r) => (
        <div key={r.field} class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="text-[10px] text-[var(--color-text-faint)]">{r.label}</div>
            <div class="text-[12px] text-[var(--color-text)] whitespace-pre-wrap break-words">{r.value}</div>
          </div>
          <button type="button" onClick={() => void copyField(r.field, r.value)}
            class="press-target shrink-0 p-1.5 rounded-full text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            {copiedField === r.field ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      ))}
    </div>
  );
}
