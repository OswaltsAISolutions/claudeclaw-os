import { useEffect, useRef, useState } from 'preact/hooks';
import { Send, Square, ArrowDown, Clock, ChevronDown, Activity as ActivityIcon, X } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { StatusDot } from '@/components/Pill';
import { apiGet, apiPost, chatId } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { subscribeChatStream, chatStreamConnected, resetUnread } from '@/lib/chat-stream';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  source?: string;
  created_at?: number;
  photoUrl?: string;
  photoCaption?: string;
  // Optimistic UI fields — set when a user message is sent locally but the
  // backend hasn't echoed back the user_message SSE event yet (i.e. it's
  // sitting in the queue behind another task). The pending bubble shows
  // greyed out with a clock; on the SSE confirmation we flip it.
  pending?: boolean;
  pendingId?: string;
}

type ActivityKind = 'route' | 'tool' | 'divider';
interface ActivityItem {
  id: string;
  kind: ActivityKind;
  description: string;
  agent?: string;
  timestamp: number;
  // Phase 2 — full tool transcript paired by toolUseId.
  toolUseId?: string;
  toolName?: string;
  input?: string;
  output?: string;
}

const QUICK_ACTIONS = [
  { label: 'Status update', prompt: "Quick status update: what are you working on right now?" },
  { label: "What's next", prompt: 'What should I focus on next based on context?' },
  { label: 'Plan today', prompt: 'What does my day look like today? What are the priorities?' },
  { label: 'Recent wins', prompt: 'What did I accomplish in the last 24 hours?' },
];

function makeId(): string {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

// Map a progress description (the raw label streamed in via the SSE
// 'progress' / 'tool_use' channels) to a short verb phrase suitable for
// the iMessage-style typing bubble. The verb phrase tells the user what
// J.A.R.V.I.S. is doing right now in plain language. Unmatched labels
// fall back to "Working" so the bubble never shows a long tool-call
// detail string next to the dots.
function deriveTypingLabel(progressLabel: string | null): string {
  if (!progressLabel) return 'Thinking';
  const m = progressLabel.match(/^▸\s*Routed to\s*@(\S+)/);
  if (m) return `@${m[1]} is on it`;
  const head = progressLabel.split(':')[0]?.trim() || progressLabel;
  switch (head) {
    case 'Web search':       return 'Searching the web';
    case 'Fetching page':    return 'Reading the page';
    case 'Running command':  return 'Running command';
    case 'Reading file':     return 'Reading';
    case 'Writing file':     return 'Writing';
    case 'Editing file':     return 'Editing';
    case 'Searching code':   return 'Searching code';
    case 'Finding files':    return 'Finding files';
    case 'Editing notebook': return 'Editing notebook';
    case 'Sub-agent':        return 'Delegating';
    case 'Reasoning':        return 'Thinking';
    case 'User question':    return 'Asking you';
    default:                 return head.length <= 24 ? head : 'Working';
  }
}

// localStorage persistence for the activity feed. The panel is otherwise
// in-memory React state; a page refresh would wipe everything you've seen
// the agent do. Capped at the most recent 200 items so the key doesn't
// grow without bound.
const ACTIVITY_STORAGE_KEY = 'claudeclaw.chat.activity.v1';
const ACTIVITY_MAX = 200;

function loadActivityFromStorage(): ActivityItem[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-ACTIVITY_MAX) as ActivityItem[];
  } catch {
    return [];
  }
}

function saveActivityToStorage(items: ActivityItem[]): void {
  try {
    const capped = items.length > ACTIVITY_MAX ? items.slice(-ACTIVITY_MAX) : items;
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Quota exceeded or storage disabled — silently skip.
  }
}

