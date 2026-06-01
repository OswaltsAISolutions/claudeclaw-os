import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import * as THREE from 'three';
import { gsap } from 'gsap';
import { Mic, MicOff, RotateCcw } from 'lucide-preact';
import { subscribeChatStream } from '@/lib/chat-stream';
import { apiPost, tokenizedSseUrl } from '@/lib/api';
import { bootAudioEnabled } from '@/lib/theme';

/**
 * JARVIS Home -- the 3D dashboard with real voice IO.
 *
 * Architecture:
 *  - Full-page <canvas> with Three.js shader orb (Phase 1, unchanged).
 *  - Mic button captures audio via MediaRecorder, POSTs to /api/voice/transcribe,
 *    then sends the transcribed text to /api/chat/send.
 *  - SSE assistant_message triggers TTS fetch from /api/voice/tts. The returned
 *    audio plays through a Web Audio AnalyserNode whose FFT amplitude drives
 *    the orb's uAmp in real-time -- true lip-sync.
 *  - State machine: idle -> listening -> thinking -> speaking -> idle.
 */

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export function JarvisHome() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<OrbController | null>(null);
  const [booted, setBooted] = useState(() => {
    try { return sessionStorage.getItem('jarvis.booted') === 'true'; } catch { return false; }
  });
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');

  // Voice IO refs (survive re-renders, no state churn)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserRafRef = useRef<number>(0);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  // Track whether we initiated the current exchange (to avoid TTS on other sources)
  const awaitingReplyRef = useRef(false);

  // Init Three.js scene once. Tear down cleanly on unmount.
  useEffect(() => {
    if (!canvasRef.current) return;
    const ctl = new OrbController(canvasRef.current);
    orbRef.current = ctl;
    ctl.start();
    return () => {
      ctl.dispose();
      orbRef.current = null;
    };
  }, []);

  // Drive orb from SSE + trigger TTS for assistant replies
  useEffect(() => {
    const unsub = subscribeChatStream((eventName, data) => {
      if (eventName === 'processing') {
        orbRef.current?.pulseSpeak(0.55);
      }
      if (eventName === 'assistant_message') {
        const content = data?.content as string | undefined;
        // If we're awaiting a reply from a voice command, speak it
        if (awaitingReplyRef.current && content) {
          awaitingReplyRef.current = false;
          playTTS(content);
        } else {
          // Fallback: synthetic pulse for non-voice-initiated messages
          orbRef.current?.pulseSpeak(0.85);
        }
      }
    });
    return unsub;
  }, []);

  // ---- Audio context (lazy init, reused) ----
  function getAudioContext(): AudioContext {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }

  // ---- TTS playback with AnalyserNode -> orb amplitude ----
  async function playTTS(text: string) {
    setVoiceState('speaking');
    try {
      const url = tokenizedSseUrl('/api/voice/tts');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        // Backend TTS unavailable (no Orpheus terms accepted, ElevenLabs
        // on free plan, etc.). Fall back to browser Web Speech API so
        // the orb still has a voice. Amplitude is synthetic since
        // SpeechSynthesisUtterance doesn't expose audio to AnalyserNode.
        console.warn('Backend TTS unavailable (HTTP ' + res.status + '), falling back to browser Web Speech');
        speakViaBrowser(text);
        return;
      }
      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);

      const audio = new Audio(audioUrl);
      currentAudioRef.current = audio;

      // Wire through Web Audio for amplitude analysis
      const ctx = getAudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      analyserRef.current = analyser;

      source.connect(analyser);
      analyser.connect(ctx.destination);

      // Start amplitude polling loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      function pumpAmplitude() {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        // Average the lower frequency bins (voice range, ~80-400Hz)
        // With fftSize=256, each bin is ~(sampleRate/256)Hz.
        // Bins 0-30 cover roughly the voice fundamental + harmonics.
        const voiceBins = Math.min(30, dataArray.length);
        let sum = 0;
        for (let i = 0; i < voiceBins; i++) sum += dataArray[i];
        const avg = sum / voiceBins / 255; // normalize to 0..1
        // Apply a curve to make the orb more responsive
        const amplitude = Math.pow(avg, 0.7) * 1.2;
        orbRef.current?.setAmplitude(Math.min(1, amplitude));
        analyserRafRef.current = requestAnimationFrame(pumpAmplitude);
      }

      audio.onplay = () => { pumpAmplitude(); };
      audio.onended = () => {
        cancelAnimationFrame(analyserRafRef.current);
        analyserRef.current = null;
        orbRef.current?.setAmplitude(0);
        URL.revokeObjectURL(audioUrl);
        currentAudioRef.current = null;
        setVoiceState('idle');
      };
      audio.onerror = () => {
        cancelAnimationFrame(analyserRafRef.current);
        analyserRef.current = null;
        orbRef.current?.setAmplitude(0);
        URL.revokeObjectURL(audioUrl);
        currentAudioRef.current = null;
        setVoiceState('idle');
      };

      await audio.play();
    } catch (err) {
      console.error('TTS playback error, falling back to browser Web Speech:', err);
      speakViaBrowser(text);
    }
  }

  /**
   * Browser Web Speech API fallback. Used when backend /api/voice/tts
   * is down or unconfigured. Drives a synthetic amplitude envelope into
   * the orb since SpeechSynthesis doesn't expose audio for FFT analysis.
   * The envelope alternates between two amplitude levels at ~5Hz to
   * approximate speaking cadence; not as good as real FFT but enough
   * for the orb to look alive while talking.
   */
  function speakViaBrowser(text: string) {
    if (!('speechSynthesis' in window)) {
      setVoiceState('idle');
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.pitch = 0.92; // slightly deeper for that JARVIS feel
    // Pick a deep masculine voice if one's installed; otherwise default
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /daniel|david|alex|james|google.*uk.*male|microsoft.*guy/i.test(v.name));
    if (preferred) utter.voice = preferred;

    let envelopeStart = performance.now();
    function pumpSynthetic() {
      // Stop when speech ends; checked in onend below by clearing the loop
      if (!analyserRafRef.current) return;
      const t = (performance.now() - envelopeStart) / 1000;
      // 5 Hz wobble between 0.35 and 0.85, with a slow envelope decay
      // so it doesn't feel mechanical
      const wobble = 0.35 + 0.5 * Math.abs(Math.sin(t * 5.0));
      orbRef.current?.setAmplitude(wobble);
      analyserRafRef.current = requestAnimationFrame(pumpSynthetic);
    }

    utter.onstart = () => {
      envelopeStart = performance.now();
      // Reuse analyserRafRef as our "speaking-loop is active" flag
      analyserRafRef.current = requestAnimationFrame(pumpSynthetic);
    };
    utter.onend = () => {
      cancelAnimationFrame(analyserRafRef.current);
      analyserRafRef.current = 0;
      orbRef.current?.setAmplitude(0);
      setVoiceState('idle');
    };
    utter.onerror = () => {
      cancelAnimationFrame(analyserRafRef.current);
      analyserRafRef.current = 0;
      orbRef.current?.setAmplitude(0);
      setVoiceState('idle');
    };
    window.speechSynthesis.speak(utter);
  }

  // ---- Mic toggle ----
  const toggleMic = useCallback(async () => {
    // If currently speaking, stop audio and go idle
    if (voiceState === 'speaking') {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.dispatchEvent(new Event('ended'));
      }
      return;
    }

    // If listening, stop recording and process
    if (voiceState === 'listening') {
      mediaRecorderRef.current?.stop();
      return;
    }

    // If thinking, ignore (wait for it)
    if (voiceState === 'thinking') return;

    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer webm/opus (Chrome/Edge/Firefox), fall back to whatever is available
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''; // let browser pick default
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all tracks to release mic
        stream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        audioChunksRef.current = [];

        if (blob.size < 100) {
          // Too short, ignore
          setVoiceState('idle');
          return;
        }

        setVoiceState('thinking');
        orbRef.current?.pulseSpeak(0.55);

        try {
          // 1. Transcribe
          const formData = new FormData();
          formData.append('audio', blob, 'recording.webm');
          const url = tokenizedSseUrl('/api/voice/transcribe');
          const transcribeRes = await fetch(url, {
            method: 'POST',
            body: formData,
          });
          if (!transcribeRes.ok) {
            const err = await transcribeRes.json().catch(() => ({}));
            console.error('Transcribe failed:', err);
            setVoiceState('idle');
            return;
          }
          const { text } = await transcribeRes.json() as { text: string };
          if (!text || !text.trim()) {
            setVoiceState('idle');
            return;
          }

          // 2. Send to agent
          awaitingReplyRef.current = true;
          await apiPost('/api/chat/send', { message: text.trim() });
          // State stays 'thinking' until SSE assistant_message arrives
          // and triggers playTTS -> 'speaking' -> 'idle'
        } catch (err) {
          console.error('Voice pipeline error:', err);
          awaitingReplyRef.current = false;
          setVoiceState('idle');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceState('listening');
    } catch (err) {
      console.error('Mic access failed:', err);
      setVoiceState('idle');
    }
  }, [voiceState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(analyserRafRef.current);
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  function replayBoot() {
    try { sessionStorage.removeItem('jarvis.booted'); } catch {}
    setBooted(false);
  }

  const caption = voiceState === 'listening'
    ? 'Listening...'
    : voiceState === 'thinking'
    ? 'Thinking...'
    : voiceState === 'speaking'
    ? 'Speaking...'
    : 'Tap to talk to J.A.R.V.I.S.';

  const isActive = voiceState === 'listening';

  return (
    <div class="relative w-full h-full overflow-hidden" style={{ background: 'radial-gradient(85% 65% at 50% 50%, rgba(0, 240, 255, 0.16), transparent 70%), radial-gradient(60% 50% at 50% 100%, rgba(255, 149, 0, 0.05), transparent 70%), #000308' }}>
      {/* Energy halo behind the canvas — cyan radial pulse aura. Sits
          below the canvas (z-0) so the orb appears to glow through it.
          GSAP drives a subtle scale-breathing on a long loop. */}
      <div
        class="jarvis-halo absolute inset-0 z-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at 50% 50%, rgba(0, 240, 255, 0.22) 0%, rgba(0, 240, 255, 0.06) 18%, transparent 38%)',
          willChange: 'transform, opacity',
        }}
      />
      {/* Canvas at z-[2] so it renders ABOVE the centered JARVIS label
          (z-1) but below the HUD/corner panels (z-5+). The orb's
          fresnel-only shader has near-zero alpha in the middle, so
          the cyan label glow reads through the transparent core while
          the constellation nodes + lightning render over the top. */}
      <canvas ref={canvasRef} class="absolute inset-0 w-full h-full z-[2]" />

      {/* HUD frame around the orb. Concentric rings + corner brackets to
          sell the Iron Man HUD feel. Pure CSS so the canvas runs untouched. */}
      <HudOverlay />

      {/* Caption + mic. Bumped up to clear the J.A.R.V.I.S. page title
          at the very bottom. */}
      <div class="absolute bottom-32 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3">
        <button
          type="button"
          onClick={toggleMic}
          disabled={voiceState === 'thinking'}
          class={[
            'press-target inline-flex items-center justify-center w-14 h-14 rounded-full transition-all',
            isActive
              ? 'bg-[var(--color-status-failed)] text-white shadow-[0_4px_24px_color-mix(in_srgb,var(--color-status-failed)_60%,transparent)]'
              : voiceState === 'thinking'
              ? 'glass border border-[var(--color-border)] text-[var(--color-text-faint)] opacity-60 cursor-wait'
              : voiceState === 'speaking'
              ? 'glass border border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'glass border border-[var(--color-border-strong)] text-[var(--color-text)] hover:border-[var(--color-accent)]',
          ].join(' ')}
          aria-label={isActive ? 'Stop listening' : voiceState === 'speaking' ? 'Stop speaking' : 'Talk to J.A.R.V.I.S.'}
          style={isActive ? { animation: 'jarvis-mic-pulse 1.2s ease-in-out infinite' } : undefined}
        >
          {isActive ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <div class={[
          'glass px-5 py-3 rounded-full text-[14px] border border-[var(--color-border)]',
          voiceState === 'listening' ? 'text-[var(--color-status-failed)]' :
          voiceState === 'thinking' ? 'text-[var(--color-accent)]' :
          voiceState === 'speaking' ? 'text-[var(--color-accent)]' :
          'text-[var(--color-text-muted)]',
        ].join(' ')}>
          {caption}
        </div>
      </div>

      {/* \u2500\u2500 JARVIS HUD layer (mounts after boot completes) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
          Multi-panel data HUD inspired by Jayse Hansen's Iron Man UI:
          4 corner panels with bracket-frame corners, perspective grid
          floor at the bottom, vertical scanline drifting horizontally,
          and a J.A.R.V.I.S. nameplate below the orb. Pointer-events on
          panels so they don't block orb-drag interactions. */}
      {booted && (
        <>
          <div class="jarvis-grid-floor" />
          <div class="jarvis-scanline" />

          {/* Top-left: SYSTEM */}
          <div class="absolute top-6 left-6 z-10 w-[240px] pointer-events-none">
            <SystemPanel />
          </div>

          {/* Top-right: TELEMETRY */}
          <div class="absolute top-6 right-6 z-10 w-[240px] pointer-events-none">
            <TelemetryPanel />
          </div>

          {/* Bottom-left: SPECIALISTS */}
          <div class="absolute bottom-6 left-6 z-10 w-[240px] pointer-events-none">
            <SpecialistsPanel />
          </div>

          {/* Bottom-right: MEMORY */}
          <div class="absolute bottom-6 right-6 z-10 w-[240px] pointer-events-none">
            <MemoryPanel />
          </div>

          {/* Top page caption \u2014 system descriptor floating across the top. */}
          <div class="jarvis-page-caption">JUST A RATHER VERY INTELLIGENT SYSTEM</div>

          {/* Bottom page title \u2014 large J.A.R.V.I.S. headline at the very
              bottom of the screen, the dominant brand mark of the dashboard. */}
          <div class="jarvis-page-title">J.A.R.V.I.S.</div>

          {/* Replay boot \u2014 iOS-style glass icon pill in the top-right
              gap between the page caption and the TELEMETRY panel.
              Out of the way of mic + JARVIS title at the bottom. */}
          <button
            type="button"
            onClick={replayBoot}
            class="absolute top-7 right-[272px] z-10 glass inline-flex items-center justify-center w-9 h-9 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] transition-colors"
            title="Replay boot sequence"
            aria-label="Replay boot sequence"
          >
            <RotateCcw size={15} strokeWidth={2.2} />
          </button>
        </>
      )}

      {/* Boot overlay. Renders above the canvas until the sequence
          completes (or sessionStorage says we've already booted). The
          orb flare fires at the climax (onFinalFlash) — bigFlare()
          slams uAmp + uFlare to 1.0 for 5 seconds so the rings light
          up, plasma streaks intensify, and the rim explodes — punching
          through the white flash. */}
      {!booted && (
        <BootSequence
          orbRef={orbRef}
          onFinalFlash={() => orbRef.current?.bigFlare()}
          onComplete={() => {
            try { sessionStorage.setItem('jarvis.booted', 'true'); } catch {}
            setBooted(true);
          }}
        />
      )}

      {/* Inject mic pulse keyframes */}
      <style>{`
        @keyframes jarvis-mic-pulse {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-status-failed) 40%, transparent); }
          50% { box-shadow: 0 0 0 12px color-mix(in srgb, var(--color-status-failed) 0%, transparent); }
        }
      `}</style>
    </div>
  );
}

