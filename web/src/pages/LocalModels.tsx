import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Cpu, Download, RefreshCw, Trash2, Zap, AlertCircle,
  Wifi, WifiOff, X, ExternalLink, BookOpen,
  MessageSquare, Send, Brain, Square,
} from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiDelete, dashboardToken } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { formatRelativeTime } from '@/lib/format';

interface LocalModel {
  name: string;
  model: string;
  size: number;
  modified_at: string;
  details: {
    parameter_size: string;
    quantization_level: string;
    family: string;
    families: string[];
  };
  loaded: boolean;
  vramBytes: number | null;
  totalLoadedBytes: number | null;
  expiresAt: string | null;
}

interface Health {
  ok: boolean;
  baseUrl: string;
  version?: string;
  error?: string;
}

interface CatalogModel {
  tag: string;
  displayName: string;
  sizeGB: number;
  params: string;
  context: number;
  capabilities: string[];
  notes: string;
  source: string;
}

interface Catalog {
  categories: Array<{
    id: string;
    label: string;
    models: CatalogModel[];
  }>;
}

const VRAM_GB = 16; // RTX 5080. Hard-coded — the user's box. Calibrate if hardware changes.

export function LocalModels() {
  const health = useFetch<Health>('/api/ollama/health', 15_000);
  const installed = useFetch<{ models: LocalModel[]; baseUrl: string }>('/api/ollama/models', 10_000);
  const catalog = useFetch<Catalog>('/api/ollama/catalog');

  async function refreshHost() {
    try {
      await apiPost('/api/ollama/refresh-host', {});
      health.refresh();
      installed.refresh();
      pushToast({ tone: 'success', title: 'Host cache cleared', description: 'Re-detecting Ollama endpoint.' });
    } catch (err) {
      pushToast({ tone: 'error', title: 'Refresh failed', description: String(err) });
    }
  }

  const installedTags = new Set((installed.data?.models || []).map((m) => m.name));

  return (
    <div class="h-full flex flex-col">
      <PageHeader title="Local Models" />

      <div class="flex-1 overflow-y-auto px-5 pb-8 space-y-6">
        {/* Connection status + Windows-side endpoint surfacing. */}
        <ConnectionBanner health={health.data} loading={health.loading} onRefresh={refreshHost} />

        {/* What's loaded into VRAM right now. */}
        <RunningSection models={installed.data?.models || []} />

        {/* Everything installed locally. */}
        <InstalledSection
          models={installed.data?.models || []}
          loading={installed.loading}
          error={installed.error}
          onChanged={installed.refresh}
        />

        {/* Curated catalog of recommended uncensored / abliterated picks. */}
        <CatalogSection
          catalog={catalog.data}
          loading={catalog.loading}
          installedTags={installedTags}
          onPullStarted={installed.refresh}
        />

        {/* Direct chat with installed local models. Shares hivemind memory with Jarvis. */}
        <ChatSection models={installed.data?.models || []} />
      </div>
    </div>
  );
}

