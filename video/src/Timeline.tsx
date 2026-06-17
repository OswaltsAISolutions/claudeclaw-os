import { AbsoluteFill, Audio, OffthreadVideo, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';

const { fontFamily } = loadFont();

// ── Edit-plan schema ─────────────────────────────────────────────────────────
// The universal contract between the editor brain and this engine. Every mode
// (collage, polish, overhaul, scratch, Gabe-directed) is just a different way
// of producing one of these plans.

export interface Word { start: number; end: number; word: string }

export interface VideoSegment {
  src: string;            // file inside video/public/
  startS: number;         // position on the timeline
  durS: number;
  inS?: number;           // source in-point (trim)
  fit?: 'cover' | 'contain' | 'blur-fill';
  kenBurns?: { from: number; to: number }; // slow zoom (1 = none)
  transition?: 'cut' | 'fade';             // how this segment ENTERS
  transitionS?: number;
  volume?: number;        // source audio 0..1 (0 = muted)
}

export interface Overlay {
  kind: 'title' | 'card' | 'lower-third' | 'image';
  text?: string;
  sub?: string;           // second line (lower-third role/source line)
  src?: string;           // image overlays
  startS: number;
  durS: number;
  y?: number;             // 0..1 vertical anchor (safe-zone aware caller)
}

export interface AudioTrack {
  src: string;
  startS: number;
  inS?: number;
  durS?: number;
  volume?: number;
  fadeInS?: number;
  fadeOutS?: number;
  duckUnderSpeech?: boolean; // dip while caption words are active (music beds)
}

export interface TimelinePlan {
  aspect: '9:16' | '16:9' | '1:1';
  durationS: number;
  background?: string;    // solid color behind contain-fit segments
  video: VideoSegment[];
  overlays?: Overlay[];
  audio?: AudioTrack[];
  captions?: { words: Word[]; y?: number; accent?: string } | null;
}

export const TIMELINE_DIMENSIONS: Record<TimelinePlan['aspect'], { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
};

// ── Captions (same standing rules as CaptionedClip: backed panel, small) ─────

interface Page { start: number; end: number; words: Word[] }

function paginate(words: Word[]): Page[] {
  const pages: Page[] = [];
  let current: Word[] = [];
  for (const w of words) {
    if (
      current.length >= 4 ||
      (current.length > 0 && w.end - current[0].start > 1.4) ||
      (current.length > 0 && w.start - current[current.length - 1].end > 0.6)
    ) {
      pages.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
      current = [];
    }
    current.push(w);
  }
  if (current.length) pages.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
  return pages;
}

function speechActiveAt(words: Word[], t: number): boolean {
  return words.some((w) => t >= w.start - 0.15 && t <= w.end + 0.25);
}

// ── Engine ───────────────────────────────────────────────────────────────────

export function Timeline({ plan }: { plan: TimelinePlan }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const portrait = plan.aspect === '9:16';

  const captionWords = plan.captions?.words ?? [];
  const pages = paginate(captionWords);
  const page = pages.find((p, i) => {
    const until = i + 1 < pages.length ? pages[i + 1].start : p.end + 0.4;
    return t >= p.start && t < until;
  });
  const captionFontSize = portrait ? 62 : 54;

  return (
    <AbsoluteFill style={{ backgroundColor: plan.background ?? 'black' }}>
      {/* Video track */}
      {plan.video.map((seg, i) => {
        const from = Math.round(seg.startS * fps);
        const dur = Math.max(1, Math.round(seg.durS * fps));
        const trS = seg.transition === 'fade' ? (seg.transitionS ?? 0.5) : 0;
        return (
          <Sequence key={`v${i}`} from={from} durationInFrames={dur}>
            <SegmentView seg={seg} trS={trS} />
          </Sequence>
        );
      })}

      {/* Overlays */}
      {(plan.overlays ?? []).map((ov, i) => {
        const from = Math.round(ov.startS * fps);
        const dur = Math.max(1, Math.round(ov.durS * fps));
        return (
          <Sequence key={`o${i}`} from={from} durationInFrames={dur}>
            <OverlayView ov={ov} portrait={portrait} />
          </Sequence>
        );
      })}

      {/* Audio tracks */}
      {(plan.audio ?? []).map((tr, i) => {
        const from = Math.round(tr.startS * fps);
        const dur = tr.durS ? Math.max(1, Math.round(tr.durS * fps)) : undefined;
        const base = tr.volume ?? 1;
        return (
          <Sequence key={`a${i}`} from={from} durationInFrames={dur}>
            <Audio
              src={staticFile(tr.src)}
              startFrom={Math.round((tr.inS ?? 0) * fps)}
              volume={(f) => {
                let v = base;
                const localT = f / fps;
                if (tr.fadeInS && localT < tr.fadeInS) v *= localT / tr.fadeInS;
                if (tr.fadeOutS && dur) {
                  const remain = dur / fps - localT;
                  if (remain < tr.fadeOutS) v *= Math.max(0, remain / tr.fadeOutS);
                }
                if (tr.duckUnderSpeech && speechActiveAt(captionWords, tr.startS + localT)) v *= 0.25;
                return Math.max(0, Math.min(1, v));
              }}
            />
          </Sequence>
        );
      })}

      {/* Captions (standing rules: backed panel, small footprint, placed via safe-zone y) */}
      {page && (
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: height * (plan.captions?.y ?? (portrait ? 0.72 : 0.8)),
          display: 'flex', justifyContent: 'center', padding: '0 60px',
        }}>
          <div style={{
            fontFamily, fontWeight: 800, fontSize: captionFontSize, lineHeight: 1.2,
            maxWidth: '82%', textAlign: 'center', textTransform: 'uppercase', color: 'white',
            backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 18, padding: '10px 26px',
            textShadow: '0 2px 12px rgba(0,0,0,0.8)',
          }}>
            {page.words.map((w, i) => (
              <span key={i} style={{
                color: t >= w.start && t < w.end + 0.05 ? (plan.captions?.accent ?? '#FFD400') : 'white',
                display: 'inline-block', marginRight: '0.28em',
              }}>
                {w.word.trim()}
              </span>
            ))}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

function SegmentView({ seg, trS }: { seg: VideoSegment; trS: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localT = frame / fps;
  const opacity = trS > 0 ? interpolate(localT, [0, trS], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  const durS = seg.durS;
  const scale = seg.kenBurns
    ? interpolate(localT, [0, durS], [seg.kenBurns.from, seg.kenBurns.to], { extrapolateRight: 'clamp' })
    : 1;
  const startFrom = Math.round((seg.inS ?? 0) * fps);
  const fit = seg.fit ?? 'blur-fill';

  return (
    <AbsoluteFill style={{ opacity }}>
      {fit === 'blur-fill' && (
        <OffthreadVideo
          src={staticFile(seg.src)}
          startFrom={startFrom}
          muted
          style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(40px) brightness(0.5)' }}
        />
      )}
      <OffthreadVideo
        src={staticFile(seg.src)}
        startFrom={startFrom}
        muted={(seg.volume ?? 0) === 0}
        volume={seg.volume ?? 0}
        style={{
          position: 'absolute', width: '100%', height: '100%',
          objectFit: fit === 'cover' ? 'cover' : 'contain',
          transform: `scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
}

function OverlayView({ ov, portrait }: { ov: Overlay; portrait: boolean }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const localT = frame / fps;
  const opacity = interpolate(localT, [0, 0.35], [0, 1], { extrapolateRight: 'clamp' });

  if (ov.kind === 'image' && ov.src) {
    return (
      <AbsoluteFill style={{ opacity, justifyContent: 'center', alignItems: 'center' }}>
        <Img src={staticFile(ov.src)} style={{ maxWidth: '88%', maxHeight: '80%', borderRadius: 12 }} />
      </AbsoluteFill>
    );
  }

  if (ov.kind === 'lower-third') {
    return (
      <div style={{
        position: 'absolute', left: 40, bottom: height * 0.12, opacity,
        fontFamily, color: 'white',
        backgroundColor: 'rgba(0,0,0,0.7)', borderLeft: '6px solid #FFD400',
        padding: '12px 22px', borderRadius: 8, maxWidth: '70%',
      }}>
        <div style={{ fontSize: portrait ? 38 : 32, fontWeight: 800 }}>{ov.text}</div>
        {ov.sub && <div style={{ fontSize: portrait ? 26 : 22, opacity: 0.85 }}>{ov.sub}</div>}
      </div>
    );
  }

  // title / card: centered statement text on dimmed backdrop
  return (
    <AbsoluteFill style={{
      opacity, justifyContent: 'center', alignItems: 'center',
      backgroundColor: ov.kind === 'card' ? 'rgba(0,0,0,0.82)' : 'transparent',
    }}>
      <div style={{
        position: 'absolute', top: ov.y !== undefined ? height * ov.y : undefined,
        fontFamily, fontWeight: 900, color: 'white', textAlign: 'center',
        fontSize: portrait ? 76 : 68, lineHeight: 1.15, maxWidth: '85%',
        textTransform: 'uppercase', letterSpacing: 1,
        textShadow: '0 4px 30px rgba(0,0,0,0.95)',
        ...(ov.y === undefined ? { position: 'relative' as const } : {}),
      }}>
        {ov.text}
        {ov.sub && <div style={{ fontSize: portrait ? 40 : 34, fontWeight: 600, marginTop: 18, opacity: 0.9, textTransform: 'none' }}>{ov.sub}</div>}
      </div>
    </AbsoluteFill>
  );
}
