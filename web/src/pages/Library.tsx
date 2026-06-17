import { useState, useRef, useMemo } from 'preact/hooks';
import {
  Plus, ExternalLink, Trash2, RefreshCw, Loader2, Sparkles, Search,
  Film, Image as ImageIcon, MessageSquareText, AlertTriangle, Link2, Upload,
  ChevronRight, Folder, FolderPlus, Star, X as XIcon, FileText,
} from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiGet, apiPost, apiPatch, apiDelete, tokenizedSseUrl } from '@/lib/api';

// ── Types (mirror src/db.ts LibraryItem) ────────────────────────────────────
interface LibraryItem {
  id: string; url: string; platform: string; source: string;
  author_name: string | null; author_handle: string | null; caption: string | null;
  posted_at: number | null; duration_s: number | null;
  media_type: string | null; media_dir: string | null; media_file: string | null;
  thumbnail_path: string | null; oembed_html: string | null;
  like_count: number | null; repost_count: number | null; comment_count: number | null;
  transcript: string | null; transcript_segments: string | null;
  tags: string | null; notes: string | null; analysis: string | null;
  project_id: string | null; status: string; error: string | null;
  retry_count: number; raw_metadata: string | null;
  created_at: number; updated_at: number;
  categories?: ItemCategory[];
}
interface ItemCategory { category_id: string; is_primary: number; subcategory: string; umbrella: string; umbrella_id: string | null; }
interface CatNode { id: string; name: string; description: string | null; item_count: number; subcategories?: CatNode[]; }

const PROCESSING = new Set(['queued', 'fetching_meta', 'downloading', 'transcribing', 'tagging']);

const PLATFORM_TABS = [
  { key: '', label: 'All' },
  { key: 'x', label: 'X' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'arxiv', label: 'Papers' },
] as const;

const PLATFORM_LABEL: Record<string, string> = { x: 'X', instagram: 'IG', arxiv: 'arXiv', web: 'WEB' };

const DEEP_LINKS = [
  { label: 'X Bookmarks', href: 'https://x.com/i/bookmarks' },
  { label: 'X Home', href: 'https://x.com/home' },
  { label: 'IG Saved', href: 'https://www.instagram.com/' },
  { label: 'Instagram', href: 'https://www.instagram.com/' },
];

function mediaUrl(item: LibraryItem, file: string | null): string | null {
  if (!file) return null;
  return tokenizedSseUrl(`/api/library/${item.id}/media/${encodeURIComponent(file)}`);
}

function parseTags(item: LibraryItem): string[] {
  try { return item.tags ? (JSON.parse(item.tags) as string[]) : []; } catch { return []; }
}

function statusChip(status: string) {
  if (status === 'ready') return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">ready</span>;
  if (PROCESSING.has(status)) return (
    <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 inline-flex items-center gap-1">
      <Loader2 size={9} class="animate-spin" /> {status.replace('_', ' ')}
    </span>
  );
  return <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/15 text-red-400">{status.replace(/_/g, ' ')}</span>;
}

