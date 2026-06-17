// Faceless-lane narration (E3).
//
// ElevenLabs voices the FINAL cut (Gabe's key, TTS-only scope — voices_read /
// user_read are blocked by design, so the narrator voice is set by ID, not
// discovered). Drafts/QC iterations should use the free local voice once
// Kokoro lands; every ElevenLabs call here costs real credits (~1/char).
//
// Caption sync: whisper re-times the synthesized audio word-by-word, so the
// documentary composition gets the same word-timing contract as caption clips.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'narrator', ...extra }, msg);

const EL_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const WHISPER_URL = 'http://127.0.0.1:3147';

// "Daniel": deep, authoritative broadcast premade — solid documentary default.
// Override per call or via ELEVENLABS_VOICE_ID in .env (e.g. a VoiceLab id
// from Gabe's account, which the API key can use but not list).
export const DEFAULT_NARRATOR_VOICE = 'onwK4e9ZLuTAKqWW03F9';

export interface Word { start: number; end: number; word: string }

export interface NarrationResult {
  audioFile: string;   // absolute path to the mp3
  words: Word[];
  durationS: number;
  characters: number;  // billed characters (honest cost visibility)
}

function ffmpeg(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args);
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.slice(-2000) }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
  });
}

/**
 * Synthesize narration into outDir/narration.mp3 and return word timings.
 * Throws with an honest message on missing key, quota, or whisper failure.
 */
export async function synthesizeNarration(
  text: string,
  outDir: string,
  opts: { voiceId?: string; modelId?: string } = {},
): Promise<NarrationResult> {
  const cleaned = text.trim();
  if (!cleaned) throw new Error('narration text is empty');
  if (cleaned.length > 9_500) throw new Error(`narration too long for one call (${cleaned.length} chars; split the script)`);

  const env = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
  const apiKey = env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
  const voiceId = opts.voiceId || env.ELEVENLABS_VOICE_ID || DEFAULT_NARRATOR_VOICE;

  const res = await fetch(`${EL_TTS_URL}/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: cleaned,
      model_id: opts.modelId ?? 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.35 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`elevenlabs ${res.status}: ${body.slice(0, 250)}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const audioFile = path.join(outDir, 'narration.mp3');
  fs.writeFileSync(audioFile, Buffer.from(await res.arrayBuffer()));

  // Whisper re-times the actual audio so captions sync to what was SAID,
  // not to what the script hoped.
  const wav = path.join(os.tmpdir(), `narr-${Date.now() % 1e7}.wav`);
  try {
    const ff = await ffmpeg(['-y', '-loglevel', 'error', '-i', audioFile, '-ar', '16000', '-ac', '1', wav]);
    if (ff.code !== 0) throw new Error(`audio convert failed: ${ff.out.slice(0, 200)}`);
    const wres = await fetch(`${WHISPER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: wav, words: true }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    const data = await wres.json() as { ok: boolean; error?: string; duration_s?: number; segments?: Array<{ words?: Word[] }> };
    if (!data.ok) throw new Error(`whisper retime failed: ${data.error ?? 'unknown'}`);
    const words = (data.segments ?? []).flatMap((s) => s.words ?? []);
    log('narration ready', { chars: cleaned.length, durationS: data.duration_s, words: words.length, voice: voiceId });
    return { audioFile, words, durationS: data.duration_s ?? 0, characters: cleaned.length };
  } finally {
    try { fs.unlinkSync(wav); } catch { /* tmp */ }
  }
}