// -- HUD overlay -------------------------------------------------------

/**
 * HUD layer rendered as a centered 1000x1000 SVG so all elements scale
 * with the viewport. Layered to look like the Iron Man UI: multiple
 * partial arcs at varying radii rotating at different speeds, segmented
 * tick rings, corner brackets, perimeter data ticker. Pointer-events
 * none so it never intercepts mic / button clicks.
 */
function HudOverlay() {
  // Generate tick marks around a ring (12 evenly-spaced, with longer
  // ticks every 4). Memoized because they never change.
  const ticks = [];
  for (let i = 0; i < 36; i++) {
    const angle = (i * 10) * Math.PI / 180;
    const isMajor = i % 3 === 0;
    const r1 = isMajor ? 420 : 432;
    const r2 = 444;
    const x1 = 500 + Math.cos(angle) * r1;
    const y1 = 500 + Math.sin(angle) * r1;
    const x2 = 500 + Math.cos(angle) * r2;
    const y2 = 500 + Math.sin(angle) * r2;
    ticks.push({ x1, y1, x2, y2, isMajor });
  }

  // Ticker numbers around the outside — feels like radar readout
  const tickerNums = [];
  for (let i = 0; i < 24; i++) {
    const angle = (i * 15 - 90) * Math.PI / 180;
    const r = 478;
    const x = 500 + Math.cos(angle) * r;
    const y = 500 + Math.sin(angle) * r;
    // Pseudo-data: rotating 3-digit number per spoke
    const num = (i * 137 % 999).toString().padStart(3, '0');
    tickerNums.push({ x, y, num, angle: i * 15 });
  }

  return (
    <div class="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
      <svg
        viewBox="0 0 1000 1000"
        class="absolute"
        style={{
          width: 'min(92vmin, 92vh)',
          height: 'min(92vmin, 92vh)',
          filter: 'drop-shadow(0 0 12px color-mix(in srgb, var(--color-accent) 40%, transparent))',
        }}
      >
        {/* Outermost faint ring */}
        <circle cx="500" cy="500" r="478" fill="none" stroke="var(--color-accent)" strokeOpacity="0.10" strokeWidth="0.6" />

        {/* Tick ring */}
        <g style={{ transformOrigin: 'center', animation: 'jarvis-spin 120s linear infinite' }}>
          {ticks.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
              stroke="var(--color-accent)"
              strokeOpacity={t.isMajor ? 0.55 : 0.25}
              strokeWidth={t.isMajor ? 1.2 : 0.8}
            />
          ))}
        </g>

        {/* Perimeter data ticker — counter-rotates */}
        <g style={{ transformOrigin: 'center', animation: 'jarvis-spin 90s linear infinite reverse' }}>
          {tickerNums.map((n, i) => (
            <text key={i} x={n.x} y={n.y}
              fill="var(--color-accent)"
              fillOpacity="0.45"
              fontSize="11"
              fontFamily="var(--font-mono)"
              textAnchor="middle"
              dominantBaseline="middle"
            >{n.num}</text>
          ))}
        </g>

        {/* Outer arc — partial, rotates slow */}
        <g style={{ transformOrigin: 'center', animation: 'jarvis-spin 50s linear infinite' }}>
          <path d="M 500 110 A 390 390 0 0 1 720 168" fill="none" stroke="var(--color-accent)" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
          <path d="M 500 890 A 390 390 0 0 1 280 832" fill="none" stroke="var(--color-accent)" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
        </g>

        {/* Middle arc — broken arcs, counter-rotates */}
        <g style={{ transformOrigin: 'center', animation: 'jarvis-spin 35s linear infinite reverse' }}>
          <circle cx="500" cy="500" r="320" fill="none" stroke="var(--color-accent)" strokeOpacity="0.18" strokeWidth="1" strokeDasharray="14 8" />
        </g>

        {/* Inner solid faint ring */}
        <circle cx="500" cy="500" r="260" fill="none" stroke="var(--color-accent)" strokeOpacity="0.12" strokeWidth="0.8" />

        {/* Inner arc segments — rotates */}
        <g style={{ transformOrigin: 'center', animation: 'jarvis-spin 22s linear infinite' }}>
          <path d="M 500 240 A 260 260 0 0 1 700 380" fill="none" stroke="var(--color-accent)" strokeOpacity="0.55" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M 500 760 A 260 260 0 0 1 300 620" fill="none" stroke="var(--color-accent)" strokeOpacity="0.55" strokeWidth="1.8" strokeLinecap="round" />
        </g>

        {/* Innermost dashed ring */}
        <circle cx="500" cy="500" r="200" fill="none" stroke="var(--color-accent)" strokeOpacity="0.3" strokeWidth="0.6" strokeDasharray="4 6" style={{ transformOrigin: 'center', animation: 'jarvis-spin 60s linear infinite' }} />

        {/* Crosshair */}
        <g stroke="var(--color-accent)" strokeOpacity="0.18" strokeWidth="0.8">
          <line x1="500" y1="50"  x2="500" y2="120" />
          <line x1="500" y1="880" x2="500" y2="950" />
          <line x1="50"  y1="500" x2="120" y2="500" />
          <line x1="880" y1="500" x2="950" y2="500" />
        </g>
      </svg>

      {/* Corner brackets — bigger, more iron-man */}
      {([['top-6 left-6', '0 0'], ['top-6 right-6', '1 0'], ['bottom-6 left-6', '0 1'], ['bottom-6 right-6', '1 1']] as const).map(([pos, flip], i) => (
        <div key={i} class={`absolute ${pos}`}>
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none"
            style={{ transform: `scale(${flip[0] === '1' ? -1 : 1}, ${flip[2] === '1' ? -1 : 1})` }}>
            <path d="M 4 22 L 4 4 L 22 4" stroke="var(--color-accent)" strokeOpacity="0.65" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M 4 32 L 4 36" stroke="var(--color-accent)" strokeOpacity="0.4" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="10" cy="10" r="2" fill="var(--color-accent)" fillOpacity="0.5" />
          </svg>
        </div>
      ))}
    </div>
  );
}

// -- Cinematic boot sequence ------------------------------------------

/**
 * Iron-Man-style boot animation. Five phases over ~6.5 seconds:
 *   0.0-0.6s   single white dot at center, low-bass impact
 *   0.6-2.0s   expanding rings, scanning line sweep, audio whoosh
 *   2.0-3.6s   arcs draw in via stroke-dashoffset, status grid populates
 *   3.6-5.0s   "JARVIS" reveals letter-by-letter, subtitle types out
 *   5.0-6.0s   particle burst, final chime, white flash
 *   6.0-6.5s   fade out → orb dashboard
 *
 * Pure SVG + CSS animations (no library). The `phase` state drives which
 * elements are mounted/visible; each element has its own CSS keyframe
 * for entrance so React just toggles `is-on` classes.
 */
// ──────────────────────────────────────────────────────────────────────
// HUD CORNER PANELS
// ──────────────────────────────────────────────────────────────────────
// Four glass panels with bracket-frame corners that surround the central
// 3D orb after boot completes. Each shows a different data category —
// SYSTEM (CPU/GPU/MEM), TELEMETRY (build/kernel/auth), SPECIALISTS (10
// callsigns), HIVEMIND (memory stats). Values use realistic synthetic
// data with live drift via setInterval to feel like a working HUD.
// Some values pull from /api/health (real) when available.

/** Tiny hook: returns a value that drifts within ±range every `ms`. */
function useDrift(base: number, range: number, ms = 1500): number {
  const [v, setV] = useState(base);
  useEffect(() => {
    const id = window.setInterval(() => {
      setV(base + (Math.random() - 0.5) * 2 * range);
    }, ms);
    return () => window.clearInterval(id);
  }, [base, range, ms]);
  return v;
}

function PanelBrackets() {
  return (<>
    <span class="br-tr" /><span class="br-bl" />
  </>);
}

function Gauge({ value, max = 100, orange = false }: { value: number; max?: number; orange?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div class={`jarvis-gauge ${orange ? 'orange' : ''}`}>
      <span style={{ width: pct + '%' }} />
    </div>
  );
}

function SystemPanel() {
  const cpu = useDrift(34, 6, 1400);
  const gpu = useDrift(46, 8, 1700);
  const mem = useDrift(28.4, 0.3, 2500);
  const net = useDrift(1.24, 0.18, 1100);
  return (
    <div class="jarvis-panel">
      <PanelBrackets />
      <div class="jarvis-panel-title">System</div>
      <div class="jarvis-panel-row">
        <span class="k">CPU</span><span class="v">{cpu.toFixed(1)}%</span>
      </div>
      <Gauge value={cpu} />
      <div class="jarvis-panel-row">
        <span class="k">GPU</span><span class="v">{gpu.toFixed(1)}%</span>
      </div>
      <Gauge value={gpu} />
      <div class="jarvis-panel-row">
        <span class="k">MEM</span><span class="v">{mem.toFixed(1)} / 64 GB</span>
      </div>
      <Gauge value={(mem / 64) * 100} orange />
      <div class="jarvis-panel-row">
        <span class="k">NET</span><span class="v cyan">{net.toFixed(2)} GB/s</span>
      </div>
    </div>
  );
}