export function Chat() {
  // Single timeline — every message flows through J.A.R.V.I.S.'s intelligentRoute().
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedAhead, setQueuedAhead] = useState(0);
  // Activity feed: tool events streamed in via the chat SSE 'progress' channel.
  // Hydrated from localStorage so a page refresh doesn't wipe history.
  const [activity, setActivity] = useState<ActivityItem[]>(() => loadActivityFromStorage());
  // Most recently routed specialist callsign. Tool events that arrive while
  // this is set get attributed to that callsign in the activity panel.
  const currentAgentRef = useRef<string>('main');
  // Mobile activity panel overlay state (<lg screens hide the right pane).
  const [activityOpenMobile, setActivityOpenMobile] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamConnected = chatStreamConnected.value;
  const [atBottom, setAtBottom] = useState(true);

  function scrollToBottom(smooth = true) {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  const reloadHistory = () => {
    setLoading(true);
    apiGet<{ turns: Turn[] }>(`/api/chat/history?chatId=${encodeURIComponent(chatId)}&limit=50`)
      .then((d) => setTurns((d.turns || []).slice().reverse()))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reloadHistory();
  }, []);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        reloadHistory();
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (streamConnected) {
      reloadHistory();
    }
  }, [streamConnected]);

  useEffect(() => {
    if (atBottom && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [turns, processing, atBottom]);

  // Persist activity to localStorage so a page refresh doesn't wipe it.
  // The set/parse is cheap and items are capped at ACTIVITY_MAX upstream.
  useEffect(() => {
    saveActivityToStorage(activity);
  }, [activity]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    function onScroll() {
      const dist = el!.scrollHeight - el!.scrollTop - el!.clientHeight;
      setAtBottom(dist < 60);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Subscribe to the global chat SSE.
  useEffect(() => {
    resetUnread();
    const unsub = subscribeChatStream((eventName, data) => {
      if (eventName === 'user_message') {
        setTurns((prev) => {
          // If we have an optimistic pending bubble with the same content,
          // flip it to confirmed instead of adding a duplicate.
          const idx = prev.findIndex(
            (t) => t.pending && t.role === 'user' && t.content === data.content,
          );
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = {
              ...next[idx],
              pending: false,
              pendingId: undefined,
              source: data.source,
              created_at: Date.now() / 1000,
            };
            return next;
          }
          return [
            ...prev,
            {
              role: 'user',
              content: data.content,
              source: data.source,
              created_at: Date.now() / 1000,
            },
          ];
        });
      } else if (eventName === 'assistant_message') {
        setTurns((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.content,
            source: data.source,
            created_at: Date.now() / 1000,
          },
        ]);
        setProcessing(false);
        setProgressLabel(null);
        setQueuedAhead((n) => (n > 0 ? n - 1 : 0));
        // Drop a divider into the activity feed so the user can see where one
        // task ended and the next begins.
        setActivity((prev) => [
          ...prev,
          { id: makeId(), kind: 'divider', description: 'TASK ENDED', timestamp: Date.now() },
        ]);
        currentAgentRef.current = 'main';
      } else if (eventName === 'assistant_photo') {
        setTurns((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '',
            source: data.source,
            photoUrl: data.url,
            photoCaption: data.caption,
            created_at: Date.now() / 1000,
          },
        ]);
      } else if (eventName === 'processing') {
        if (data.processing !== undefined) setProcessing(!!data.processing);
        if (!data.processing) setProgressLabel(null);
      } else if (eventName === 'progress') {
        const desc = data.description as string | undefined;
        if (!desc) return;
        setProgressLabel(desc);
        // Detect the routing marker emitted by src/agent.ts when intelligentRoute
        // picks a specialist: "▸ Routed to @<callsign>".
        const routeMatch = desc.match(/^▸\s*Routed to\s*@(\S+)/);
        if (routeMatch) {
          const agent = routeMatch[1];
          currentAgentRef.current = agent;
          setActivity((prev) => [
            ...prev,
            {
              id: makeId(),
              kind: 'route',
              description: 'Routed to @' + agent,
              agent,
              timestamp: Date.now(),
            },
          ]);
        }
        // Plain 'progress' events without a tool_use companion are short status
        // pings; we update progressLabel for the panel header but don't push a
        // row into the feed (tool_use is the canonical row source now).
      } else if (eventName === 'tool_use') {
        const desc = data.description as string | undefined;
        if (desc) setProgressLabel(desc);
        setActivity((prev) => [
          ...prev,
          {
            id: makeId(),
            kind: 'tool',
            description: desc || data.toolName || 'Tool',
            agent: currentAgentRef.current,
            timestamp: Date.now(),
            toolUseId: data.toolUseId,
            toolName: data.toolName,
            input: data.input,
          },
        ]);
      } else if (eventName === 'tool_result') {
        const id = data.toolUseId as string | undefined;
        if (!id) return;
        setActivity((prev) =>
          prev.map((it) => (it.toolUseId === id ? { ...it, output: data.output } : it)),
        );
      } else if (eventName === 'error') {
        setTurns((prev) => [...prev, { role: 'assistant', content: data.content || 'Error' }]);
        setProcessing(false);
        setProgressLabel(null);
      }
    });
    return unsub;
  }, []);

  async function send(textOverride?: string) {
    const message = (textOverride ?? draft).trim();
    if (!message) return;

    // /pin <text> shortcut: short-circuit the agent and just store the
    // text as a permanent (pinned) memory. Saves the token burn of
    // running the full routing + agent path for a pure persistence op.
    if (/^\/pin\s+/i.test(message)) {
      const pinText = message.replace(/^\/pin\s+/i, '').trim();
      if (!textOverride) setDraft('');
      if (!pinText) {
        setError('Usage: /pin <text>');
        return;
      }
      try {
        const res = await apiPost<{ ok?: boolean; id?: number; summary?: string; error?: string }>(
          '/api/memory/pin',
          { text: pinText },
        );
        if (res.ok) {
          setTurns((prev) => [
            ...prev,
            { role: 'user', content: message, source: 'dashboard', created_at: Date.now() / 1000 },
            { role: 'assistant', content: `Pinned ✓  #${res.id}\n${res.summary || pinText}`, source: 'dashboard', created_at: Date.now() / 1000 },
          ]);
        } else {
          setError(res.error || 'pin failed');
        }
      } catch (err: any) {
        setError(err?.message || String(err));
      }
      return;
    }

    // Optimistic: render the user's bubble immediately, marked pending, even if
    // the bot is busy and will queue this task. The SSE user_message event
    // arrives later when the bot starts processing and flips pending → false.
    const pendingId = makeId();
    setTurns((prev) => [
      ...prev,
      {
        role: 'user',
        content: message,
        source: 'dashboard',
        created_at: Date.now() / 1000,
        pending: true,
        pendingId,
      },
    ]);
    // Flip the typing-bubble on immediately so the user sees "Thinking..."
    // before the SSE 'processing' event arrives (which can lag by a few
    // hundred ms behind the HTTP send acknowledgement).
    setProcessing(true);
    setProgressLabel(null);
    if (!textOverride) setDraft('');
    setSending(true);
    setError(null);
    try {
      const res = await apiPost<{ ok?: boolean; error?: string; queued?: number }>(
        '/api/chat/send',
        { message },
      );
      if (!res.ok && res.error) {
        // Roll back the optimistic bubble if the send failed.
        setTurns((prev) => prev.filter((t) => t.pendingId !== pendingId));
        setError(res.error);
      } else if (typeof res.queued === 'number' && res.queued >= 2) {
        setQueuedAhead(res.queued - 1);
      }
    } catch (err: any) {
      setTurns((prev) => prev.filter((t) => t.pendingId !== pendingId));
      setError(err?.message || String(err));
    } finally {
      setSending(false);
    }
  }

  async function abort() {
    try { await apiPost('/api/chat/abort'); } catch {}
  }

  function quick(prompt: string) {
    void send(prompt);
    inputRef.current?.focus();
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Chat"
        actions={
          <span class="inline-flex items-center gap-2.5 text-[11px] text-[var(--color-text-muted)]">
            {queuedAhead > 0 && (
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text)]">
                <span class="size-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                {queuedAhead} queued
              </span>
            )}
            <span class="inline-flex items-center gap-1.5">
              <StatusDot tone={streamConnected ? 'done' : 'cancelled'} />
              {streamConnected ? 'Connected' : 'Reconnecting…'}
            </span>
            {/* Mobile-only toggle to open the activity panel as an overlay */}
            <button
              type="button"
              onClick={() => setActivityOpenMobile(true)}
              class="lg:hidden press-target inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              aria-label="Show activity"
            >
              <ActivityIcon size={12} />
              Activity
            </button>
          </span>
        }
      />

      {/* 70/30 split — left chat column, right activity column. Activity hidden
          below lg breakpoint; toggled as an overlay via the header button. */}
      <div class="flex-1 min-h-0 flex">
        {/* LEFT — messages + composer */}
        <div class="flex-[7] min-w-0 flex flex-col">
          <div class="relative flex-1 min-h-0">
            <div ref={messagesRef} class="absolute inset-0 overflow-y-auto px-4 md:px-6 py-5">
              <div class="max-w-3xl mx-auto space-y-1.5">
                {error && <div class="text-[var(--color-status-failed)] text-[12px] px-2">{error}</div>}
                {loading && <PageState loading />}
                {!loading && turns.length === 0 && (
                  <PageState
                    empty
                    emptyTitle="Say something to J.A.R.V.I.S."
                    emptyDescription="He routes each task to the right specialist automatically — coder, scribe, sleuth, etc. Watch the activity panel on the right to see what he's doing."
                  />
                )}
                {turns.map((t, i) => {
                  const prev = i > 0 ? turns[i - 1] : undefined;
                  return <Bubble key={t.pendingId || i} turn={t} prev={prev} />;
                })}
                {processing && <TypingBubble label={deriveTypingLabel(progressLabel)} />}
              </div>
            </div>
            {!atBottom && (
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                class="absolute bottom-3 right-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-[var(--color-accent)] text-white shadow-lg hover:bg-[var(--color-accent-hover)] transition-colors"
                aria-label="Scroll to latest message"
              >
                <ArrowDown size={13} />
                Latest
              </button>
            )}
          </div>

          {/* Composer */}
          <div class="glass border-t border-[var(--color-border)] px-4 pt-3 pb-4">
            <div class="max-w-3xl mx-auto">
              <div class="flex items-center gap-1.5 mb-2.5 flex-wrap justify-center">
                {QUICK_ACTIONS.map((qa) => (
                  <button
                    key={qa.label}
                    type="button"
                    onClick={() => quick(qa.prompt)}
                    disabled={sending}
                    class="press-target px-3 py-1 rounded-full text-[11.5px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {qa.label}
                  </button>
                ))}
              </div>
              <div class="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim()) void send();
                    }
                  }}
                  placeholder="iMessage"
                  rows={1}
                  class="flex-1 !rounded-3xl !px-4 !py-2.5 text-[14px] resize-none max-h-32"
                />
                {processing ? (
                  <button
                    type="button"
                    onClick={abort}
                    title="Stop the task currently running. Queued tasks below are not affected."
                    class="press-target inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-status-failed)] text-white hover:opacity-90 transition-opacity shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                    aria-label="Stop"
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!draft.trim() || sending}
                    class="press-target inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                    aria-label="Send"
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT — activity panel (desktop) */}
        <div class="hidden lg:flex flex-[3] min-w-0 border-l border-[var(--color-border)] flex-col">
          <ActivityPanel items={activity} processing={processing} progressLabel={progressLabel} />
        </div>
      </div>

      {/* Mobile overlay activity panel */}
      {activityOpenMobile && (
        <div class="lg:hidden fixed inset-0 z-30 flex flex-col glass" style={{ background: 'rgba(0, 8, 16, 0.96)' }}>
          <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <div class="text-[10.5px] font-mono uppercase tracking-[0.18em] text-[var(--color-accent)]">
              ▸ ACTIVITY
            </div>
            <button
              type="button"
              onClick={() => setActivityOpenMobile(false)}
              class="press-target p-2 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <ActivityPanel items={activity} processing={processing} progressLabel={progressLabel} hideHeader />
        </div>
      )}
    </div>
  );
}