function ConnectionBanner({ health, loading, onRefresh }: { health: Health | null; loading: boolean; onRefresh: () => void }) {
  if (loading && !health) {
    return (
      <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3 text-[12px] text-[var(--color-text-muted)]">
        Probing Ollama…
      </div>
    );
  }
  if (!health) return null;

  const ok = health.ok;
  return (
    <div class={`rounded border p-3 flex items-center gap-3 ${
      ok ? 'bg-[var(--color-status-done)]/10 border-[var(--color-status-done)]/30'
         : 'bg-[var(--color-status-failed)]/10 border-[var(--color-status-failed)]/30'
    }`}>
      {ok ? <Wifi size={16} class="text-[var(--color-status-done)]" /> : <WifiOff size={16} class="text-[var(--color-status-failed)]" />}
      <div class="flex-1 min-w-0">
        <div class="text-[12.5px] font-medium text-[var(--color-text)]">
          {ok ? `Ollama ${health.version} connected` : 'Ollama unreachable'}
        </div>
        <div class="text-[10.5px] text-[var(--color-text-faint)] font-mono truncate">
          {health.baseUrl}
        </div>
        {!ok && (
          <div class="text-[11px] text-[var(--color-status-failed)] mt-1">{health.error}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] bg-[var(--color-card)] transition-colors"
        title="Re-detect Windows host IP (gateway changes on WSL reboot)"
      >
        <RefreshCw size={11} /> Re-detect host
      </button>
    </div>
  );
}

function RunningSection({ models }: { models: LocalModel[] }) {
  const loaded = models.filter((m) => m.loaded);
  if (loaded.length === 0) return null;
  return (
    <section>
      <h3 class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2 flex items-center gap-2">
        <Zap size={11} /> Loaded in memory
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        {loaded.map((m) => {
          const vram = m.vramBytes || 0;
          const total = m.totalLoadedBytes || 0;
          const cpuOffload = Math.max(0, total - vram);
          const pctVram = total > 0 ? Math.round((vram / total) * 100) : 0;
          return (
            <div key={m.name} class="bg-[var(--color-elevated)] border border-[var(--color-status-done)]/30 rounded p-3">
              <div class="font-mono text-[12px] text-[var(--color-text)] mb-1 truncate" title={m.name}>{m.name}</div>
              <div class="text-[10.5px] text-[var(--color-text-faint)] mb-2">
                Expires {m.expiresAt ? formatRelativeTime(new Date(m.expiresAt).getTime()) : 'never'}
              </div>
              <div class="h-1.5 bg-[var(--color-bg)] rounded overflow-hidden">
                <div class="h-full bg-[var(--color-status-done)]" style={{ width: `${pctVram}%` }} />
              </div>
              <div class="flex justify-between text-[10.5px] text-[var(--color-text-muted)] mt-1 tabular-nums">
                <span>VRAM: {formatBytes(vram)}</span>
                {cpuOffload > 0 && <span>RAM offload: {formatBytes(cpuOffload)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function InstalledSection({ models, loading, error, onChanged }: {
  models: LocalModel[]; loading: boolean; error: string | null; onChanged: () => void;
}) {
  if (loading && models.length === 0) return <PageState loading />;
  if (error) return <PageState error={error} />;

  // Sort: vision/embedding to the bottom, then by size desc.
  const sorted = [...models].sort((a, b) => b.size - a.size);

  return (
    <section>
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] flex items-center gap-2">
          <Cpu size={11} /> Installed ({models.length})
        </h3>
        <div class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums">
          Total: {formatBytes(models.reduce((s, m) => s + m.size, 0))}
        </div>
      </div>
      <div class="space-y-1.5">
        {sorted.map((m) => (
          <InstalledRow key={m.name} model={m} onDeleted={onChanged} />
        ))}
        {models.length === 0 && (
          <div class="text-[12px] text-[var(--color-text-faint)] italic">No models installed yet — pick from the catalog below.</div>
        )}
      </div>
    </section>
  );
}

function InstalledRow({ model, onDeleted }: { model: LocalModel; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const fitsVram = model.size / 1e9 <= VRAM_GB;
  async function del() {
    if (!confirm(`Delete ${model.name}? This frees ${formatBytes(model.size)} but you'll need to re-pull to use it again.`)) return;
    setBusy(true);
    try {
      await apiDelete(`/api/ollama/models/${encodeURIComponent(model.name)}`);
      pushToast({ tone: 'success', title: 'Deleted', description: model.name });
      onDeleted();
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err) });
    } finally { setBusy(false); }
  }

  return (
    <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-2.5 flex items-center gap-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-[12px] text-[var(--color-text)] truncate">{model.name}</span>
          {model.loaded && <Pill tone="done">loaded</Pill>}
          {model.details?.parameter_size && (
            <span class="text-[10.5px] text-[var(--color-text-faint)]">{model.details.parameter_size}</span>
          )}
          {model.details?.quantization_level && (
            <span class="text-[10.5px] text-[var(--color-text-faint)]">{model.details.quantization_level}</span>
          )}
          {fitsVram
            ? <Pill tone="done">fits VRAM</Pill>
            : <Pill tone="neutral">partial offload</Pill>}
        </div>
        <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5 tabular-nums">
          {formatBytes(model.size)} · modified {formatRelativeTime(new Date(model.modified_at).getTime())}
        </div>
      </div>
      <button
        type="button"
        onClick={del}
        disabled={busy}
        class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-card)] border border-[var(--color-border)] transition-colors disabled:opacity-40"
        title="Delete model"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function CatalogSection({ catalog, loading, installedTags, onPullStarted }: {
  catalog: Catalog | null; loading: boolean; installedTags: Set<string>; onPullStarted: () => void;
}) {
  if (loading) return null;
  if (!catalog) return null;

  return (
    <section>
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] flex items-center gap-2">
          <BookOpen size={11} /> Recommended abliterated catalog
        </h3>
        <span class="text-[10.5px] text-[var(--color-text-faint)]">Sized for 16GB VRAM / 64GB RAM</span>
      </div>

      <div class="space-y-4">
        {catalog.categories.map((cat) => (
          <div key={cat.id}>
            <div class="text-[11.5px] font-medium text-[var(--color-text)] mb-1.5">{cat.label}</div>
            <div class="space-y-1.5">
              {cat.models.map((m) => (
                <CatalogRow
                  key={m.tag}
                  model={m}
                  alreadyInstalled={installedTags.has(m.tag) || installedTags.has(m.tag.replace(/:[^:]+$/, ':latest'))}
                  onPullStarted={onPullStarted}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface PullState {
  active: boolean;
  status: string;
  percent: number;
  error: string | null;
}

function CatalogRow({ model, alreadyInstalled, onPullStarted }: {
  model: CatalogModel; alreadyInstalled: boolean; onPullStarted: () => void;
}) {
  const [pull, setPull] = useState<PullState>({ active: false, status: '', percent: 0, error: null });
  const esRef = useRef<EventSource | null>(null);

  function startPull() {
    if (pull.active) return;
    setPull({ active: true, status: 'starting', percent: 0, error: null });
    const url = `/api/ollama/pull?name=${encodeURIComponent(model.tag)}&token=${encodeURIComponent(dashboardToken)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const percent = data.total && data.completed
          ? Math.min(100, Math.round((data.completed / data.total) * 100))
          : 0;
        setPull((p) => ({ ...p, status: data.status || p.status, percent }));
      } catch { /* ignore */ }
    };
    es.addEventListener('done', () => {
      es.close();
      esRef.current = null;
      setPull({ active: false, status: 'done', percent: 100, error: null });
      pushToast({ tone: 'success', title: 'Pull complete', description: model.tag });
      onPullStarted();
    });
    es.addEventListener('error', (ev: any) => {
      let msg = 'Stream error';
      try { msg = JSON.parse(ev.data).error || msg; } catch { /* not json */ }
      es.close();
      esRef.current = null;
      setPull({ active: false, status: 'error', percent: 0, error: msg });
      pushToast({ tone: 'error', title: 'Pull failed', description: msg, durationMs: 8000 });
    });
  }

  function cancelPull() {
    esRef.current?.close();
    esRef.current = null;
    setPull({ active: false, status: 'cancelled', percent: 0, error: null });
  }

  useEffect(() => () => { esRef.current?.close(); }, []);

  const fitsVram = model.sizeGB <= VRAM_GB;

  return (
    <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-2.5">
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[12.5px] font-medium text-[var(--color-text)]">{model.displayName}</span>
            <span class="text-[10.5px] text-[var(--color-text-faint)]">{model.params}</span>
            <span class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums">{model.sizeGB}GB</span>
            {fitsVram
              ? <Pill tone="done">fits VRAM</Pill>
              : <Pill tone="neutral">partial offload</Pill>}
            {model.capabilities.map((cap) => <Pill key={cap} tone="neutral">{cap}</Pill>)}
          </div>
          <div class="font-mono text-[10.5px] text-[var(--color-text-faint)] mt-0.5 truncate">{model.tag}</div>
          <div class="text-[11px] text-[var(--color-text-muted)] mt-1 leading-snug">{model.notes}</div>
          <a
            href={model.source}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex items-center gap-1 text-[10.5px] text-[var(--color-text-faint)] hover:text-[var(--color-accent)] mt-1"
          >
            <ExternalLink size={10} /> source
          </a>
        </div>

        <div class="shrink-0 flex flex-col items-end gap-1.5">
          {alreadyInstalled ? (
            <Pill tone="done">installed</Pill>
          ) : pull.active ? (
            <button
              type="button"
              onClick={cancelPull}
              class="inline-flex items-center gap-1 px-2 py-1 rounded text-[10.5px] bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)]"
            >
              <X size={10} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={startPull}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]"
            >
              <Download size={11} /> Pull
            </button>
          )}
        </div>
      </div>

      {pull.active && (
        <div class="mt-2">
          <div class="h-1 bg-[var(--color-card)] rounded overflow-hidden">
            <div class="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${pull.percent}%` }} />
          </div>
          <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1 font-mono truncate">
            {pull.status} {pull.percent > 0 ? `· ${pull.percent}%` : ''}
          </div>
        </div>
      )}
      {pull.error && (
        <div class="mt-2 text-[10.5px] text-[var(--color-status-failed)] font-mono flex items-start gap-1">
          <AlertCircle size={11} class="shrink-0 mt-0.5" /> {pull.error}
        </div>
      )}
    </div>
  );
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  ts?: number;
  streaming?: boolean;
}

function ChatSection({ models }: { models: LocalModel[] }) {
  // Filter to text-capable models. Embedding models (bge-*) and vision-only
  // models don't do conversational chat well, so hide them from the picker.
  const chatModels = models.filter((m) => {
    const n = m.name.toLowerCase();
    if (n.startsWith('bge-')) return false;
    if (n.includes('embed')) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));

  const [selectedModel, setSelectedModel] = useState<string>('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const assistantBufRef = useRef<string>('');

  // Pick first available model once installed list resolves.
  useEffect(() => {
    if (!selectedModel && chatModels.length > 0) {
      setSelectedModel(chatModels[0].name);
    }
  }, [chatModels.length]);

  // Load conversation history whenever the model selection changes.
  useEffect(() => {
    if (!selectedModel) return;
    setHistoryLoaded(false);
    setTurns([]);
    const url = `/api/ollama/chat/history?model=${encodeURIComponent(selectedModel)}&token=${encodeURIComponent(dashboardToken)}`;
    fetch(url)
      .then((r) => r.json())
      .then((data: any) => {
        const loaded: ChatTurn[] = Array.isArray(data?.turns)
          ? data.turns
              .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant'))
              .map((t: any) => ({
                role: t.role,
                content: t.content || '',
                ts: t.created_at ? new Date(t.created_at).getTime() : undefined,
              }))
          : [];
        setTurns(loaded);
        setHistoryLoaded(true);
      })
      .catch(() => setHistoryLoaded(true));
  }, [selectedModel]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [turns.length, turns[turns.length - 1]?.content]);

  // Tear down any open stream on unmount.
  useEffect(() => () => { esRef.current?.close(); }, []);

  function send() {
    const trimmed = input.trim();
    if (!trimmed || !selectedModel || streaming) return;

    // Optimistic append: user turn + a placeholder assistant turn we'll
    // mutate as deltas come in.
    setTurns((prev) => [
      ...prev,
      { role: 'user', content: trimmed, ts: Date.now() },
      { role: 'assistant', content: '', ts: Date.now(), streaming: true },
    ]);
    setInput('');
    setStreaming(true);
    assistantBufRef.current = '';

    const url =
      `/api/ollama/chat` +
      `?model=${encodeURIComponent(selectedModel)}` +
      `&message=${encodeURIComponent(trimmed)}` +
      `&token=${encodeURIComponent(dashboardToken)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (typeof data.delta === 'string') {
          assistantBufRef.current += data.delta;
          const snapshot = assistantBufRef.current;
          setTurns((prev) => {
            if (prev.length === 0) return prev;
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: snapshot };
            }
            return next;
          });
        }
      } catch { /* ignore */ }
    };

    es.addEventListener('done', () => {
      es.close();
      esRef.current = null;
      setStreaming(false);
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last.role === 'assistant') {
          next[next.length - 1] = { ...last, streaming: false };
        }
        return next;
      });
    });

    es.addEventListener('error', (ev: any) => {
      let msg = 'Stream error';
      try { msg = JSON.parse(ev.data).error || msg; } catch { /* not json */ }
      es.close();
      esRef.current = null;
      setStreaming(false);
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            streaming: false,
            content: last.content || `(error: ${msg})`,
          };
        }
        return next;
      });
      pushToast({ tone: 'error', title: 'Chat error', description: msg });
    });
  }

  function stop() {
    esRef.current?.close();
    esRef.current = null;
    setStreaming(false);
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last.role === 'assistant') {
        next[next.length - 1] = { ...last, streaming: false };
      }
      return next;
    });
  }

  function clear() {
    if (streaming) return;
    if (!confirm('Clear the chat view? (History stays in the database — this only hides it locally.)')) return;
    setTurns([]);
  }

  function onKeyDown(e: KeyboardEvent) {
    // Cmd/Ctrl + Enter to send. Plain Enter inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  return (
    <section>
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] flex items-center gap-2">
          <MessageSquare size={11} /> Chat with a local model
        </h3>
        <div class="flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-faint)]">
          <Brain size={11} class="text-[var(--color-accent)]" />
          Shares hivemind memory with J.A.R.V.I.S.
        </div>
      </div>

      <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded">
        {/* Header row: model picker + clear */}
        <div class="flex items-center gap-2 p-2 border-b border-[var(--color-border)]">
          <select
            value={selectedModel}
            onChange={(e: any) => setSelectedModel(e.currentTarget.value)}
            disabled={streaming}
            class="flex-1 min-w-0 bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] font-mono rounded px-2 py-1.5 disabled:opacity-50"
          >
            {chatModels.length === 0 && <option value="">No installed models</option>}
            {chatModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} {m.details?.parameter_size ? `· ${m.details.parameter_size}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={clear}
            disabled={streaming || turns.length === 0}
            class="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] bg-[var(--color-card)] transition-colors disabled:opacity-40"
            title="Clear the visible chat (history persists in the database)"
          >
            <Trash2 size={11} /> Clear view
          </button>
        </div>

        {/* Message list */}
        <div
          ref={listRef}
          class="px-3 py-2 space-y-2 overflow-y-auto"
          style={{ maxHeight: '420px', minHeight: '180px' }}
        >
          {!historyLoaded && selectedModel && (
            <div class="text-[11px] text-[var(--color-text-faint)] italic">Loading history…</div>
          )}
          {historyLoaded && turns.length === 0 && (
            <div class="text-[11px] text-[var(--color-text-faint)] italic">
              No messages yet. {chatModels.length === 0
                ? 'Install a model from the catalog above to start.'
                : 'Send a message to talk directly to ' + (selectedModel || 'the model') + '.'}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} class={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                class={
                  t.role === 'user'
                    ? 'max-w-[85%] bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/30 text-[var(--color-text)] rounded px-2.5 py-1.5 text-[12px] whitespace-pre-wrap'
                    : 'max-w-[85%] bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text)] rounded px-2.5 py-1.5 text-[12px] whitespace-pre-wrap'
                }
              >
                {t.content || (t.streaming ? '…' : '')}
                {t.streaming && t.content && (
                  <span class="inline-block w-1.5 h-3 ml-0.5 bg-[var(--color-text-muted)] align-text-bottom animate-pulse" />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div class="border-t border-[var(--color-border)] p-2 flex items-end gap-2">
          <textarea
            value={input}
            onInput={(e: any) => setInput(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder={
              chatModels.length === 0
                ? 'Install a model first…'
                : `Talk to ${selectedModel || 'model'}…  (Cmd/Ctrl+Enter to send)`
            }
            disabled={!selectedModel || chatModels.length === 0}
            rows={2}
            class="flex-1 bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text)] text-[12px] rounded px-2 py-1.5 resize-y min-h-[40px] max-h-[200px] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              class="inline-flex items-center gap-1 px-3 py-2 rounded text-[12px] font-medium bg-[var(--color-status-failed)]/15 border border-[var(--color-status-failed)]/40 text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/25"
            >
              <Square size={12} /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim() || !selectedModel}
              class="inline-flex items-center gap-1 px-3 py-2 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