function TelemetryPanel() {
  const [uptime, setUptime] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      setUptime(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const upStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return (
    <div class="jarvis-panel">
      <PanelBrackets />
      <div class="jarvis-panel-title">Telemetry</div>
      <div class="jarvis-panel-row">
        <span class="k">BUILD</span><span class="v">2026.05.24</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">KERNEL</span><span class="v cyan">6.6.87 WSL2</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">AUTH</span><span class="v">OAUTH MAX</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">NODE</span><span class="v cyan">172.30.196.91</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">UPTIME</span><span class="v" style={{ fontVariantNumeric: 'tabular-nums' }}>{upStr}</span>
      </div>
    </div>
  );
}

function SpecialistsPanel() {
  // Static roster — could pull from /api/specialists later. Status dots
  // blink at slightly different cadences to feel alive.
  const roster: Array<{ name: string; ready: boolean }> = [
    { name: 'SCRIBE',    ready: true },
    { name: 'CODER',     ready: true },
    { name: 'EYE',       ready: true },
    { name: 'SLEUTH',    ready: true },
    { name: 'REAPER',    ready: true },
    { name: 'ARCHIVIST', ready: true },
    { name: 'SENTINEL',  ready: true },
    { name: 'CIPHER',    ready: true },
    { name: 'ATLAS',     ready: true },
    { name: 'MERCURY',   ready: true },
  ];
  return (
    <div class="jarvis-panel">
      <PanelBrackets />
      <div class="jarvis-panel-title">Specialists · 10/10</div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {roster.map((s, i) => (
          <div key={s.name} class="jarvis-panel-row" style={{ animationDelay: `${i * 0.08}s` }}>
            <span class="k flex items-center gap-1.5">
              <span class="inline-block w-1.5 h-1.5 rounded-full"
                style={{
                  background: s.ready ? '#34d399' : '#ff9500',
                  boxShadow: s.ready ? '0 0 4px #34d399' : '0 0 4px #ff9500',
                  animation: `boot-fade-in 240ms ease-out ${i * 80}ms both`,
                }} />
              {s.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoryPanel() {
  const memories = useDrift(1247, 0.5, 9000);
  const turns = useDrift(16, 0.5, 6000);
  const nodes = useDrift(9, 0, 9000);
  const consolidations = useDrift(84, 0.5, 8000);
  const lastSync = useDrift(22, 0.5, 4000);
  return (
    <div class="jarvis-panel">
      <PanelBrackets />
      <div class="jarvis-panel-title">Hivemind</div>
      <div class="jarvis-panel-row">
        <span class="k">MEMORIES</span><span class="v">{Math.round(memories).toLocaleString()}</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">TURNS·24H</span><span class="v cyan">{Math.round(turns)}</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">NODES</span><span class="v">{Math.round(nodes)} / 10</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">CONSOL</span><span class="v cyan">{Math.round(consolidations)}</span>
      </div>
      <div class="jarvis-panel-row">
        <span class="k">LAST SYNC</span><span class="v dim">{Math.round(lastSync)}m ago</span>
      </div>
    </div>
  );
}

// Voice narration lines timed against the GSAP timeline. Lines are
// pre-fetched in parallel from /api/voice/tts (which routes through the
// existing ElevenLabs → Groq Orpheus → local fallback cascade in
// src/voice.ts) and then played at the timeline mark. The first line
// gets a vintage-radio glitch via WaveShaper + bandpass for that "first
// transmission" feel.
// Voice script — ellipses are read by ElevenLabs Turbo v2.5 as
// noticeable pauses, which produces a deliberate, slow, theatrical
// delivery without needing SSML. Adam (voice ID pNInz6obpgDQGcFmaJgB)
// at stability 0.40 + style 0.60 reads these with the dry, calm,
// slightly British-butler cadence we want for JARVIS.
// First line "J... A... R... V... I... S... online." removed 2026-05-24
// at user request — Adam reading the letters individually peaked too
// hard. Boot now opens with "Neural core initialized" at t=4.5s.
const BOOT_VOICE_LINES: { t: number; text: string; glitch?: boolean }[] = [
  { t: 4.5,  text: 'Neural core... initialized.' },
  { t: 6.5,  text: 'Systems... synchronizing.' },
  { t: 8.5,  text: 'Welcome back... sir.' },
  { t: 11.0, text: 'All systems online.' },
];

const BOOT_MUSIC_URL = '/sounds/jarvis-boot.mp3';

function BootSequence({ onComplete, onFinalFlash, orbRef }: {
  onComplete: () => void;
  onFinalFlash?: () => void;
  orbRef: { current: OrbController | null };
}) {
  useEffect(() => {
    const audioOn = bootAudioEnabled.value;
    const tl = gsap.timeline({ defaults: { duration: 0 } });
    const tweens: gsap.core.Tween[] = [];

    // ── Hand off to the 3D orb ─────────────────────────────────────
    // The boot sequence is now entirely orb-driven. We tell the
    // OrbController to enter boot mode (camera arc + dim start +
    // 3D JARVIS text plate) and drive the orb's intensity ramp +
    // text fade via GSAP tweens below. All 2D phase visuals are gone.
    const enterOrbBoot = () => {
      const ctl = orbRef.current;
      if (!ctl) {
        // Parent's useEffect runs AFTER ours in React; wait one frame.
        requestAnimationFrame(enterOrbBoot);
        return;
      }
      ctl.enterBootMode();
    };
    enterOrbBoot();

    // Master intensity tween — orb fades up from ~8% to full over 11s
    // so the dim-to-alive arc lines up with the voice cadence.
    const intensityProxy = { value: 0.08 };
    tweens.push(gsap.to(intensityProxy, {
      value: 1.0,
      duration: 11,
      ease: 'power1.in',
      onUpdate: () => orbRef.current?.setBootIntensity(intensityProxy.value),
    }));

    // 3D JARVIS text — combined alpha + scale + Y-settle on a single
    // progress curve so the entrance reads as one cinematic move,
    // not three uncoordinated tweens. power3.out gives a fast-in,
    // smooth-settle arc — feels earned, no awkward popping.
    const textProgress = { value: 0 };
    tweens.push(gsap.to(textProgress, {
      value: 1.0,
      duration: 1.8,
      delay: 4.8,
      ease: 'power3.out',
      onUpdate: () => orbRef.current?.setBootTextProgress(textProgress.value),
    }));
    tweens.push(gsap.to(textProgress, {
      value: 0,
      duration: 1.0,
      delay: 13.6,
      ease: 'power2.in',
      onUpdate: () => orbRef.current?.setBootTextProgress(textProgress.value),
    }));

    // One shared AudioContext for glitch routing + cleanup.
    let audioCtx: AudioContext | null = null;
    if (audioOn) {
      try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch { audioCtx = null; }
    }

    // Voice-line audio buffers (parallel preload). null = preload failed
    // or hadn't finished by the time the timeline hit that mark.
    const voiceAudios: (HTMLAudioElement | null)[] = BOOT_VOICE_LINES.map(() => null);
    const voiceAnalysers: (AnalyserNode | null)[] = BOOT_VOICE_LINES.map(() => null);
    const objectUrls: string[] = [];

    // ── Voice-reactive amplitude pump ────────────────────────────────
    // While a boot voice line is playing, an AnalyserNode tap reads
    // the speech waveform and drives orbRef.setAmplitude(0..1) every
    // frame so the orb visibly pulses with Daniel's syllables. This is
    // what makes the orb feel like JARVIS talking, not just a sphere
    // playing audio.
    let ampRafId: number | null = null;
    const startAmpPump = (analyser: AnalyserNode) => {
      if (ampRafId !== null) cancelAnimationFrame(ampRafId);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const pump = () => {
        analyser.getByteFrequencyData(data);
        // Average a low-mid band where speech energy lives.
        let sum = 0;
        for (let j = 3; j < 32; j++) sum += data[j];
        const avg = sum / 29 / 255;
        const amp = Math.min(1, avg * 2.2);
        orbRef.current?.setAmplitude(amp);
        ampRafId = requestAnimationFrame(pump);
      };
      ampRafId = requestAnimationFrame(pump);
    };
    const stopAmpPump = () => {
      if (ampRafId !== null) {
        cancelAnimationFrame(ampRafId);
        ampRafId = null;
      }
      orbRef.current?.setAmplitude(0);
    };

    // Background music. Lazily created so we can early-out cleanly when
    // bootAudioEnabled is false. Volume starts at 0 and fades in/out via
    // GSAP tweens on the live .volume property.
    let music: HTMLAudioElement | null = null;
    if (audioOn) {
      music = new Audio(BOOT_MUSIC_URL);
      music.preload = 'auto';
      music.volume = 0;
      // Loop in case the clip is shorter than the boot duration. If it's
      // longer it'll just be cut off by the fade-out — that's fine.
      music.loop = true;
      // Fire-and-forget. If autoplay is blocked we silently degrade —
      // the visuals + voice-line audio (which also play() ) carry the
      // sequence on their own.
      music.addEventListener('error', () => { /* file missing — fine */ });
    }

    // Preload all 5 voice lines in parallel. As each resolves we slot
    // it into voiceAudios[i] so playLine(i) can find it later.
    async function preloadVoiceLines() {
      if (!audioOn) {
        console.warn('[boot voice] bootAudioEnabled is false — voice + music skipped');
        return;
      }
      console.log('[boot voice] starting preload for', BOOT_VOICE_LINES.length, 'lines');
      await Promise.all(BOOT_VOICE_LINES.map(async (line, i) => {
        try {
          const res = await fetch(tokenizedSseUrl('/api/voice/tts'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: line.text }),
          });
          if (!res.ok) {
            console.warn('[boot voice] line', i, 'TTS fetch HTTP', res.status, '— audio slot null');
            return;
          }
          const blob = await res.blob();
          console.log('[boot voice] line', i, 'fetched:', blob.type || '(no type)', blob.size, 'bytes');
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          const audio = new Audio(url);
          audio.preload = 'auto';
          audio.volume = 1.0;
          audio.addEventListener('error', () => {
            console.warn('[boot voice] line', i, 'AUDIO LOAD ERROR:',
              'code=', audio.error?.code, 'message=', audio.error?.message,
              'networkState=', audio.networkState, 'readyState=', audio.readyState);
          });
          audio.addEventListener('canplaythrough', () => {
            console.log('[boot voice] line', i, 'canplaythrough (ready)');
          }, { once: true });
          // Route through AudioContext → AnalyserNode → destination so
          // we can read frequency data each frame for the lip-sync pump.
          if (audioCtx) {
            try {
              const src = audioCtx.createMediaElementSource(audio);
              const analyser = audioCtx.createAnalyser();
              analyser.fftSize = 256;
              analyser.smoothingTimeConstant = 0.4;
              src.connect(analyser);
              analyser.connect(audioCtx.destination);
              voiceAnalysers[i] = analyser;
            } catch (err) {
              console.warn('[boot voice] line', i, 'analyser setup failed:', err);
            }
          }
          voiceAudios[i] = audio;
        } catch (err) {
          console.warn('[boot voice] line', i, 'preload threw:', err);
        }
      }));
      const ready = voiceAudios.filter((a) => a).length;
      console.log('[boot voice] preload complete:', ready, '/', BOOT_VOICE_LINES.length, 'lines ready');
    }

    /** Build the vintage-radio glitch routing for line 0: source →
     *  WaveShaper (soft clip) → BiquadFilter (bandpass ~1.4kHz) →
     *  destination. Slightly degrades the signal so the first line
     *  reads as a "patchy first transmission" before the system locks. */
    function attachGlitchChain(audio: HTMLAudioElement) {
      if (!audioCtx) return;
      try {
        const src = audioCtx.createMediaElementSource(audio);
        const shaper = audioCtx.createWaveShaper();
        shaper.curve = makeGlitchCurve(220);
        shaper.oversample = '4x';
        const bandpass = audioCtx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.value = 1400;
        bandpass.Q.value = 0.65;
        const gain = audioCtx.createGain();
        gain.gain.value = 0.95;
        src.connect(shaper).connect(bandpass).connect(gain).connect(audioCtx.destination);
      } catch {
        // MediaElementSource can only be created once per element; if
        // anything fails just let the audio play raw via .play() below.
      }
    }

    function playLine(index: number) {
      const audio = voiceAudios[index];
      if (!audio) {
        console.warn('[boot voice] playLine(', index, ') — slot null (preload failed?)');
        return;
      }
      const line = BOOT_VOICE_LINES[index];
      console.log('[boot voice] playLine(', index, ') firing —', line.text,
        '| volume=', audio.volume, 'muted=', audio.muted, 'readyState=', audio.readyState);
      if (line.glitch) attachGlitchChain(audio);
      // Resume audio context if browser auto-suspended it, then start
      // the lip-sync amplitude pump tied to this line's analyser.
      audioCtx?.resume().catch(() => { /* */ });
      const analyser = voiceAnalysers[index];
      if (analyser) startAmpPump(analyser);
      audio.addEventListener('ended', stopAmpPump, { once: true });
      void audio.play().then(() => {
        console.log('[boot voice] line', index, 'play() resolved — audio should be audible');
      }).catch((err) => {
        console.warn('[boot voice] line', index, 'play() REJECTED:', err?.name, err?.message,
          '— likely autoplay block; clicking Replay should count as a user gesture');
        stopAmpPump();
      });
    }

    // ── Timeline ──────────────────────────────────────────────────────
    // Total duration ~14.5s. Phases drive the visuals; .call() at each
    // voice mark triggers the corresponding preloaded TTS audio. Music
    // fades in over 3s starting at t=1.2, fades out over 1.5s at t=13.5.
    // Kick music FIRST — t=0 alongside the dot impact. Volume ramps
    // 0 → 0.42 in just 0.4s with LINEAR easing so the AC/DC riff is
    // audibly hitting within 100ms of the animation starting. Previous
    // 3s power2.in ramp made the first 1-2s feel music-less even though
    // playback was technically running. The audio clip itself starts
    // ~9.5s into "Shoot to Thrill" — drum-and-riff buildup into vocals.
    tl.call(() => {
        if (audioOn && music) {
          void music.play().catch(() => { /* autoplay blocked or file 404 */ });
          tweens.push(gsap.to(music, {
            volume: 0.42, duration: 0.4, ease: 'none',
          }));
        }
      },                                                 [], 0.00)
      // Voice timeline — orb camera + intensity drive the visuals.
      .call(() => playLine(0),                          [], 4.50) // "Neural core initialized."
      .call(() => playLine(1),                          [], 6.50) // "Systems synchronizing."
      .call(() => playLine(2),                          [], 8.50) // "Welcome back, sir."
      .call(() => {
        // Climactic beat: orb flare burst. No 2D screen flash — the
        // bigFlare() rim explosion + ring acceleration is the climax.
        onFinalFlash?.();
      },                                                 [], 10.50)
      .call(() => playLine(3),                          [], 11.00) // "All systems online."
      .call(() => {
        if (audioOn && music) {
          tweens.push(gsap.to(music, {
            volume: 0, duration: 1.5, ease: 'power2.out',
          }));
        }
      },                                                 [], 13.50)
      .call(() => {
        // Exit boot mode — camera tweens back to default, text fades.
        orbRef.current?.exitBootMode();
        onComplete();
      },                                                 [], 14.50);

    // Fire off voice-line preload. The synthesized playBootSweep() call
    // is intentionally gone — its whoosh / beeps / boom layered on top
    // of the AC/DC track sounded like extra noise. Music + voice lines
    // are now the only boot audio. (Function still defined below in
    // case we ever want to bring it back.)
    void preloadVoiceLines();

    return () => {
      tl.kill();
      tweens.forEach((t) => t.kill());
      stopAmpPump();
      if (music) {
        try { music.pause(); music.src = ''; } catch { /* */ }
      }
      voiceAudios.forEach((a) => {
        if (a) { try { a.pause(); } catch { /* */ } }
      });
      objectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* */ } });
      // AudioContext.close() returns a promise we don't care to wait on.
      audioCtx?.close().catch(() => { /* */ });
    };
  }, []);

  // BootSequence renders NO 2D visuals — the OrbController in JarvisHome
  // shows the entire cinematic via its boot-mode camera arc, intensity
  // ramp, and 3D JARVIS text plate. This component only owns the audio
  // timeline + the GSAP tweens that drive the orb.
  return null;
}

// Legacy 2D boot visuals lived here previously (5 phase blocks with the
// dot impact, expanding rings, scan sweep, SVG arcs, JARVIS letter
// reveal, climax flash). All removed — the boot cinematic is now
// entirely 3D, driven by OrbController.enterBootMode().

/**
 * WaveShaper curve for the vintage-radio glitch on the first voice
 * line. Standard cubic soft-clip formula scaled by `amount` — higher
 * values = more distortion. 220 reads as "patchy transmission" without
 * crushing intelligibility. Public-domain DSP, no library needed.
 */
function makeGlitchCurve(amount: number): Float32Array {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

/**
 * Cinematic boot audio. Layered Web Audio synthesis with five elements
 * timed to the visual phases:
 *   t=0.0  Deep sub-bass impact (sine 55Hz down to 30Hz, half-second decay)
 *   t=0.4  Rising whoosh (filtered noise sweep, 800ms)
 *   t=1.6  Three quick ascending sweeps (the classic JARVIS bootup beeps)
 *   t=3.4  Sustained low pad (two detuned sines, gentle swell)
 *   t=5.0  Climactic boom (chord stack + bass drop, the orb-reveal moment)
 * All values tuned to feel theatrical without overpowering whatever else
 * is playing on the user's machine. Wrapped in try/catch because
 * Chrome's autoplay policy can reject pre-gesture; visual carries fine
 * without audio in that case.
 */
function playBootSweep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 1.0;
    master.connect(ctx.destination);
    const now = ctx.currentTime;

    // ── t=0.0: Deep sub-bass impact ───────────────────────────────────
    {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(55, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.5);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.45, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
      osc.connect(gain).connect(master);
      osc.start(now);
      osc.stop(now + 0.75);
    }

    // ── t=0.4: Rising whoosh (filtered noise) ─────────────────────────
    {
      const bufferSize = ctx.sampleRate * 1.2;
      const buf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) ch[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.2;
      filter.frequency.setValueAtTime(400, now + 0.4);
      filter.frequency.exponentialRampToValueAtTime(4000, now + 1.2);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now + 0.4);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.7);
      gain.gain.linearRampToValueAtTime(0.0001, now + 1.3);
      noise.connect(filter).connect(gain).connect(master);
      noise.start(now + 0.4);
      noise.stop(now + 1.3);
    }

    // ── t=1.6: Three ascending beeps (classic JARVIS sweep) ───────────
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t0 = now + 1.6 + i * 0.35;
      osc.frequency.setValueAtTime(330 + i * 110, t0);
      osc.frequency.exponentialRampToValueAtTime(660 + i * 110, t0 + 0.18);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.10, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + 0.34);
    }

    // ── t=3.4: Sustained pad (two detuned sines, swelling) ────────────
    [0, 7].forEach((detune, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = now + 3.4;
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = 220;
      osc.detune.value = detune;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.08, t0 + 0.6);
      gain.gain.linearRampToValueAtTime(0.0001, t0 + 2.3);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + 2.4);
    });

    // ── t=5.0: Climactic boom (chord + sub-drop) ──────────────────────
    [110, 165, 220].forEach((f) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = now + 5.0;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.13, t0 + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + 1.7);
    });
    // Sub-drop at the same instant
    {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = now + 5.0;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, t0);
      osc.frequency.exponentialRampToValueAtTime(35, t0 + 1.4);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.35, t0 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + 1.7);
    }
  } catch {
    // Autoplay blocked or AudioContext unavailable — visual carries fine.
  }
}