// ── Activity panel ──────────────────────────────────────────────────────
// Right pane showing live tool activity streamed from the agent SDK. Each
// row shows the tool description + which specialist is doing it. Tasks
// are separated by a centered "TASK ENDED" divider when assistant_message
// arrives. Auto-scrolls to the latest entry.
function ActivityPanel({
  items, processing, progressLabel, hideHeader,
}: {
  items: ActivityItem[];
  processing: boolean;
  progressLabel: string | null;
  hideHeader?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to bottom on new items.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [items.length, processing]);

  // Walk backwards to find the most-recent routing event so we can show
  // which agent is currently working in the panel header.
  let currentAgent = 'main';
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'divider') break;
    if (it.kind === 'route' && it.agent) {
      currentAgent = it.agent;
      break;
    }
  }

  return (
    <div class="flex flex-col h-full">
      {!hideHeader && (
        <div class="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-card)]/40">
          <div class="text-[10.5px] font-mono uppercase tracking-[0.18em] text-[var(--color-accent)]">
            ▸ ACTIVITY
          </div>
          <div class="text-[11.5px] text-[var(--color-text-muted)] mt-1 flex items-center gap-2 truncate">
            <span class={[
              'size-1.5 rounded-full shrink-0',
              processing ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-text-faint)]',
            ].join(' ')} />
            <span class="truncate">
              {processing ? (
                <>
                  <span class="font-mono uppercase tracking-wider text-[var(--color-accent)]">@{currentAgent}</span>
                  {progressLabel && (
                    <span class="text-[var(--color-text-faint)]"> · {progressLabel}</span>
                  )}
                </>
              ) : (
                'Awaiting task'
              )}
            </span>
          </div>
        </div>
      )}

      <div ref={containerRef} class="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        {items.length === 0 && !processing && (
          <div class="text-[11px] text-[var(--color-text-faint)] text-center py-12 italic px-4 leading-relaxed">
            Tool activity appears here as J.A.R.V.I.S. works. File reads, bash commands, web searches — all live.
          </div>
        )}
        {items.map((item) => <ActivityRow key={item.id} item={item} />)}
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'divider') {
    return (
      <div class="flex items-center gap-3 py-2.5 select-none">
        <div class="flex-1 h-px bg-[var(--color-border)]" />
        <span class="text-[9px] font-mono uppercase tracking-[0.20em] text-[var(--color-text-faint)]">
          {item.description}
        </span>
        <div class="flex-1 h-px bg-[var(--color-border)]" />
      </div>
    );
  }

  if (item.kind === 'route') {
    return (
      <div class="rounded-xl px-3 py-2 text-[11.5px] flex items-center gap-2 bg-[var(--color-accent-soft)] border border-[var(--color-accent)]/40">
        <span class="text-[var(--color-accent)] font-mono font-semibold">▸</span>
        <span class="text-[var(--color-text)] font-medium truncate">{item.description}</span>
        <span class="ml-auto text-[9.5px] text-[var(--color-text-faint)] tabular-nums shrink-0">
          {formatTime(item.timestamp)}
        </span>
      </div>
    );
  }

  // Tool row — collapsible. Shows the tool name + agent attribution in the
  // header; expanding reveals the full input (what the agent told the tool to
  // do) and output (what the tool returned), Claude-Code-card style.
  const hasTranscript = item.input != null || item.output != null;
  const pending = item.input != null && item.output == null;
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl text-[11.5px] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        class="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-[var(--color-elevated)] transition-colors"
      >
        <ChevronDown
          size={10}
          class={[
            'shrink-0 transition-transform text-[var(--color-text-faint)]',
            expanded ? '' : '-rotate-90',
          ].join(' ')}
        />
        <span class="flex-1 truncate font-mono text-[var(--color-text-muted)]">
          {item.description}
        </span>
        {pending && (
          <span class="size-1.5 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0" aria-label="Running" />
        )}
        {item.agent && (
          <span class="text-[9.5px] font-mono uppercase tracking-wider text-[var(--color-accent)]/80 shrink-0">
            @{item.agent}
          </span>
        )}
        <span class="text-[9.5px] text-[var(--color-text-faint)] tabular-nums shrink-0">
          {formatTime(item.timestamp)}
        </span>
      </button>
      {expanded && (
        <div class="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {hasTranscript ? (
            <>
              {item.input != null && (
                <ToolBlock label={item.toolName ? item.toolName + ' input' : 'Input'} body={item.input} tone="input" />
              )}
              {item.output != null ? (
                <ToolBlock label="Output" body={item.output} tone="output" />
              ) : (
                <div class="px-3 py-2 text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-text-faint)] flex items-center gap-2">
                  <span class="size-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                  Running…
                </div>
              )}
            </>
          ) : (
            <div class="px-3 py-2 text-[10.5px] text-[var(--color-text-faint)] font-mono leading-relaxed">
              No transcript captured for this tool call.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolBlock({ label, body, tone }: { label: string; body: string; tone: 'input' | 'output' }) {
  return (
    <div class="px-3 py-2">
      <div class={[
        'text-[9px] font-mono uppercase tracking-[0.18em] mb-1.5',
        tone === 'input' ? 'text-[var(--color-accent)]/80' : 'text-[var(--color-text-faint)]',
      ].join(' ')}>
        {label}
      </div>
      <pre class="text-[10.5px] font-mono leading-relaxed text-[var(--color-text-muted)] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
        {body}
      </pre>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ── iMessage-style typing indicator ─────────────────────────────────────
// Appears on the assistant side while J.A.R.V.I.S. is processing. Three
// pulsing dots (staggered bounce keyframes from main.css) plus a short
// verb-phrase label so you can see what kind of work is happening —
// "Thinking", "Searching the web", "Running command", "@sleuth is on it".
function TypingBubble({ label }: { label: string }) {
  return (
    <div class="flex justify-start typing-bubble-in">
      <div class="ios-bubble ios-bubble-assistant inline-flex items-center gap-2.5 !py-2 !px-3.5">
        <span class="inline-flex gap-1 items-end">
          <span
            class="typing-dot rounded-full bg-[var(--color-text-muted)]"
            style={{ width: 5, height: 5, animationDelay: '0ms' }}
          />
          <span
            class="typing-dot rounded-full bg-[var(--color-text-muted)]"
            style={{ width: 5, height: 5, animationDelay: '180ms' }}
          />
          <span
            class="typing-dot rounded-full bg-[var(--color-text-muted)]"
            style={{ width: 5, height: 5, animationDelay: '360ms' }}
          />
        </span>
        <span class="text-[12px] text-[var(--color-text-muted)] font-medium">
          {label}
        </span>
      </div>
    </div>
  );
}

// ── iMessage-style bubble ───────────────────────────────────────────────
function Bubble({ turn, prev }: { turn: Turn; prev?: Turn }) {
  const isUser = turn.role === 'user';
  const isPhoto = !!turn.photoUrl;
  const isPending = turn.pending === true;
  const html = (isUser || isPhoto) ? null : renderMarkdown(turn.content);
  const showTimestamp = shouldShowTimestamp(turn, prev);

  return (
    <>
      {showTimestamp && (
        <div class="text-center text-[10.5px] text-[var(--color-text-faint)] py-2 select-none">
          {formatChatTimestamp(turn.created_at)}
        </div>
      )}
      <div class={'flex ' + (isUser ? 'justify-end' : 'justify-start')}>
        <div
          class={[
            'ios-bubble overflow-hidden transition-opacity duration-200',
            isUser ? 'ios-bubble-user whitespace-pre-wrap' : 'ios-bubble-assistant chat-md',
            isPhoto ? '!p-1' : '',
            isPending ? 'opacity-55' : 'opacity-100',
          ].join(' ')}
        >
          {isPhoto ? (
            <>
              <img
                src={turn.photoUrl}
                alt={turn.photoCaption || 'attached image'}
                class="block rounded-xl max-h-[320px] w-auto object-contain"
                loading="lazy"
              />
              {turn.photoCaption && (
                <div class="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{turn.photoCaption}</div>
              )}
            </>
          ) : isUser ? (
            turn.content
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html || '' }} />
          )}
        </div>
      </div>
      {isPending && (
        <div class="flex justify-end pr-1.5 -mt-0.5">
          <span class="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-text-faint)] font-mono">
            <Clock size={9} />
            Queued
          </span>
        </div>
      )}
    </>
  );
}

function shouldShowTimestamp(turn: Turn, prev?: Turn): boolean {
  if (!turn.created_at) return false;
  if (!prev || !prev.created_at) return true;
  return turn.created_at - prev.created_at >= 5 * 60;
}

function formatChatTimestamp(epochSeconds?: number): string {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + time;
}
