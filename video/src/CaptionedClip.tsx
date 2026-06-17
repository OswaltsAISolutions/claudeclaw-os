import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';

const { fontFamily } = loadFont();

export interface Word { start: number; end: number; word: string }

export interface CaptionedClipProps {
  videoSrc: string;          // filename inside video/public/
  durationS: number;
  aspect: '9:16' | '16:9';
  words: Word[];
  accent: string;            // active-word highlight color
  // Vertical caption anchor as a fraction of frame height. Gabe's standing
  // rule: captions must NEVER sit over on-screen text/graphics or the
  // speaker — the E4 pre-flight (eye frame check) sets this per video.
  captionY?: number;
}

interface Page { start: number; end: number; words: Word[] }

// Group words into short caption "pages" (max 4 words / ~1.4s) — the
// TikTok-style look: a few big words at a time, active word highlighted.
function paginate(words: Word[]): Page[] {
  const pages: Page[] = [];
  let current: Word[] = [];
  for (const w of words) {
    if (
      current.length >= 4 ||
      (current.length > 0 && w.end - current[0].start > 1.4) ||
      // A gap (pause) starts a fresh page so captions don't linger.
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

export function CaptionedClip({ videoSrc, aspect, words, accent, captionY }: CaptionedClipProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  const pages = paginate(words);
  // Hold each page until the next one starts (or +0.4s on the last).
  const page = pages.find((p, i) => {
    const until = i + 1 < pages.length ? pages[i + 1].start : p.end + 0.4;
    return t >= p.start && t < until;
  });

  const portrait = aspect === '9:16';
  // Standing caption rules (Gabe): small footprint, never half the screen.
  const fontSize = portrait ? 62 : 54;
  const anchorY = captionY ?? (portrait ? 0.72 : 0.8);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {portrait ? (
        <>
          {/* Blurred cover fill behind a contained landscape/odd-ratio source */}
          <OffthreadVideo
            src={staticFile(videoSrc)}
            style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(40px) brightness(0.5)' }}
            muted
          />
          <OffthreadVideo
            src={staticFile(videoSrc)}
            style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </>
      ) : (
        <OffthreadVideo
          src={staticFile(videoSrc)}
          style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'contain' }}
        />
      )}

      {page && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: height * anchorY,
            display: 'flex',
            justifyContent: 'center',
            padding: '0 60px',
          }}
        >
          <div
            style={{
              fontFamily,
              fontWeight: 800,
              fontSize,
              lineHeight: 1.2,
              maxWidth: '82%',
              textAlign: 'center',
              textTransform: 'uppercase',
              color: 'white',
              // Standing rule: captions must NEVER blend into the background.
              // The backing panel guarantees contrast on any footage.
              backgroundColor: 'rgba(0,0,0,0.62)',
              borderRadius: 18,
              padding: '10px 26px',
              textShadow: '0 2px 12px rgba(0,0,0,0.8)',
            }}
          >
            {page.words.map((w, i) => {
              const active = t >= w.start && t < w.end + 0.05;
              return (
                <span
                  key={i}
                  style={{
                    color: active ? accent : 'white',
                    transform: active ? 'scale(1.08)' : 'scale(1)',
                    display: 'inline-block',
                    transition: 'none',
                    marginRight: '0.28em',
                  }}
                >
                  {w.word.trim()}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}