// ──────────────────────────────────────────────────────────────────────
// PREMIUM ORB CONTROLLER — JARVIS Core v4 ("Cinematic")
// ──────────────────────────────────────────────────────────────────────
// Cinematic, focused, premium. Inspired by the Iron Man / Jayse Hansen
// JARVIS interface. Six deliberate layers, no visual noise:
//
//   1. Inner luminous core — small bright cyan emissive sphere at the
//      heart of the orb. Breathes with idle, pumps on amp + flare.
//   2. Volumetric plasma orb — smooth shader sphere with controlled
//      internal plasma flow (low-frequency simplex sampled in world
//      space). Soft cyan glow, semi-transparent so the core reads
//      through. NOT chaotic — elegant flowing motion.
//   3. Glass refraction shell — outer fresnel sphere, hairline rim
//      glow with a faint secondary band. Sells the "glass dome" feel.
//   4. Curved holographic JARVIS title plate — slightly-curved plane
//      positioned just in front of the orb. Renders a baked text
//      canvas (sharp letters + soft halo) with a shader that adds
//      animated scanlines + a periodic downward sweep + occasional
//      micro-glitch. Lives in the SCENE (not the rotating group) so
//      it stays facing the camera regardless of drag rotation.
//   5. Four elegant rings — different radii, tilts, patterns:
//        a) thin SOLID equatorial     (r=1.30, slow forward)
//        b) thin DASHED ~25° tilt     (r=1.42, faster opposite)
//        c) thin SEGMENTED ~58° tilt  (r=1.55, slow forward)
//        d) hairline SOLID ~78° tilt  (r=1.70, very slow opposite)
//   6. Soft particle field — ~460 quiet cyan particles drifting in a
//      thin shell around the orb. Ambient depth, not noise.
//
// Public API (preserved — do not break):
//   pulseSpeak(intensity)  — short audio-style pulse (auto-decays in 2.5s)
//   setAmplitude(value)    — continuous amp set (used by AnalyserNode)
//   bigFlare()             — sustained climactic intensification (5s)
//
// Mouse interaction:
//   drag           — rotates the cage (yaw + pitch). Text plate stays.
//   hover          — ramps uHover → brighter rim, faster rings, more pulse.
// ──────────────────────────────────────────────────────────────────────

interface OrbUniforms {
  uTime: { value: number };
  uIdle: { value: number };
  uAmp: { value: number };
  uHover: { value: number };
  uFlare: { value: number };
  uColorA: { value: THREE.Color };
  uColorB: { value: THREE.Color };
}

class OrbController {
  private canvas: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private rafId = 0;

  // Mesh layers — dense particle plasma shell wrapped in a semi-
  // transparent Phong glass. Fully hollow — no inner sphere of any
  // kind so the orb reads as a translucent energy membrane.
  private particleShell!: THREE.Points;    // dense Fibonacci-distributed plasma shell
  private outerShell!: THREE.Mesh;         // semi-transparent Phong glass + injected fresnel
  private rings: THREE.Mesh[] = [];        // three thin holographic rings
  private particles!: THREE.Points;        // soft cyan ambient particle cloud
  private arcs: { line: THREE.Line; mat: THREE.LineBasicMaterial; nextFire: number }[] = [];
  private starField!: THREE.Points;        // far-distance starscape (sole backdrop now)
  // Boot mode — drives the cinematic camera arc + 3D text plate + intensity ramp.
  // When inBootMode, the camera is animated by the controller instead of staying
  // at the default (0, 0, 4.4). bootIntensity (0..1) is driven externally via a
  // GSAP tween from the BootSequence component and scales orb-element opacities.
  private inBootMode = false;
  private bootStart = 0;
  private bootDurationMs = 14500;
  private bootIntensity = 1.0;
  private bootTextPatch?: THREE.Mesh;
  private bootTextTexture?: THREE.CanvasTexture;
  // Driven by setBootTextProgress — combined alpha + Y-settle + scale.
  private bootTextProgress = 0;
  private group!: THREE.Group;             // rotatable orb cage

  // Lighting
  private pointLight!: THREE.PointLight;

  // GSAP breathing tween (0.95 → 1.08 on group scale)
  private breathTween?: gsap.core.Tween;

  // Shared uniforms — every shader material reads from this single
  // object reference so per-frame updates in tick() apply everywhere.
  private uniforms!: OrbUniforms;

