import { useState, useRef, useEffect } from 'preact/hooks';
import { useRoute, useLocation } from 'wouter-preact';
import { Play, Pause, RotateCcw, Minus, Plus, ArrowLeft } from 'lucide-preact';
import { useFetch } from '@/lib/useFetch';
import { PageState } from '@/components/PageState';

// Teleprompter for a scripted draft. Full-screen scrolling text Gabe reads on
// camera — designed for a phone propped next to the lens (big tap targets,
// huge type) as much as for a monitor. [ON SCREEN: ...] cues render dimmed so
// he knows where receipts land without reading them aloud.

interface PrompterDraft {
  id: string; status: string; script: string | null; platform: string; track: string;
}

/** Split the script into spoken paragraphs and dimmed cue lines. */
function parseScript(script: string): Array<{ kind: 'speech' | 'cue'; text: string }> {
  const out: Array<{ kind: 'speech' | 'cue'; text: string }> = [];
  for (const block of script.split(/\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // A block can mix speech and inline cues; pull cues out in order.
    let rest = trimmed;
    const cueRe = /\[(?:ON )?SCREEN:[^\]]*\]/gi;
    let m: RegExpExecArray | null;
    let cursor = 0;
    const parts: Array<{ kind: 'speech' | 'cue'; text: string }> = [];
    while ((m = cueRe.exec(rest)) !== null) {
      const before = rest.slice(cursor, m.index).trim();
      if (before) parts.push({ kind: 'speech', text: before });
      parts.push({ kind: 'cue', text: m[0] });
      cursor = m.index + m[0].length;
    }
    const tail = rest.slice(cursor).trim();
    if (tail) parts.push({ kind: 'speech', text: tail });
    out.push(...(parts.length ? parts : [{ kind: 'speech' as const, text: trimmed }]));
  }
  return out;
}

export function Prompter() {
  const [, params] = useRoute<{ draftId: string }>('/prompter/:draftId');
  const [, navigate] = useLocation();
  const draftId = params?.draftId ?? '';
  const state = useFetch<{ draft: PrompterDraft }>(`/api/library/drafts/${draftId}`, 0);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(40);    // px/sec
  const [fontPx, setFontPx] = useState(44);
  const [showCues, setShowCues] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  playingRef.current = playing;
  speedRef.current = speed;

  // rAF scroll loop: time-based so speed is stable regardless of frame rate.
  useEffect(() => {
    const tick = (ts: number) => {
      const el = scrollRef.current;
      if (el && playingRef.current) {
        if (lastTsRef.current) {
          el.scrollTop += ((ts - lastTsRef.current) / 1000) * speedRef.current;
          // Auto-stop at the end so it doesn't spin forever.
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) setPlaying(false);
        }
        lastTsRef.current = ts;
      } else {
        lastTsRef.current = 0;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Space toggles play/pause; arrows nudge speed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.code === 'ArrowUp') setSpeed((s) => Math.min(160, s + 5));
      else if (e.code === 'ArrowDown') setSpeed((s) => Math.max(10, s - 5));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const draft = state.data?.draft;
  if (state.loading && !state.data) return <PageState loading />;
  if (state.error || !draft) return <PageState error={state.error || 'Draft not found'} />;
  if (!draft.script) {
    return (
      <div class="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
        <div class="text-[15px] text-[var(--color-text)]">This draft has no script yet.</div>
        <button type="button" onClick={() => navigate('/studio')}
          class="press-target px-4 py-2 rounded-[12px] text-[13px] font-semibold bg-[var(--color-accent)] text-white">Back to Studio</button>
      </div>
    );
  }

  const blocks = parseScript(draft.script);

  return (
    <div class="h-full flex flex-col bg-black">
      {/* Controls bar */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-black/90">
        <button type="button" onClick={() => navigate('/studio')}
          class="press-target p-2 rounded-full text-white/60 hover:text-white"><ArrowLeft size={18} /></button>
        <button type="button" onClick={() => setPlaying((p) => !p)}
          class="press-target inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-semibold bg-[var(--color-accent)] text-white">
          {playing ? <><Pause size={15} /> Pause</> : <><Play size={15} /> Play</>}
        </button>
        <button type="button" onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; setPlaying(false); }}
          class="press-target p-2 rounded-full text-white/60 hover:text-white"><RotateCcw size={16} /></button>

        <div class="flex items-center gap-1 ml-2">
          <span class="text-[10px] uppercase text-white/40">Speed</span>
          <button type="button" onClick={() => setSpeed((s) => Math.max(10, s - 5))} class="press-target p-1.5 rounded-full text-white/60 hover:text-white"><Minus size={14} /></button>
          <span class="text-[12px] text-white/80 tabular-nums w-7 text-center">{speed}</span>
          <button type="button" onClick={() => setSpeed((s) => Math.min(160, s + 5))} class="press-target p-1.5 rounded-full text-white/60 hover:text-white"><Plus size={14} /></button>
        </div>
        <div class="flex items-center gap-1">
          <span class="text-[10px] uppercase text-white/40">Size</span>
          <button type="button" onClick={() => setFontPx((f) => Math.max(24, f - 4))} class="press-target p-1.5 rounded-full text-white/60 hover:text-white"><Minus size={14} /></button>
          <button type="button" onClick={() => setFontPx((f) => Math.min(80, f + 4))} class="press-target p-1.5 rounded-full text-white/60 hover:text-white"><Plus size={14} /></button>
        </div>
        <button type="button" onClick={() => setShowCues((v) => !v)}
          class={`press-target ml-auto px-2.5 py-1 rounded-full text-[11px] border ${showCues ? 'border-white/30 text-white/70' : 'border-white/10 text-white/30'}`}>
          cues {showCues ? 'on' : 'off'}
        </button>
      </div>

      {/* Script (tap anywhere to play/pause) */}
      <div ref={scrollRef} onClick={() => setPlaying((p) => !p)}
        class="flex-1 overflow-y-auto px-6 md:px-[14%] cursor-pointer select-none">
        {/* Lead-in space so the first line starts at the eye line */}
        <div style={{ height: '40vh' }} />
        {blocks.map((b, i) =>
          b.kind === 'cue'
            ? (showCues ? <div key={i} class="text-white/25 italic py-1" style={{ fontSize: `${Math.max(14, fontPx * 0.4)}px` }}>{b.text}</div> : null)
            : <p key={i} class="text-white font-semibold leading-snug py-3" style={{ fontSize: `${fontPx}px` }}>{b.text}</p>,
        )}
        <div style={{ height: '55vh' }} />
      </div>
    </div>
  );
}