function fmtDuration(s: number | null): string {
  if (!s || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ── Page ────────────────────────────────────────────────────────────────────
export function Library() {
  const [platform, setPlatform] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [q, setQ] = useState('');
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<{ id: string; label: string } | null>(null);

  const listPath = useMemo(() => {
    const p = new URLSearchParams();
    if (platform) p.set('platform', platform);
    if (statusFilter) p.set('status', statusFilter);
    if (q.trim()) p.set('q', q.trim());
    if (catFilter?.id === 'uncategorized') p.set('uncategorized', '1');
    else if (catFilter?.id) p.set('category', catFilter.id);
    p.set('limit', '100');
    const qs = p.toString();
    return `/api/library${qs ? `?${qs}` : ''}`;
  }, [platform, statusFilter, q, catFilter]);

  const listState = useFetch<{ items: LibraryItem[]; total: number }>(listPath, 5_000);
  const treeState = useFetch<{ tree: CatNode[] }>('/api/library/categories', 15_000);
  const statsState = useFetch<{ by_status: Record<string, number>; by_platform: Record<string, number>; total: number; disk_bytes: number }>('/api/library/stats', 30_000);

  const items = listState.data?.items ?? [];
  const stats = statsState.data;
  const processingCount = stats ? Object.entries(stats.by_status).filter(([s]) => PROCESSING.has(s)).reduce((a, [, n]) => a + n, 0) : 0;
  const failedCount = stats ? Object.entries(stats.by_status).filter(([s]) => s.startsWith('failed')).reduce((a, [, n]) => a + n, 0) : 0;
  const readyCount = stats?.by_status?.ready ?? 0;

  const openItem = openId ? items.find((i) => i.id === openId) ?? null : null;

  async function ingest() {
    const url = pasteUrl.trim();
    if (!url) return;
    setPasteBusy(true);
    setPasteMsg(null);
    try {
      await apiPost('/api/library/ingest', { url, source: 'dashboard' });
      setPasteUrl('');
      setPasteMsg('Queued. It will appear below as it processes.');
      listState.refresh();
    } catch (err: any) {
      setPasteMsg(err?.body?.error === 'already in library' ? 'Already in your library.' : (err?.body?.error || 'Could not queue that URL.'));
    } finally {
      setPasteBusy(false);
      setTimeout(() => setPasteMsg(null), 5000);
    }
  }

  const coldLoading = listState.loading && !listState.data;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Content Library"
        actions={
          <div class="flex items-center gap-2">
            {DEEP_LINKS.slice(0, 2).map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer"
                class="press-target hidden md:inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[12px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
                <ExternalLink size={12} /> {l.label}
              </a>
            ))}
          </div>
        }
      />

      {/* Controls */}
      <div class="px-4 md:px-6 pb-3 space-y-2.5">
        <div class="flex flex-wrap items-center gap-2">
          {/* Platform pills */}
          <div class="inline-flex rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] p-0.5">
            {PLATFORM_TABS.map((t) => (
              <button key={t.key} type="button"
                onClick={() => setPlatform(t.key)}
                class={`press-target px-3.5 py-1 rounded-full text-[12px] font-semibold transition-colors ${platform === t.key ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Status chips with honest counts */}
          <div class="flex items-center gap-1.5">
            {[
              { key: '', label: `All ${stats?.total ?? ''}` },
              { key: 'ready', label: `Ready ${readyCount}` },
              { key: 'processing', label: `Processing ${processingCount}` },
              { key: 'failed', label: `Failed ${failedCount}` },
            ].map((s) => (
              <button key={s.key} type="button"
                onClick={() => setStatusFilter(s.key)}
                class={`press-target px-2.5 py-1 rounded-full text-[11px] border transition-colors ${statusFilter === s.key ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}>
                {s.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div class="relative ml-auto">
            <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              placeholder="Search captions, transcripts..."
              class="w-[220px] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-full pl-8 pr-3 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors"
            />
          </div>
        </div>

        {/* Paste-a-URL ingest */}
        <div class="flex items-center gap-2">
          <input
            value={pasteUrl}
            onInput={(e) => setPasteUrl((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void ingest(); }}
            placeholder="Paste an X or Instagram post URL to save it..."
            class="flex-1 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[12px] px-3 py-2 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
          <button type="button" disabled={pasteBusy || !pasteUrl.trim()} onClick={() => void ingest()}
            class="press-target inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[12px] text-[12.5px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
            {pasteBusy ? <Loader2 size={14} class="animate-spin" /> : <Plus size={14} />} Save
          </button>
        </div>
        {pasteMsg && <div class="text-[11.5px] text-[var(--color-text-muted)]">{pasteMsg}</div>}

        <SourcesBar onChanged={() => listState.refresh()} />
      </div>

      {coldLoading && <PageState loading />}
      {listState.error && <PageState error={listState.error} />}

      {!coldLoading && !listState.error && (
        <div class="flex-1 min-h-0 flex">
          <CategorySidebar tree={treeState.data?.tree ?? []} active={catFilter} onPick={setCatFilter} />
          <div class="flex-1 min-w-0 overflow-y-auto px-4 md:px-6 pb-6">
            {items.length === 0 ? (
              <div class="py-16 text-center">
                <div class="text-[14px] font-medium text-[var(--color-text)] mb-1.5">{catFilter ? `Nothing in ${catFilter.label} yet` : 'Nothing saved yet'}</div>
                <div class="text-[12px] text-[var(--color-text-muted)] max-w-md mx-auto">
                  {catFilter ? 'Clear the folder filter, or save something that lands here.' : 'Share an X or Instagram link to Jarvis on Telegram, or paste a URL above. Posts land here with video, transcript, auto-filed into folders.'}
                </div>
              </div>
            ) : (
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {items.map((item) => (
                  <LibraryCard key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {openItem && (
        <ItemDrawer
          item={openItem}
          onClose={() => setOpenId(null)}
          onChanged={() => listState.refresh()}
          onDeleted={() => { setOpenId(null); listState.refresh(); }}
        />
      )}
    </div>
  );
}

// ── Sources bar: X bookmark sync + IG export import ─────────────────────────
interface XStatus {
  configured: boolean;
  connected: boolean;
  handle: string | null;
  last_sync: number | null;
  last_result: string | null;
}

function SourcesBar({ onChanged }: { onChanged: () => void }) {
  const xState = useFetch<XStatus>('/api/social/x/status', 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const x = xState.data;

  function note(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(null), 8000);
  }

  async function connectX() {
    setBusy('connect');
    try {
      const { url } = await apiGet<{ url: string }>('/api/social/x/auth');
      window.open(url, '_blank');
      note('Authorize in the X tab, then come back. First sync runs automatically.');
    } catch (err: any) {
      note(err?.body?.error || 'Connect failed. Is X_CLIENT_ID set in .env?');
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy('sync');
    try {
      const r = await apiPost<{ ok: boolean; added: number; scanned: number; error?: string }>('/api/social/x/sync');
      note(r.ok ? `Sync done: ${r.added} new (scanned ${r.scanned}).` : `Sync failed: ${r.error}`);
      onChanged();
      xState.refresh();
    } catch (err: any) {
      note(err?.body?.error || 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }

  async function importIg(file: File) {
    setBusy('ig');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(tokenizedSseUrl('/api/library/import/ig-export'), { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error('import failed'), { body: data });
      note(`Instagram import: ${data.added} new queued, ${data.skipped} already saved (${data.found} found in file).`);
      onChanged();
    } catch (err: any) {
      note(err?.body?.error || 'Import failed. Drop the JSON export from Instagram "Export your information".');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div class="flex flex-wrap items-center gap-2 text-[11.5px]">
      <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Sources</span>

      {/* X bookmarks */}
      {x?.connected ? (
        <>
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <Link2 size={11} /> X @{x.handle ?? 'connected'}
          </span>
          <button type="button" onClick={() => void syncNow()} disabled={busy === 'sync'}
            class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            {busy === 'sync' ? <Loader2 size={11} class="animate-spin" /> : <RefreshCw size={11} />} Sync bookmarks now
          </button>
          {x.last_sync ? (
            <span class="text-[var(--color-text-faint)]">last sync {new Date(x.last_sync * 1000).toLocaleString()}</span>
          ) : null}
        </>
      ) : (
        <button type="button" onClick={() => void connectX()} disabled={busy === 'connect'}
          class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title={x && !x.configured ? 'Set X_CLIENT_ID in .env first' : 'Connect your X account for nightly bookmark sync'}>
          {busy === 'connect' ? <Loader2 size={11} class="animate-spin" /> : <Link2 size={11} />} Connect X bookmarks
        </button>
      )}

      {/* IG export import */}
      <input ref={fileRef} type="file" accept=".json,application/json,.zip" class="hidden"
        onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importIg(f); }} />
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy === 'ig'}
        class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        title="Instagram > Accounts Center > Export your information (JSON). Upload saved_posts.json here.">
        {busy === 'ig' ? <Loader2 size={11} class="animate-spin" /> : <Upload size={11} />} Import IG saved (export file)
      </button>

      {msg && <span class="text-[var(--color-text-muted)]">{msg}</span>}
    </div>
  );
}

// ── Category sidebar (umbrella > subcategory folders) ───────────────────────
function CategorySidebar({ tree, active, onPick }: { tree: CatNode[]; active: { id: string; label: string } | null; onPick: (f: { id: string; label: string } | null) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rowBase = 'press-target w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded-[8px] text-[12px] transition-colors';
  const isActive = (id: string) => active?.id === id;
  return (
    <aside class="w-[230px] shrink-0 border-r border-[var(--color-border)] overflow-y-auto p-2 space-y-0.5">
      <button type="button" onClick={() => onPick(null)}
        class={`${rowBase} ${!active ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-elevated)]'}`}>
        <span class="font-semibold">All saved</span>
      </button>
      <button type="button" onClick={() => onPick({ id: 'uncategorized', label: 'Uncategorized' })}
        class={`${rowBase} ${isActive('uncategorized') ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)]'}`}>
        <span>Uncategorized</span>
      </button>
      <div class="h-px bg-[var(--color-border)] my-1.5" />
      {tree.map((u) => {
        const open = expanded[u.id] ?? false;
        return (
          <div key={u.id}>
            <div class="flex items-center">
              <button type="button" onClick={() => setExpanded((e) => ({ ...e, [u.id]: !open }))}
                class="press-target p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
                <ChevronRight size={12} class={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
              </button>
              <button type="button" onClick={() => onPick({ id: u.id, label: u.name })}
                class={`${rowBase} flex-1 ${isActive(u.id) ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-elevated)]'}`}>
                <span class="font-semibold truncate">{u.name}</span>
                <span class="text-[10px] opacity-70 tabular-nums">{u.item_count}</span>
              </button>
            </div>
            {open && (u.subcategories ?? []).map((s) => (
              <button key={s.id} type="button" onClick={() => onPick({ id: s.id, label: `${u.name} > ${s.name}` })}
                class={`${rowBase} pl-7 ${isActive(s.id) ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)]'}`}>
                <span class="truncate">{s.name}</span>
                <span class="text-[10px] opacity-70 tabular-nums">{s.item_count}</span>
              </button>
            ))}
          </div>
        );
      })}
    </aside>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────
function LibraryCard({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const thumb = mediaUrl(item, item.thumbnail_path);
  const tags = parseTags(item);
  const primaryCat = (item.categories ?? []).find((c) => c.is_primary) ?? (item.categories ?? [])[0];
  const MediaIcon = item.media_type === 'video' ? Film : item.media_type === 'photo' ? ImageIcon : item.media_type === 'pdf' ? FileText : MessageSquareText;

  return (
    <button type="button" onClick={onOpen}
      class="press-target text-left rounded-[16px] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-accent)]/50 transition-colors">
      <div class="aspect-video bg-[var(--color-elevated)] relative">
        {thumb ? (
          <img src={thumb} loading="lazy" class="w-full h-full object-cover" />
        ) : (
          <div class="w-full h-full flex items-center justify-center text-[var(--color-text-faint)]">
            <MediaIcon size={26} />
          </div>
        )}
        {item.duration_s ? (
          <span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-medium">
            {fmtDuration(item.duration_s)}
          </span>
        ) : null}
        <span class="absolute top-1.5 left-1.5">{statusChip(item.status)}</span>
        <span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-semibold uppercase">
          {PLATFORM_LABEL[item.platform] ?? item.platform}
        </span>
      </div>
      <div class="p-2.5 space-y-1">
        <div class="text-[12px] font-semibold text-[var(--color-text)] truncate">
          {item.author_handle || item.author_name || 'Unknown author'}
        </div>
        <div class="text-[11.5px] text-[var(--color-text-muted)] line-clamp-2 min-h-[2.4em]">
          {item.caption || item.notes || item.url}
        </div>
        {primaryCat && (
          <div class="flex items-center gap-1 text-[10px] text-[var(--color-accent)]">
            <Folder size={10} class="shrink-0" />
            <span class="truncate">{primaryCat.umbrella} › {primaryCat.subcategory}{(item.categories?.length ?? 0) > 1 ? ` +${(item.categories!.length - 1)}` : ''}</span>
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

// ── Detail drawer ───────────────────────────────────────────────────────────
function ItemDrawer({ item, onClose, onChanged, onDeleted }: {
  item: LibraryItem; onClose: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [researchMsg, setResearchMsg] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState(parseTags(item).join(', '));
  const [cats, setCats] = useState<ItemCategory[]>(item.categories ?? []);
  const [folderUmbrella, setFolderUmbrella] = useState('');
  const [folderSub, setFolderSub] = useState('');
  const drawerTree = useFetch<{ tree: CatNode[] }>('/api/library/categories', 60_000);

  async function folderApi(body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    try {
      const r = await apiPost<{ categories: ItemCategory[] }>(`/api/library/${item.id}/categories`, body);
      if (r.categories) setCats(r.categories);
      onChanged();
    } catch { /* surfaced on next refresh */ } finally { setBusy(null); }
  }

  const video = item.media_type === 'video' ? mediaUrl(item, item.media_file) : null;
  const photo = item.media_type === 'photo' ? mediaUrl(item, item.media_file) : null;
  const segments: Array<{ start: number; end: number; text: string }> = (() => {
    try { return item.transcript_segments ? JSON.parse(item.transcript_segments) : []; } catch { return []; }
  })();
  const analysis: {
    hook_summary?: string; research_leads?: string[]; research_item_id?: string;
    paper_card?: Record<string, string>;
  } = (() => {
    try { return item.analysis ? JSON.parse(item.analysis) : {}; } catch { return {}; }
  })();

  async function fireResearch() {
    setBusy('research');
    setResearchMsg(null);
    try {
      await apiPost(`/api/library/${item.id}/research`, {});
      setResearchMsg('Research started. Jarvis + the team are on it; the report lands in Workspace > Content Library.');
      onChanged();
    } catch (err: any) {
      setResearchMsg(err?.body?.error || 'Could not start research.');
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy('retry');
    try { await apiPost(`/api/library/${item.id}/retry`); onChanged(); } catch { /* surfaced by list refresh */ }
    setBusy(null);
  }

  async function saveTags() {
    setBusy('tags');
    const tags = tagDraft.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    try { await apiPatch(`/api/library/${item.id}`, { tags }); onChanged(); } catch { /* keep draft */ }
    setBusy(null);
  }

  async function remove() {
    if (!confirm('Delete this saved post and its downloaded media?')) return;
    setBusy('delete');
    try { await apiDelete(`/api/library/${item.id}`); onDeleted(); } catch { setBusy(null); }
  }

  return (
    <Modal open onClose={onClose} title={item.author_handle || item.author_name || 'Saved post'} width={760}>
      <div class="space-y-3">
        {/* Status + actions row */}
        <div class="flex flex-wrap items-center gap-2">
          {statusChip(item.status)}
          <a href={item.url} target="_blank" rel="noreferrer"
            class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            <ExternalLink size={11} /> {item.platform === 'x' ? 'Open on X' : item.platform === 'arxiv' ? 'Open on arXiv' : item.platform === 'web' ? 'Open source article' : 'Open on Instagram'}
          </a>
          {item.status.startsWith('failed') && (
            <button type="button" onClick={() => void retry()} disabled={busy === 'retry'}
              class="press-target inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors">
              {busy === 'retry' ? <Loader2 size={11} class="animate-spin" /> : <RefreshCw size={11} />} Retry
            </button>
          )}
          <button type="button" onClick={() => void remove()} disabled={busy === 'delete'}
            class="press-target ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors">
            <Trash2 size={11} /> Delete
          </button>
        </div>

        {item.error && (
          <div class="flex items-start gap-2 rounded-[12px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            <AlertTriangle size={13} class="mt-0.5 shrink-0" /> {item.error}
          </div>
        )}

        {/* Media */}
        {video && (
          <video ref={videoRef} src={video} controls playsInline class="w-full max-h-[420px] rounded-[14px] bg-black" />
        )}
        {photo && <img src={photo} class="w-full max-h-[420px] object-contain rounded-[14px] bg-black" />}
        {item.media_type === 'pdf' && item.media_file && (
          <a href={mediaUrl(item, item.media_file) ?? '#'} target="_blank" rel="noreferrer"
            class="press-target inline-flex items-center gap-1.5 px-3 py-2 rounded-[12px] text-[12px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            <FileText size={13} /> Open PDF
          </a>
        )}
        {!video && !photo && item.oembed_html && (
          <div class="rounded-[14px] overflow-hidden bg-white p-2" dangerouslySetInnerHTML={{ __html: item.oembed_html }} />
        )}

        {/* Caption + notes */}
        {item.caption && <p class="text-[13px] text-[var(--color-text)] whitespace-pre-wrap">{item.caption}</p>}
        {item.notes && (
          <p class="text-[12px] text-[var(--color-text-muted)] border-l-2 border-[var(--color-accent)] pl-2">Your note: {item.notes}</p>
        )}
        {analysis.hook_summary && (
          <p class="text-[12px] text-[var(--color-text-muted)] italic">{analysis.hook_summary}</p>
        )}

        {/* Paper card (arXiv items) */}
        {analysis.paper_card && (
          <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3 space-y-1.5">
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Paper card</div>
            {([
              ['Method', 'method'], ['Asset class', 'asset_class'], ['Alpha claim', 'alpha_claim'],
              ['Data', 'data_used'], ['Limitations', 'limitations'],
              ['Replication', 'replication_difficulty'], ['Practical use', 'practical_use'],
            ] as const).map(([label, key]) => (
              analysis.paper_card![key] ? (
                <div key={key} class="text-[12px] leading-snug">
                  <span class="font-semibold text-[var(--color-text)]">{label}: </span>
                  <span class="text-[var(--color-text-muted)]">{String(analysis.paper_card![key])}</span>
                </div>
              ) : null
            ))}
          </div>
        )}

        {/* Tags */}
        <div class="flex items-center gap-2">
          <input
            value={tagDraft}
            onInput={(e) => setTagDraft((e.target as HTMLInputElement).value)}
            placeholder="tags, comma, separated"
            class="flex-1 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
          <button type="button" onClick={() => void saveTags()} disabled={busy === 'tags'}
            class="press-target px-3 py-1.5 rounded-[10px] text-[11.5px] font-semibold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            {busy === 'tags' ? <Loader2 size={12} class="animate-spin" /> : 'Save tags'}
          </button>
        </div>

        {/* Folders */}
        <div class="space-y-1.5">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Folders</div>
          <div class="flex flex-wrap gap-1.5">
            {cats.length === 0 && <span class="text-[11.5px] text-[var(--color-text-muted)]">Not filed yet.</span>}
            {cats.map((c) => (
              <span key={c.category_id} class={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] border ${c.is_primary ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
                <Folder size={10} class="shrink-0" />
                <span class="truncate max-w-[180px]">{c.umbrella} › {c.subcategory}</span>
                {c.is_primary ? <Star size={10} class="fill-current shrink-0" /> : (
                  <button type="button" title="Make primary" onClick={() => void folderApi({ action: 'set_primary', category_id: c.category_id }, 'primary:' + c.category_id)} class="press-target opacity-60 hover:opacity-100">
                    <Star size={10} />
                  </button>
                )}
                <button type="button" title="Remove from folder" onClick={() => void folderApi({ action: 'unassign', category_id: c.category_id }, 'rm:' + c.category_id)} class="press-target opacity-60 hover:opacity-100">
                  <XIcon size={11} />
                </button>
              </span>
            ))}
          </div>
          <div class="flex items-center gap-1.5">
            <select value={folderUmbrella} onChange={(e) => setFolderUmbrella((e.target as HTMLSelectElement).value)}
              class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none">
              <option value="">Umbrella…</option>
              {(drawerTree.data?.tree ?? []).map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
            </select>
            <input value={folderSub} onInput={(e) => setFolderSub((e.target as HTMLInputElement).value)}
              placeholder="subcategory (existing or new)"
              class="flex-1 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-[10px] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]" />
            <button type="button" disabled={!folderUmbrella || !folderSub.trim() || busy === 'add'}
              onClick={() => { void folderApi({ umbrella: folderUmbrella, subcategory: folderSub.trim() }, 'add').then(() => setFolderSub('')); }}
              class="press-target inline-flex items-center gap-1 px-3 py-1.5 rounded-[10px] text-[11.5px] font-semibold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-40">
              <FolderPlus size={12} /> Add
            </button>
          </div>
        </div>

        {/* Research with Jarvis */}
        <div class="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[12px] font-semibold text-[var(--color-text)] inline-flex items-center gap-1.5">
              <Sparkles size={13} class="text-[var(--color-accent)]" /> Research with Jarvis + team
            </div>
            <button type="button" onClick={() => void fireResearch()} disabled={busy === 'research'}
              class="press-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-semibold bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
              {busy === 'research' ? <Loader2 size={12} class="animate-spin" /> : <Sparkles size={12} />}
              Dig into this
            </button>
          </div>
          {(analysis.research_leads?.length ?? 0) > 0 && (
            <ul class="text-[11.5px] text-[var(--color-text-muted)] list-disc pl-4 space-y-0.5">
              {analysis.research_leads!.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
          {researchMsg && <div class="text-[11.5px] text-[var(--color-text-muted)]">{researchMsg}</div>}
        </div>

        {/* Transcript */}
        {item.transcript && (
          <div class="space-y-1.5">
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Transcript</div>
            <div class="max-h-[220px] overflow-y-auto rounded-[12px] border border-[var(--color-border)] p-2.5 space-y-1">
              {segments.length > 0 ? segments.map((s, i) => (
                <button key={i} type="button"
                  onClick={() => { if (videoRef.current) { videoRef.current.currentTime = s.start; void videoRef.current.play(); } }}
                  class="block w-full text-left text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
                  <span class="text-[10px] text-[var(--color-text-faint)] tabular-nums mr-1.5">{fmtDuration(s.start)}</span>
                  {s.text}
                </button>
              )) : (
                <p class="text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap">{item.transcript}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