  // Animation targets (lerped each frame)
  private targetAmp = 0;
  private targetHover = 0;
  private targetFlare = 0;
  private flareDecayUntil = 0;

  // User rotation (yaw/pitch in radians)
  private targetYaw = 0;
  private targetPitch = 0;
  private currentYaw = 0;
  private currentPitch = 0;

  // Drag state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartYaw = 0;
  private dragStartPitch = 0;
  private dragPointerId: number | null = null;

  private resizeObserver?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  start() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    // Cinematic tone mapping — softens highlights, gives the cyan
    // bloom a film-grade feel instead of clipping to pure white.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(0, 0, 4.4);
    this.camera.lookAt(0, 0, 0);

    this.uniforms = {
      uTime:   { value: 0 },
      uIdle:   { value: 0 },
      uAmp:    { value: 0 },
      uHover:  { value: 0 },
      uFlare:  { value: 0 },
      uColorA: { value: new THREE.Color('#00f0ff') }, // bright primary cyan
      uColorB: { value: new THREE.Color('#0099d4') }, // deeper cyan for shadows / plasma valleys
    };

    // ── Scene lights ────────────────────────────────────────────────
    // Cyan ambient lifts shadows just enough that the Phong outer
    // shell reads as glass. A strong cyan PointLight at the orb's
    // origin lights the inside of the shell, giving real refraction
    // depth (not just a fresnel shader trick). Distance/decay tuned
    // so the light doesn't leak across the rest of the page.
    this.scene.add(new THREE.AmbientLight(0x001824, 0.55));
    this.pointLight = new THREE.PointLight(0x00f0ff, 4.5, 6, 1.7);
    this.pointLight.position.set(0, 0, 0);
    this.scene.add(this.pointLight);

    // Rotatable cage — everything except the text plate lives here.
    this.group = new THREE.Group();
    this.group.scale.setScalar(0.95); // GSAP breathing target starts here
    this.scene.add(this.group);

    // ── Star field backdrop ─────────────────────────────────────────
    // Sparse, dim spherical shell distribution so stars surround the
    // camera at every angle. No planets, no orbital rings — just stars
    // (planets were removed; they read as flat dots and broke the
    // premium feel).
    const STAR_COUNT = 1400;
    const starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const sr = 14 + Math.random() * 26;
      const stheta = Math.random() * Math.PI * 2;
      const sphi = Math.acos(2 * Math.random() - 1);
      starPositions[i * 3 + 0] = sr * Math.sin(sphi) * Math.cos(stheta);
      starPositions[i * 3 + 1] = sr * Math.sin(sphi) * Math.sin(stheta);
      starPositions[i * 3 + 2] = sr * Math.cos(sphi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xc8e0ff,
      size: 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.starField = new THREE.Points(starGeo, starMat);
    this.scene.add(this.starField);

    // ── Layer 2: Dense plasma particle shell ────────────────────────
    // ~3800 cyan particles distributed via Fibonacci spiral on a
    // sphere surface (radius 0.85). Each particle's radial position
    // is displaced by 3D simplex noise sampled at its base position +
    // uTime, so the entire shell wobbles like a living plasma
    // membrane. Pumps harder on uAmp / uFlare so the shell visibly
    // surges with Daniel's voice during boot.
    const SHELL_COUNT = 3800;
    const shellPositions = new Float32Array(SHELL_COUNT * 3);
    const shellSeeds = new Float32Array(SHELL_COUNT);
    const shellSizes = new Float32Array(SHELL_COUNT);
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < SHELL_COUNT; i++) {
      const y = 1 - (i / (SHELL_COUNT - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const ang = goldenAngle * i;
      shellPositions[i * 3 + 0] = Math.cos(ang) * r;
      shellPositions[i * 3 + 1] = y;
      shellPositions[i * 3 + 2] = Math.sin(ang) * r;
      shellSeeds[i] = Math.random();
      shellSizes[i] = 0.025 + Math.random() * 0.030;
    }
    const pShellGeo = new THREE.BufferGeometry();
    pShellGeo.setAttribute('position', new THREE.BufferAttribute(shellPositions, 3));
    pShellGeo.setAttribute('seed', new THREE.BufferAttribute(shellSeeds, 1));
    pShellGeo.setAttribute('size', new THREE.BufferAttribute(shellSizes, 1));
    const pShellMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:      this.uniforms.uTime,
        uIdle:      this.uniforms.uIdle,
        uAmp:       this.uniforms.uAmp,
        uHover:     this.uniforms.uHover,
        uFlare:     this.uniforms.uFlare,
        uColorA:    this.uniforms.uColorA,
        uColorB:    this.uniforms.uColorB,
        uShellBoot: { value: 1.0 },  // bootIntensity (driven from tick)
      },
      vertexShader: DENSE_SHELL_VERT,
      fragmentShader: DENSE_SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particleShell = new THREE.Points(pShellGeo, pShellMat);
    this.group.add(this.particleShell);

    // ── Layer 3: Outer glass refraction shell ───────────────────────
    // MeshPhongMaterial with onBeforeCompile injection for fresnel.
    // Real Phong lighting from the PointLight inside gives the shell
    // proper specular highlights — actual glass, not a fresnel-only
    // shader fake. Opacity 0.18 keeps it whisper-thin; the injected
    // fresnel ramps alpha at the rim so the silhouette is sharp.
    const shellGeo = new THREE.SphereGeometry(0.96, 96, 64);
    const shellMat = new THREE.MeshPhongMaterial({
      color: 0x00181f,
      emissive: 0x00708a,
      emissiveIntensity: 0.55,
      specular: 0x9ff5ff,
      shininess: 110,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // Fresnel injection — adds rim glow + alpha ramp via the standard
    // Three.js Phong fragment pipeline. We hook into the lights_fragment_end
    // chunk so we run AFTER the lighting calculation but BEFORE tone mapping.
    const shellExtras = {
      uFresnelColor:    { value: new THREE.Color(0x00f0ff) },
      uFresnelPow:      { value: 2.0 },
      uFresnelStrength: { value: 1.9 },
      uIdleRef:         this.uniforms.uIdle,
      uAmpRef:          this.uniforms.uAmp,
      uHoverRef:        this.uniforms.uHover,
      uFlareRef:        this.uniforms.uFlare,
    };
    shellMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shellExtras);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3  uFresnelColor;
           uniform float uFresnelPow;
           uniform float uFresnelStrength;
           uniform float uIdleRef;
           uniform float uAmpRef;
           uniform float uHoverRef;
           uniform float uFlareRef;`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           vec3 vd = normalize(vViewPosition);
           float fres = pow(1.0 - clamp(dot(vd, normal), 0.0, 1.0), uFresnelPow);
           float pulse = 1.0 + uIdleRef * 0.18 + uAmpRef * 0.55 + uHoverRef * 0.30 + uFlareRef * 1.25;
           reflectedLight.directDiffuse += uFresnelColor * fres * uFresnelStrength * pulse;
           diffuseColor.a = clamp(diffuseColor.a + fres * 0.65 * pulse, 0.0, 1.0);`
        );
    };
    this.outerShell = new THREE.Mesh(shellGeo, shellMat);
    this.group.add(this.outerShell);

    // ── Layer 5: Holographic rings (3 — solid/dashed/segmented) ────
    // Three thin rings at distinct tilts. Cleaner than four. Orange
    // accent activates on the traveling spark only during bigFlare().
    const ringConfigs: Array<{ radius: number; tube: number; tiltX: number; tiltZ: number; pattern: number; color: string; alpha: number }> = [
      { radius: 1.18, tube: 0.005, tiltX:  0.00,           tiltZ:  0.00,           pattern: 0, color: '#00f0ff', alpha: 1.00 }, // solid equatorial
      { radius: 1.34, tube: 0.0045, tiltX: Math.PI * 0.22, tiltZ:  Math.PI * 0.08, pattern: 1, color: '#00e8ff', alpha: 0.85 }, // dashed ~40°
      { radius: 1.50, tube: 0.006, tiltX:  Math.PI * 0.40, tiltZ: -Math.PI * 0.14, pattern: 2, color: '#00f0ff', alpha: 0.90 }, // segmented ~72°
    ];
    for (const cfg of ringConfigs) {
      const geo = new THREE.TorusGeometry(cfg.radius, cfg.tube, 14, 512);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime:      this.uniforms.uTime,
          uAmp:       this.uniforms.uAmp,
          uHover:     this.uniforms.uHover,
          uFlare:     this.uniforms.uFlare,
          uPattern:   { value: cfg.pattern },
          uRingColor: { value: new THREE.Color(cfg.color) },
          uRingAlpha: { value: cfg.alpha },
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = cfg.tiltX;
      ring.rotation.z = cfg.tiltZ;
      this.rings.push(ring);
      this.group.add(ring);
    }

    // ── Layer 6: Soft particle cloud (quiet ambient depth) ──────────
    const PARTICLE_COUNT = 480;
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);
    const seeds = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const r = 1.20 + Math.random() * 1.30;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      sizes[i] = 0.010 + Math.random() * 0.020;
      seeds[i] = Math.random();
    }
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    particleGeo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    const particleMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(particleGeo, particleMat);
    this.group.add(this.particles);

    // ── Layer 7: Lightning arcs (climax energy strikes) ─────────────
    // Six LineSegments pre-allocated, opacity 0 most of the time.
    // They fire during bigFlare() / high amp peaks, retargeting from
    // near the core to a random surface point with jagged jitter.
    // Pure cyan additive — no white component, so they never wash
    // out even when multiple fire simultaneously.
    const ARC_COUNT = 6;
    const ARC_POINTS = 28;
    for (let i = 0; i < ARC_COUNT; i++) {
      const arcPositions = new Float32Array(ARC_POINTS * 3);
      const arcGeo = new THREE.BufferGeometry();
      arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
      const arcMat = new THREE.LineBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(arcGeo, arcMat);
      this.arcs.push({ line, mat: arcMat, nextFire: 0.6 + Math.random() * 2.0 });
      this.group.add(line);
    }

    // ── GSAP breathing pulse — group scale 0.95 → 1.08 ──────────────
    // Cinematic visible pulse independent of the shader-side uIdle
    // sine. Syncs to the boot climax automatically because bigFlare()
    // bumps uAmp/uFlare which the shaders read on top of this scale.
    this.breathTween = gsap.to(this.group.scale, {
      x: 1.08, y: 1.08, z: 1.08,
      duration: 2.4,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
    });

    // ── Resize + tick ───────────────────────────────────────────────
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    } else {
      window.addEventListener('resize', this.resize);
    }

    // ── Pointer interactions ────────────────────────────────────────
    this.canvas.style.touchAction = 'none'; // pointer events without scroll/zoom interference
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerenter', this.onPointerEnter);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.tick();
  }

  /** Boost uAmp briefly to simulate Jarvis speaking. 0..1 intensity. */
  pulseSpeak(intensity: number) {
    this.targetAmp = Math.max(this.targetAmp, intensity);
    setTimeout(() => { this.targetAmp = 0; }, 2500);
  }

  /**
   * Set the orb amplitude continuously (0..1). Used by the AnalyserNode
   * pump during TTS playback for real-time lip-sync. Unlike pulseSpeak,
   * this does NOT auto-decay — the caller is responsible for setting 0
   * when audio ends.
   */
  setAmplitude(value: number) {
    this.targetAmp = Math.max(0, Math.min(1, value));
  }

  /**
   * Climactic intensification — used for the "All systems online" beat.
   * Slams uFlare to 1 for 600ms (drives ring brightness + rim explosion
   * in the orb shader) and holds amp at 1.0 for ~5s before releasing.
   */
  bigFlare() {
    this.targetFlare = 1.0;
    this.targetAmp = 1.0;
    this.flareDecayUntil = performance.now() + 5000;
  }

  // ── Cinematic boot mode ──────────────────────────────────────────────
  /**
   * Enter boot mode. Camera switches from the default static position to
   * an animated arc, intensity starts low so the orb reads dim/subtle,
   * and a 3D JARVIS title plate is added to the scene (faded in via
   * setBootTextFade). BootSequence calls this on mount.
   */
  enterBootMode() {
    this.inBootMode = true;
    this.bootStart = performance.now();
    this.bootIntensity = 0.08;
    this.bootTextProgress = 0;
    if (!this.bootTextPatch) {
      // Flat plane for the iOS-clean look. The previous curved plate
      // was foreshortening J and S at the edges (the curvature pulled
      // the outer glyphs away from the camera). A flat plane keeps
      // every glyph at the same depth — clean, modern, and matches
      // the rest of the dashboard's iOS-native design language.
      const textGeo = new THREE.PlaneGeometry(3.0, 0.78);
      this.bootTextTexture = makeJarvisTextTexture();
      const textMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime:        this.uniforms.uTime,
          uIdle:        this.uniforms.uIdle,
          uAmp:         this.uniforms.uAmp,
          uHover:       this.uniforms.uHover,
          uFlare:       this.uniforms.uFlare,
          uTex:         { value: this.bootTextTexture },
          uColorA:      { value: new THREE.Color(0x00f0ff) }, // cyan — letters AND dots
          uColorB:      { value: new THREE.Color(0x00d4ff) }, // deeper cyan — halo (R=0, no white-wash risk)
          uColorAccent: { value: new THREE.Color(0xff9500) }, // subtle outer-halo tint only — never on letters/dots
          uFade:        { value: 0 },
        },
        vertexShader: TEXT_VERT,
        fragmentShader: TEXT_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.bootTextPatch = new THREE.Mesh(textGeo, textMat);
      this.bootTextPatch.renderOrder = 20;
      this.scene.add(this.bootTextPatch);
    }
    this.bootTextPatch.visible = true;
    (this.bootTextPatch.material as THREE.ShaderMaterial).uniforms.uFade.value = 0;
  }

  /**
   * Exit boot mode. Camera tweens back to the default static position;
   * 3D text fades out then hides; bootIntensity goes to 1.0 so the orb
   * reads at full strength on the dashboard.
   */
  exitBootMode() {
    this.inBootMode = false;
    this.bootIntensity = 1.0;
    gsap.to(this.camera.position, {
      x: 0, y: 0, z: 4.4,
      duration: 1.4,
      ease: 'power2.inOut',
      onUpdate: () => this.camera.lookAt(0, 0, 0),
    });
    if (this.bootTextPatch) {
      const u = (this.bootTextPatch.material as THREE.ShaderMaterial).uniforms.uFade;
      gsap.to(u, {
        value: 0,
        duration: 0.9,
        ease: 'power2.in',
        onComplete: () => {
          if (this.bootTextPatch) this.bootTextPatch.visible = false;
        },
      });
    }
  }

  /** Drive the dim → full intensity ramp during boot (0..1). */
  setBootIntensity(level: number) {
    this.bootIntensity = Math.max(0, Math.min(1, level));
  }

  /**
   * Combined entrance/exit driver for the 3D JARVIS title (0..1).
   * Drives the shader alpha (uFade), the scale (0.78 → 1.0), and the
   * Y-settle (-0.18 → 0). The per-frame position is recomputed in
   * tick() so the plate is always perfectly centered on the camera's
   * view direction, even while the camera orbits.
   */
  setBootTextProgress(value: number) {
    this.bootTextProgress = Math.max(0, Math.min(1, value));
    if (this.bootTextPatch) {
      (this.bootTextPatch.material as THREE.ShaderMaterial).uniforms.uFade.value = this.bootTextProgress;
    }
  }

  // ── Pointer handlers ─────────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent) => {
    if (this.dragPointerId !== null) return;
    this.isDragging = true;
    this.dragPointerId = e.pointerId;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartYaw = this.targetYaw;
    this.dragStartPitch = this.targetPitch;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* */ }
    this.canvas.style.cursor = 'grabbing';
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging || e.pointerId !== this.dragPointerId) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    // Sensitivity tuned so a horizontal drag across the canvas yields
    // ~1.5 full revolutions — feels like spinning a physical object.
    const rect = this.canvas.getBoundingClientRect();
    const sens = (Math.PI * 3) / Math.max(rect.width, 600);
    this.targetYaw = this.dragStartYaw + dx * sens;
    this.targetPitch = clamp(this.dragStartPitch + dy * sens, -Math.PI / 2.2, Math.PI / 2.2);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.dragPointerId) return;
    this.isDragging = false;
    this.dragPointerId = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
    this.canvas.style.cursor = 'grab';
  };

  private onPointerEnter = () => {
    this.targetHover = 1.0;
    if (!this.isDragging) this.canvas.style.cursor = 'grab';
  };

  private onPointerLeave = () => {
    this.targetHover = 0.0;
  };

  // ── Resize + tick ───────────────────────────────────────────────────

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private tick = () => {
    const dt = Math.min(this.clock.getDelta(), 0.05); // clamp big steps after tab focus
    const t = this.clock.getElapsedTime();
    const u = this.uniforms;
    u.uTime.value = t;
    // Slow breathing — sine in 0..1
    u.uIdle.value = 0.5 + 0.5 * Math.sin(t * 0.55);
    // Lerp amp + hover + flare toward targets. Different rates so the
    // flare feels punchy and the hover ramps gently.
    u.uAmp.value   += (this.targetAmp   - u.uAmp.value)   * Math.min(1, dt * 6);
    u.uHover.value += (this.targetHover - u.uHover.value) * Math.min(1, dt * 5);
    u.uFlare.value += (this.targetFlare - u.uFlare.value) * Math.min(1, dt * 4);

    // ── Cinematic boot camera arc ────────────────────────────────────
    // While in boot mode, the camera doesn't sit at (0, 0, 4.4) — it
    // swoops from upper-back-left, around to centered-front, ending
    // at the default position. S-curve eased so the motion feels
    // smooth (no constant-velocity strobing). exitBootMode() tweens
    // the camera back; tick() leaves the camera alone after exit.
    if (this.inBootMode) {
      const elapsed = performance.now() - this.bootStart;
      const tb = Math.min(1, elapsed / this.bootDurationMs);
      const ease = tb * tb * (3 - 2 * tb);  // smoothstep
      const ang = -Math.PI * 0.30 + ease * Math.PI * 0.30;
      const dist = 8.5 - ease * 4.1;
      const hgt  = 2.4 - ease * 2.4;
      this.camera.position.set(
        Math.sin(ang) * dist,
        hgt,
        Math.cos(ang) * dist,
      );
      this.camera.lookAt(0, 0, 0);
      // ── Camera-locked text positioning ──
      // Place the title plate along the camera's forward axis so it
      // is GUARANTEED centered in view, regardless of where the
      // camera arc currently sits. Scale + Y-settle are driven by
      // bootTextProgress (set externally by GSAP).
      if (this.bootTextPatch && this.bootTextPatch.visible) {
        const fwd = new THREE.Vector3();
        this.camera.getWorldDirection(fwd);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const p = this.bootTextProgress;
        // Smooth ease-out for the position settle so the entrance feels
        // earned rather than poppy.
        const settle = 1 - Math.pow(1 - p, 3);
        const yOffset = -0.18 * (1 - settle);
        const scale = 0.78 + 0.22 * settle;
        const pos = this.camera.position.clone()
          .addScaledVector(fwd, 3.6)
          .addScaledVector(up, yOffset);
        this.bootTextPatch.position.copy(pos);
        this.bootTextPatch.quaternion.copy(this.camera.quaternion);
        this.bootTextPatch.scale.setScalar(scale);
      }
    }
    // Flare auto-decay
    if (this.flareDecayUntil > 0 && performance.now() > this.flareDecayUntil) {
      this.targetFlare = 0;
      this.targetAmp = 0;
      this.flareDecayUntil = 0;
    }

    // Yaw/pitch — drag rotates the cage, gentle auto-spin when idle.
    if (!this.isDragging) {
      this.targetYaw += dt * (0.12 + u.uHover.value * 0.18);
      this.targetPitch += dt * 0.02 * Math.sin(t * 0.13);
    }
    const lerp = Math.min(1, dt * 4.5);
    this.currentYaw += (this.targetYaw - this.currentYaw) * lerp;
    this.currentPitch += (this.targetPitch - this.currentPitch) * lerp;
    this.group.rotation.y = this.currentYaw;
    this.group.rotation.x = this.currentPitch;

    // PointLight intensity drives the Phong outer shell's specular
    // highlights — the cinematic "alive" feel during amp + flare.
    this.pointLight.intensity = 3.2 + u.uIdle.value * 1.2
                              + u.uAmp.value * 4.0
                              + u.uHover.value * 1.0
                              + u.uFlare.value * 6.5;

    // Star field — slow drift gives the backdrop parallax motion.
    this.starField.rotation.y -= dt * 0.005;

    // Outer shell + ambient particle cloud opacity scaling.
    const bi = this.bootIntensity;
    (this.outerShell.material as THREE.MeshPhongMaterial).opacity = 0.18 * bi;
    (this.particles.material as THREE.ShaderMaterial).opacity = bi;
    // Particle shell ShaderMaterial doesn't have a flat opacity — fade
    // it via a uniform. uHover/uAmp/uFlare drive intensity inside the
    // shader; bootIntensity multiplies the final alpha there too.
    (this.particleShell.material as THREE.ShaderMaterial).uniforms.uShellBoot.value = bi;

    // Internal rotations — wireframe + dots co-rotate so the dots
    // ride the line intersections; both spin around y/x at gentle rates.
    // Slow shell rotation — the noise flow inside the shader handles
    // the "alive" motion; this just adds a gentle parallax sweep.
    this.particleShell.rotation.y -= dt * 0.06;
    this.particleShell.rotation.x += dt * 0.02;
    this.particles.rotation.y += dt * 0.04;

    // Ring spins — different speeds + directions for cinematic motion.
    const ringBoost = 1 + u.uHover.value * 0.6 + u.uFlare.value * 1.4;
    if (this.rings[0]) this.rings[0].rotation.z += dt *  0.22 * ringBoost;
    if (this.rings[1]) this.rings[1].rotation.z -= dt *  0.40 * ringBoost;
    if (this.rings[2]) this.rings[2].rotation.z += dt *  0.32 * ringBoost;
    if (this.rings[3]) this.rings[3].rotation.z -= dt *  0.18 * ringBoost;

    // Lightning arcs — fire stochastically, frequency scales with amp+flare.
    // Quiet at idle (rare strike every few seconds), electric at climax.
    const arcRate = 0.6 + u.uAmp.value * 2.0 + u.uFlare.value * 4.0 + u.uHover.value * 0.5;
    for (const a of this.arcs) {
      a.nextFire -= dt * arcRate;
      if (a.nextFire > 0) {
        a.mat.opacity = Math.max(0, a.mat.opacity - dt * 5.0);
        continue;
      }
      // Retarget: jagged path from near the core (r≈0.30) to a random
      // point near the outer shell surface (r≈1.00) with perpendicular jitter.
      const phi   = Math.random() * Math.PI * 2;
      const theta = Math.acos(2 * Math.random() - 1);
      const sx = Math.sin(theta) * Math.cos(phi);
      const sy = Math.sin(theta) * Math.sin(phi);
      const sz = Math.cos(theta);
      const startR = 0.28 + Math.random() * 0.12;
      const endR   = 1.00;
      const posAttr = a.line.geometry.attributes.position as THREE.BufferAttribute;
      const N = posAttr.count;
      for (let i = 0; i < N; i++) {
        const ti = i / (N - 1);
        const r = startR + (endR - startR) * ti;
        const jitter = 0.10 * Math.sin(ti * Math.PI) * (1 - Math.abs(0.5 - ti) * 1.4);
        const jx = (Math.random() - 0.5) * jitter;
        const jy = (Math.random() - 0.5) * jitter;
        const jz = (Math.random() - 0.5) * jitter;
        posAttr.setXYZ(i, sx * r + jx, sy * r + jy, sz * r + jz);
      }
      posAttr.needsUpdate = true;
      a.line.geometry.computeBoundingSphere();
      a.mat.opacity = 0.85;
      a.nextFire = 1.2 + Math.random() * 2.8;
    }

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.breathTween?.kill();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerenter', this.onPointerEnter);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    [this.outerShell, ...this.rings].forEach((m) => {
      if (!m) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    if (this.starField) {
      this.starField.geometry.dispose();
      (this.starField.material as THREE.Material).dispose();
    }
    if (this.bootTextPatch) {
      this.bootTextPatch.geometry.dispose();
      (this.bootTextPatch.material as THREE.Material).dispose();
    }
    if (this.bootTextTexture) this.bootTextTexture.dispose();
    if (this.particleShell) {
      this.particleShell.geometry.dispose();
      (this.particleShell.material as THREE.Material).dispose();
    }
    if (this.particles) {
      this.particles.geometry.dispose();
      (this.particles.material as THREE.Material).dispose();
    }
    for (const a of this.arcs) {
      a.line.geometry.dispose();
      a.mat.dispose();
    }
    this.renderer.dispose();
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build a curved holographic plane geometry — a rectangle bent along
 * its x-axis into a horizontal arc, so the surface follows an imaginary
 * larger sphere. Center stays at local (0, 0, 0) facing +Z; left/right
 * edges curl back along -Z. Used for the JARVIS title plate that wraps
 * gently around the front of the orb.
 */
function makeCurvedHologramPlane(width: number, height: number, bendRadius: number, segW = 96, segH = 24): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(width, height, segW, segH);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const R = bendRadius;
  for (let i = 0; i < pos.count; i++) {
    const x0 = pos.getX(i);
    const y0 = pos.getY(i);
    const angle = x0 / R;
    pos.setX(i, Math.sin(angle) * R);
    pos.setY(i, y0);
    pos.setZ(i, -(R - Math.cos(angle) * R));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Bake the JARVIS title into an offscreen canvas. RED channel holds
 * the sharp letter mask, GREEN channel holds a soft outer glow halo
 * built up from multi-pass shadow blurs. The TEXT_FRAG shader uses
 * these as two complementary masks: sharp drives the crisp cyan
 * letters, halo drives the surrounding emission.
 */
function makeJarvisTextTexture(): THREE.CanvasTexture {
  // Cinematic JARVIS title plate — Tony Stark grade.
  //
  // Every glyph is HAND-LAID-OUT via measured widths so spacing is
  // pixel-perfect on any platform (no reliance on the patchy
  // Canvas 2D letterSpacing property). PERIODS are drawn as real
  // round circles via ctx.arc(), NOT as font glyphs — that way they
  // look like clean cinematic dots regardless of which OS font the
  // browser falls back to (Segoe UI on Windows renders period glyphs
  // as chunky squares at heavy weights — the arc() approach fixes
  // this completely).
  //
  // Channels:  R = sharp text mask, G = soft halo, A = max(R, G)
  const W = 3072;
  const H = 768;
  const FONT_SIZE = 500;
  // Segoe UI first for Windows native, SF Pro Display for macOS, then
  // a robust system fallback chain.
  const FONT = `800 ${FONT_SIZE}px "Segoe UI", "SF Pro Display", "Inter", "-apple-system", "BlinkMacSystemFont", "Helvetica Neue", "Helvetica", "Arial", sans-serif`;
  const LETTERS = ['J', 'A', 'R', 'V', 'I', 'S'];
  const DOT_RADIUS       = FONT_SIZE * 0.062;
  const DOT_LEFT_GAP     = FONT_SIZE * 0.075;
  const DOT_RIGHT_GAP    = FONT_SIZE * 0.075;
  const EXTRA_LETTER_GAP = FONT_SIZE * 0.025;
  // Dots sit just below em-middle — near optical baseline so they
  // read as periods, not floating mid-line bullets.
  const DOT_Y_OFFSET = FONT_SIZE * 0.06;

  // Measure each letter's advance width so layout is exact.
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = FONT;
  const letterWidths = LETTERS.map((L) => measure.measureText(L).width);

  // Build the layout: letter, dot, letter, dot, ... finishing on a dot.
  type Glyph = { kind: 'letter'; x: number; char: string } | { kind: 'dot'; x: number };
  const glyphs: Glyph[] = [];
  let totalWidth = 0;
  for (let i = 0; i < LETTERS.length; i++) {
    totalWidth += letterWidths[i] + DOT_LEFT_GAP + DOT_RADIUS * 2 + DOT_RIGHT_GAP;
    if (i < LETTERS.length - 1) totalWidth += EXTRA_LETTER_GAP;
  }
  const startX = (W - totalWidth) / 2;
  let cursor = startX;
  for (let i = 0; i < LETTERS.length; i++) {
    const w = letterWidths[i];
    glyphs.push({ kind: 'letter', x: cursor + w / 2, char: LETTERS[i] });
    cursor += w + DOT_LEFT_GAP;
    glyphs.push({ kind: 'dot', x: cursor + DOT_RADIUS });
    cursor += DOT_RADIUS * 2 + DOT_RIGHT_GAP;
    if (i < LETTERS.length - 1) cursor += EXTRA_LETTER_GAP;
  }
  const baseY = H / 2;

  const draw = (ctx: CanvasRenderingContext2D, blurPasses: number[]) => {
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    for (const blur of blurPasses) {
      ctx.shadowBlur = blur;
      for (const g of glyphs) {
        if (g.kind === 'letter') {
          ctx.fillText(g.char, g.x, baseY);
        } else {
          ctx.beginPath();
          ctx.arc(g.x, baseY + DOT_Y_OFFSET, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  };

  // Halo — three blur radii build a tight premium outer glow.
  const halo = document.createElement('canvas');
  halo.width = W; halo.height = H;
  draw(halo.getContext('2d')!, [60, 32, 16]);

  // Sharp — full text + dots, no blur.
  const sharp = document.createElement('canvas');
  sharp.width = W; sharp.height = H;
  draw(sharp.getContext('2d')!, [0]);

  // Composite — R=sharp, G=halo, B=0, A=max.
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d')!;
  const haloData = halo.getContext('2d')!.getImageData(0, 0, W, H).data;
  const sharpData = sharp.getContext('2d')!.getImageData(0, 0, W, H).data;
  const final = octx.createImageData(W, H);
  for (let i = 0; i < final.data.length; i += 4) {
    const s = sharpData[i + 3];
    const h = haloData[i + 3];
    final.data[i + 0] = s;
    final.data[i + 1] = h;
    final.data[i + 2] = 0;
    final.data[i + 3] = Math.max(s, h);
  }
  octx.putImageData(final, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ──────────────────────────────────────────────────────────────────────
// SHADERS
// ──────────────────────────────────────────────────────────────────────

const SIMPLEX = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// ── Dense plasma particle shell (the orb body) ───────────────────────
// 3,800 Fibonacci-distributed particles on a unit sphere displaced
// radially by 3D simplex noise(position * scale + uTime). Each
// particle drifts in/out from the base radius (0.85) so the entire
// shell ripples like a living plasma membrane. Per-particle seed
// drives independent twinkle phase; particles in displacement
// "ridges" glow brighter than those in "valleys".
const DENSE_SHELL_VERT = `
uniform float uTime;
uniform float uIdle;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
attribute float seed;
attribute float size;
varying float vGlow;
varying float vSeed;
${SIMPLEX}
void main() {
  vec3 dir = normalize(position);
  // Multi-octave radial displacement — slow large waves + faster
  // small ripples. Amp + flare pump amplitude so the shell visibly
  // surges with Daniel's voice during boot.
  float t = uTime * 0.42;
  float n1 = snoise(dir * 1.5 + vec3(t * 0.70, t * 0.50, t * 0.30));
  float n2 = snoise(dir * 3.4 - vec3(t * 0.40, t * 0.55, t * 0.45)) * 0.55;
  float flow = n1 + n2;
  float baseR = 0.85;
  float disp = 0.075 * flow
             + 0.020 * uIdle
             + 0.075 * uAmp
             + 0.055 * uFlare;
  vec3 pos = dir * (baseR + disp);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // Pixel-space size — clamped via size attribute and pumped by amp/flare.
  float boost = 1.0 + uAmp * 0.85 + uHover * 0.25 + uFlare * 1.1;
  gl_PointSize = size * 280.0 * boost / -mv.z;
  // Particles in displacement ridges (high |flow|) glow brighter.
  vGlow = 0.45 + 0.55 * abs(flow);
  vSeed = seed;
}
`;

const DENSE_SHELL_FRAG = `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uTime;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
uniform float uShellBoot;
varying float vGlow;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float falloff = smoothstep(0.5, 0.0, d);
  // Per-particle twinkle: each particle has its own phase via seed.
  float twinkle = 0.65 + 0.35 * sin(uTime * 2.4 + vSeed * 17.7);
  // Color: deeper cyan in valleys, brighter cyan in ridges.
  vec3 col = mix(uColorB, uColorA, vGlow);
  // Alpha: pumped by amp + flare, scaled by bootIntensity, twinkle.
  float alpha = falloff
              * (0.50 + vGlow * 0.50)
              * twinkle
              * (0.65 + uAmp * 0.40 + uHover * 0.10 + uFlare * 0.55)
              * uShellBoot;
  gl_FragColor = vec4(col * (0.55 + 0.45 * vGlow), alpha);
}
`;

// ── Plasma shell (mid layer with vertex displacement) ────────────────
// Sits between the bright inner core and the Phong outer shell. Vertex
// shader displaces the sphere surface via flowing simplex noise so the
// mesh ripples; fragment shader paints sharp cyan ridges with truly
// transparent valleys. This is the visible TEXTURE the v5 design
// missed — bright energy strands against see-through gaps revealing
// the glowing core behind.
const PLASMA_VERT = `
uniform float uTime;
uniform float uIdle;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
varying vec3 vNormal;
varying vec3 vViewPos;
varying vec3 vWorldPos;
varying float vFlow;
${SIMPLEX}
void main() {
  // Multi-octave displacement — surface ripples like a plasma fluid.
  // Amp + flare pump amplitude so the shell visibly swells during
  // voice and the climax beat.
  float n1 = snoise(normal * 1.6 + vec3(uTime * 0.32, uTime * 0.18, 0.0));
  float n2 = snoise(normal * 3.1 - vec3(uTime * 0.25, uTime * 0.10, uTime * 0.14)) * 0.55;
  float n3 = snoise(normal * 6.4 + vec3(uTime * 0.40, 0.0, -uTime * 0.20)) * 0.28;
  float flow = n1 + n2 + n3;
  vFlow = flow;
  float disp = 0.035 * flow
             + uIdle * 0.014
             + uAmp * 0.080
             + uFlare * 0.060;
  vec3 pos = position + normal * disp;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = mv.xyz;
  vWorldPos = pos;
  gl_Position = projectionMatrix * mv;
}
`;

const ORB_FRAG = `
uniform float uTime;
uniform float uIdle;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec3 vNormal;
varying vec3 vViewPos;
varying vec3 vWorldPos;
varying float vFlow;
${SIMPLEX}
void main() {
  vec3 viewDir = normalize(-vViewPos);
  float dotN = max(dot(viewDir, vNormal), 0.0);

  // ── Plasma flow — three octaves of simplex sampled in world space.
  // Different scales + time offsets give organic, non-repeating motion.
  float t = uTime;
  float n1 = snoise(vWorldPos * 1.4 + vec3(t * 0.22, t * 0.14, 0.0));
  float n2 = snoise(vWorldPos * 2.7 + vec3(-t * 0.18, t * 0.26, t * 0.10)) * 0.55;
  float n3 = snoise(vWorldPos * 5.2 + vec3(t * 0.34, 0.0, -t * 0.20)) * 0.30;
  float plasma = (n1 + n2 + n3) * 0.5 + 0.5;

  // SHARP ridges — bright cyan strands that read as flowing energy.
  // Tight smoothstep so the ridges are narrow and the valleys go
  // genuinely dim. This is what gives the orb visible texture.
  float ridges = smoothstep(0.52, 0.80, plasma);
  float deepRidges = smoothstep(0.72, 0.92, plasma);

  // High-frequency surface detail — fine scale-like grain overlaid on
  // the slow plasma flow. Adds the "energy mesh" texture you can read
  // on screen instead of a smooth gradient.
  float detail = snoise(vWorldPos * 18.0 + vec3(t * 0.15, 0.0, 0.0));
  detail = smoothstep(0.10, 0.55, detail * 0.5 + 0.5);

  // Fresnel — bright cyan rim band.
  float fresnel = pow(1.0 - dotN, 1.7);

  // FAINT inner glow only — was 0.50+0.18 baseline which killed all
  // contrast and made the orb a uniform cyan ball. Now 0.06 so the
  // valleys can actually go dark. The center glow is supplied by
  // the inner-core ShaderMaterial behind this layer.
  float inner = pow(dotN, 1.4) * 0.06;

  // Compose — bright ridges dominate; baseline tiny so valleys read
  // as dark transparent gaps revealing the inner core.
  vec3 col = uColorA * inner
           + uColorA * ridges     * (0.95 + uAmp * 0.70 + uHover * 0.30 + uFlare * 1.40)
           + uColorA * deepRidges * (0.50 + uFlare * 0.70)
           + uColorB * detail     * 0.20
           + uColorA * fresnel    * (0.55 + uAmp * 0.60 + uHover * 0.30 + uFlare * 1.20);

  // Alpha — valleys nearly transparent so the inner-core glow + dark
  // background show through; ridges visible; rim sharp. The depth
  // read comes from this alpha contrast, not from color shift.
  float alpha = inner * 0.55
              + ridges * 0.50
              + deepRidges * 0.18
              + detail * 0.06
              + fresnel * 0.55
              + uAmp * 0.05
              + uFlare * 0.10;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// ── Inner luminous core shader ───────────────────────────────────────
// Soft cyan glow centered on the camera-facing point. Replaces the
// previous solid MeshBasicMaterial sphere. dotN-driven falloff makes
// the center brightest and the edges fade — reads as a glowing energy
// source seen through the semi-transparent plasma orb in front of it.
const CORE_VERT = `
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const CORE_FRAG = `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uIdle;
uniform float uAmp;
uniform float uFlare;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec3 viewDir = normalize(-vViewPos);
  float dotN = max(dot(viewDir, vNormal), 0.0);
  // Center bright, edges fade. pow(dotN, 1.2) gives a soft Gaussian.
  float falloff = pow(dotN, 1.2);
  // Brightness pump from shared uniforms — synced to GSAP timeline
  // via bigFlare() and to TTS amplitude via setAmplitude().
  float pump = 0.78 + uIdle * 0.22 + uAmp * 0.42 + uFlare * 0.85;
  // Two-tone cyan — slightly deeper at the edge of the glow.
  vec3 col = mix(uColorB, uColorA, falloff) * falloff * pump * 1.35;
  gl_FragColor = vec4(col, falloff * pump * 0.72);
}
`;

// ── Outer glass refraction shell ─────────────────────────────────────
// Two-band fresnel: hairline outer rim + softer inner band. Hairline at
// idle, blooms on amp / hover / flare. Sells the glass-dome feel.
const SHELL_VERT = `
uniform float uTime;
uniform float uIdle;
varying vec3 vNormal;
varying vec3 vViewPos;
${SIMPLEX}
void main() {
  float n = snoise(normal * 0.8 + vec3(uTime * 0.10));
  vec3 pos = position + normal * (0.012 * n + uIdle * 0.008);
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAG = `
uniform vec3 uColorA;
uniform float uIdle;
uniform float uHover;
uniform float uFlare;
uniform float uAmp;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec3 viewDir = normalize(-vViewPos);
  float dotN = max(dot(viewDir, vNormal), 0.0);
  float rimHard = pow(1.0 - dotN, 6.0);
  float rimSoft = pow(1.0 - dotN, 2.6) * 0.14;
  float intensity = (rimHard * 1.5 + rimSoft)
                  * (1.0 + uHover * 0.40 + uFlare * 1.30 + uAmp * 0.25);
  intensity *= 0.85 + uIdle * 0.30;
  // Pure cyan only — uColorA has R=0 so additive stacking with the
  // plasma orb + inner core can never push the rim toward white.
  gl_FragColor = vec4(uColorA * intensity, clamp(intensity * 0.42, 0.0, 1.0));
}
`;

// ── Holographic rings ────────────────────────────────────────────────
// One shader, three patterns (uPattern: 0=solid, 1=dashed, 2=segmented).
// Two traveling sparks (forward + counter) circle the ring. uRingAlpha
// per-instance opacity so the hairline ring sits behind the others.
const RING_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = `
uniform float uTime;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
uniform int   uPattern;
uniform vec3  uRingColor;
uniform float uRingAlpha;
varying vec2 vUv;
void main() {
  float along = vUv.x;
  float across = vUv.y;

  // Tube edge softness — center of tube is brightest.
  float tube = 1.0 - smoothstep(0.40, 0.50, abs(across - 0.5));

  float pat;
  if (uPattern == 0) {
    pat = 1.0;
  } else if (uPattern == 1) {
    float k = fract(along * 96.0 + uTime * 0.10);
    pat = step(0.50, k);
  } else {
    float k = fract(along * 8.0 + uTime * 0.04);
    pat = smoothstep(0.50, 0.60, k) * (1.0 - smoothstep(0.85, 0.95, k));
  }

  // Forward + counter-traveling sparks.
  float pulsePos = fract(uTime * 0.18);
  float pulse = smoothstep(0.05, 0.0, abs(along - pulsePos));
  float pulse2Pos = fract(-uTime * 0.11 + 0.42);
  float pulse2 = smoothstep(0.04, 0.0, abs(along - pulse2Pos)) * 0.55;

  // Base ring intensity — cyan band + cyan sparks.
  float baseIntensity = (pat * 0.95 + pulse2) * tube;
  baseIntensity *= 1.0 + uAmp * 0.6 + uHover * 0.3 + uFlare * 1.6;

  // Orange climax accent — ONLY during the bigFlare climax (uFlare > 0.6).
  // The leading spark turns orange while the rest of the ring stays
  // cyan. Smoothstep gates it cleanly so normal idle / hover stays
  // pure cyan. The accent rides only on the forward pulse so it
  // reads as a hot streak of energy circling the ring.
  float climaxGate = smoothstep(0.55, 1.0, uFlare);
  vec3 accent = vec3(1.0, 0.58, 0.10);
  vec3 sparkColor = mix(uRingColor, accent, climaxGate * 0.75);
  vec3 sparkLight = sparkColor * pulse * 1.45 * tube
                  * (1.0 + uAmp * 0.5 + uFlare * 1.4);

  vec3 col = uRingColor * baseIntensity + sparkLight;
  float alpha = (baseIntensity + pulse * tube * 1.45 * (1.0 + uFlare * 1.4)) * uRingAlpha;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// ── Particle cloud ───────────────────────────────────────────────────
const PARTICLE_VERT = `
uniform float uTime;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
attribute float size;
attribute float seed;
varying float vAlpha;
varying float vSeed;
void main() {
  vec3 p = position;
  float r = length(p);
  // Outward swell on amp/flare + soft wobble per-particle
  float wobble = 1.0 + uAmp * 0.20 + uFlare * 0.16
               + 0.03 * sin(uTime * 1.2 + seed * 6.28 + r * 4.0);
  p *= wobble;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * 280.0 * (1.0 + uAmp * 0.7 + uHover * 0.2 + uFlare * 0.6) / -mv.z;
  vAlpha = 0.5 + 0.5 * sin(uTime * 0.6 + seed * 12.0 + r * 3.0);
  vSeed = seed;
}
`;

const PARTICLE_FRAG = `
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float falloff = smoothstep(0.5, 0.0, d);
  // Pure-cyan palette — both ends of the twinkle gradient have R=0
  // so additive particle stacking cannot push toward white. The
  // ~10% "sparkler" is a slightly cooler cyan, not white.
  vec3 cyan  = mix(vec3(0.0, 0.78, 0.96), vec3(0.0, 0.97, 1.0), vAlpha);
  vec3 spark = vec3(0.0, 0.92, 1.0);
  vec3 col = mix(cyan, spark, step(0.9, vSeed));
  gl_FragColor = vec4(col, falloff * (0.42 + vAlpha * 0.50));
}
`;

// ── JARVIS title backdrop (dark vignette behind the text) ────────────
// Renders just behind the text plate with NORMAL alpha blending so it
// DIMS the orb particles in that area — letting the bright cyan text
// pop against a darkened patch instead of blending in. Elliptical
// alpha falloff via vUv gives soft premium edges, not a rectangle.
const BACKDROP_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BACKDROP_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  // Elliptical vignette — wider than tall to match the title plate.
  vec2 c = vUv - 0.5;
  float d = length(vec2(c.x * 0.62, c.y * 1.55));
  float alpha = 1.0 - smoothstep(0.32, 0.50, d);
  gl_FragColor = vec4(uColor, alpha * uOpacity);
}
`;

// ── JARVIS title plate shaders ───────────────────────────────────────
// The TEXT_FRAG samples a baked canvas texture where R holds the sharp
// letter mask and G holds a soft outer halo. Adds cyan emission,
// fine scanlines, a downward-sweeping bar every ~3.5s, and a rare
// micro-glitch slice for the holographic feel. Pulse scales with the
// shared idle / amp / hover / flare uniforms so the title breathes
// with the orb and punches at the GSAP boot climax.
const TEXT_VERT = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const TEXT_FRAG = `
uniform sampler2D uTex;
uniform float uTime;
uniform float uIdle;
uniform float uAmp;
uniform float uHover;
uniform float uFlare;
uniform float uFade;
uniform vec3 uColorA;        // cyan — letters AND dots, unified body
uniform vec3 uColorB;        // deeper cyan — halo
uniform vec3 uColorAccent;   // orange — far outer halo edge ONLY (very subtle)
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec4 tex = texture2D(uTex, vUv);
  float sharp = tex.r;
  float halo  = tex.g;

  if (max(sharp, halo) < 0.005) discard;

  // ── Vertical 3D depth gradient ──
  // Top of the plate slightly brighter than the bottom — gives the
  // letters a tasteful chromed / embossed feel without breaking the
  // cyan palette. Stays in the cyan family so additive stacking
  // onto the orb can never push toward white.
  float yGrad = vUv.y;
  vec3 bodyColor = uColorA * (0.82 + 0.36 * yGrad);

  // Holographic scanline — fine, never fully dark.
  float scan = 0.86 + 0.14 * sin(vUv.y * 260.0);

  // Sweep bar — cyan shimmer drifting down ~every 3.5s.
  float sweepPos = fract(uTime * 0.28);
  float sweep = smoothstep(0.025, 0.000, abs(vUv.y - sweepPos));

  // Rare micro-glitch — single-frame blip on a thin slice.
  float glitchSeed = fract(sin(floor(uTime * 1.5) * 12.9898) * 43758.5453);
  float glitchActive = step(0.94, glitchSeed);
  float glitchBand = step(0.5, sin(vUv.y * 600.0 + glitchSeed * 100.0));
  float glitch = glitchActive * glitchBand * 0.18;

  // Curvature lighting — the plate is bent on its x-axis. Boost
  // central readability against the orb behind it.
  vec3 viewDir = normalize(-vViewPos);
  float face = max(dot(viewDir, vNormal), 0.0);
  float curveBoost = 0.82 + 0.18 * face;

  // Breathing brightness — gentle idle, amp/hover bumps, flare punch.
  float pulse = 1.0 + uIdle * 0.10 + uAmp * 0.32 + uHover * 0.16 + uFlare * 1.10;

  // ── Compose ── all glyphs (letters AND periods) share the same
  // cyan body + gradient. No color mismatch on the dots.
  vec3 col = bodyColor * sharp * curveBoost * scan
           + uColorB   * halo  * 0.28;

  // Optional: extremely thin orange tint at the FAR outer halo edge
  // ONLY — i.e. where the sharp mask is fully zero AND the halo is in
  // its outermost faint region. Never touches letters or dots. Reads
  // as a barely-perceptible Stark accent at the silhouette boundary.
  float outerEdge = (1.0 - smoothstep(0.0, 0.05, sharp))     // outside letter pixels
                  * smoothstep(0.02, 0.16, halo)             // in faint halo
                  * (1.0 - smoothstep(0.30, 0.55, halo));    // but not too deep
  col += uColorAccent * outerEdge * 0.18;

  col *= pulse;
  col += bodyColor * sweep * sharp * 1.10;
  col += bodyColor * glitch * sharp * 0.55;

  float alpha = clamp(sharp * curveBoost + halo * 0.45, 0.0, 1.0) * pulse * uFade;
  gl_FragColor = vec4(col * uFade, clamp(alpha, 0.0, 1.0));
}
`;
