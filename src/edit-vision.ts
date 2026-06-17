// The editor's eyes (Edit Bay).
//
// Every demo before this was rendered BLIND — plans written without looking
// at the footage, which is exactly how captions ended up on top of a video's
// own captions twice. This module samples frames and runs the local vision
// model (qwen3-vl on the 5080, free) so the pipeline KNOWS, before rendering:
//   - does the source already have burned-in captions? (then we NEVER add ours)
//   - where is on-screen text / the speaker? (overlays go in empty zones only)
//
// Self-contained Ollama vision client: the shared ollamaChat ChatMessage has
// no images field, and eye's delegate path is text-only.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveOllamaBaseUrl } from './ollama.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'edit-vision', ...extra }, msg);

const VISION_MODEL = 'qwen3-vl:8b';
const FRAMES_PER_VIDEO = 5;

export type Zone = 'top' | 'upper-middle' | 'middle' | 'lower-middle' | 'bottom';

export interface FrameReport {
  has_burned_captions: boolean;
  text_zones: Zone[];      // zones containing ANY on-screen text/graphics
  speaker_zone: Zone | null;
  notes: string;
}

export interface MaterialReport {
  framesAnalyzed: number;
  hasBurnedCaptions: boolean;    // true if detected in >= 2 frames (or 1 of 1)
  occupiedZones: Zone[];         // union of text + speaker zones across frames
  safeCaptionY: number | null;   // 0..1 anchor in a free zone; null = NO safe zone
  frameNotes: string[];
}

const ZONE_Y: Record<Zone, number> = {
  top: 0.06,
  'upper-middle': 0.26,
  middle: 0.46,
  'lower-middle': 0.66,
  bottom: 0.82,
};
// Preference order for captions when free: classic lower placements first.
const CAPTION_ZONE_PREFERENCE: Zone[] = ['lower-middle', 'bottom', 'upper-middle', 'top'];

function ffmpeg(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args);
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.slice(-1500) }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
  });
}

/** Direct Ollama vision call (base64 images on the user message). */
async function ollamaVision(prompt: string, imagePaths: string[]): Promise<string> {
  const images = imagePaths.map((p) => fs.readFileSync(p).toString('base64'));
  const res = await fetch(`${resolveOllamaBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      stream: false,
      think: false,
      messages: [{ role: 'user', content: prompt, images }],
      // qwen3-vl ignores think:false and reasons anyway; the budget must
      // cover the thinking PLUS the final JSON or content comes back empty.
      options: { temperature: 0.1, num_predict: 1400 },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama vision ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json() as { message?: { content?: string; thinking?: string } };
  // Prefer the final answer; fall back to the reasoning text (the JSON often
  // appears there when the model runs out of budget mid-handoff).
  const content = data.message?.content?.trim();
  return content || data.message?.thinking || '';
}

// Last brace-balanced JSON block wins: the model echoes the prompt in its
// reasoning, so a greedy first-match can grab instructions instead of the
// answer. The answer is always the LAST object emitted.
function extractJson<T>(text: string): T | null {
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { candidates.push(text.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try { return JSON.parse(candidates[k]) as T; } catch { /* earlier block */ }
  }
  return null;
}

// Deliberately NO literal JSON example in this prompt: the model echoes the
// prompt while reasoning, and an example object would be indistinguishable
// from the real answer to the extractor.
const FRAME_PROMPT = [
  'You are inspecting ONE video frame for an automated video editor. Answer with a single JSON object and nothing after it.',
  '',
  'The JSON object must have exactly these keys:',
  '- has_burned_captions: boolean. True only if the frame shows subtitle/caption text, meaning spoken words rendered as text (usually a consistent strip). Logos, channel names, and scene text on physical objects do not count.',
  '- text_zones: array of zone names where ANY readable text or graphic overlays appear (captions, titles, tickers, text boxes, watermarks bigger than a small corner mark). Valid zone names: top, upper-middle, middle, lower-middle, bottom.',
  '- speaker_zone: the zone holding the face of the person who is the visual subject, or null if none.',
  '- notes: one short sentence describing what the frame shows.',
].join('\n');

// Deliberately schema-in-words (same echo reason as FRAME_PROMPT).
const QC_PROMPT = [
  'You are the quality-control inspector for an automated video editor, checking ONE frame of a FINISHED render before it is delivered. Answer with a single JSON object and nothing after it.',
  '',
  'The JSON object must have exactly these keys:',
  '- double_captions: boolean. True if TWO different caption/subtitle systems are visible at once (e.g. our caption strip rendered on top of captions that were already part of the footage).',
  '- text_collision: boolean. True if any text overlaps other text or sits on top of important content (a face, a graphic, on-screen writing).',
  '- unreadable_text: boolean. True if any text is hard to read (blends into the background, cut off, too small).',
  '- issues: array of short strings, one per problem you see (empty array if the frame looks clean and professional).',
].join('\n');

export interface QcReport { passed: boolean; issues: string[]; framesChecked: number }

/**
 * Inspect a RENDERED output before delivery: the no-slop gate. Samples frames
 * and fails the render on any rule violation the vision model can see.
 */
export async function qcCheck(videoPath: string, durationS: number): Promise<QcReport> {
  if (!fs.existsSync(videoPath)) throw new Error(`output not found: ${videoPath}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-qc-'));
  try {
    const n = 4;
    const stamps = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * Math.max(durationS, 2));
    const issues: string[] = [];
    let checked = 0;
    for (const [i, ts] of stamps.entries()) {
      const fp = path.join(tmpDir, `q${i}.jpg`);
      const r = await ffmpeg(['-y', '-loglevel', 'error', '-ss', ts.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=720:-1', fp]);
      if (r.code !== 0 || !fs.existsSync(fp)) continue;
      try {
        const raw = await ollamaVision(QC_PROMPT, [fp]);
        const rep = extractJson<{ double_captions?: boolean; text_collision?: boolean; unreadable_text?: boolean; issues?: string[] }>(raw);
        if (!rep) continue;
        checked++;
        const at = `@${ts.toFixed(0)}s`;
        if (rep.double_captions) issues.push(`${at}: double captions`);
        if (rep.text_collision) issues.push(`${at}: text overlapping text/content`);
        if (rep.unreadable_text) issues.push(`${at}: unreadable text`);
        for (const msg of (rep.issues ?? []).slice(0, 3)) {
          if (typeof msg === 'string' && msg.trim()) issues.push(`${at}: ${msg.slice(0, 120)}`);
        }
      } catch (err) {
        log('qc frame failed (skipping)', { err: String(err).slice(0, 120) });
      }
    }
    if (checked === 0) throw new Error('QC could not inspect any output frames');
    const report = { passed: issues.length === 0, issues: [...new Set(issues)].slice(0, 12), framesChecked: checked };
    log('qc report', { video: path.basename(videoPath), ...report });
    return report;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/**
 * Sample frames from a video and build the material report the editor needs.
 * Honest failure: throws on extraction/vision errors — callers decide whether
 * to block (captioning MUST know) or proceed labeled-unknown.
 */
export async function analyzeVideo(videoPath: string, durationS?: number): Promise<MaterialReport> {
  if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-vision-'));
  try {
    // Evenly sample frames across the video (skip the very start/end).
    const dur = durationS && durationS > 2 ? durationS : 30;
    const stamps = Array.from({ length: FRAMES_PER_VIDEO }, (_, i) => ((i + 0.5) / FRAMES_PER_VIDEO) * dur);
    const framePaths: string[] = [];
    for (const [i, ts] of stamps.entries()) {
      const out = path.join(tmpDir, `f${i}.jpg`);
      const r = await ffmpeg(['-y', '-loglevel', 'error', '-ss', ts.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=720:-1', out]);
      if (r.code === 0 && fs.existsSync(out)) framePaths.push(out);
    }
    if (framePaths.length === 0) throw new Error('could not extract any frames');

    // One vision call per frame: small model, focused question, stable JSON.
    const reports: FrameReport[] = [];
    const notes: string[] = [];
    for (const fp of framePaths) {
      try {
        const raw = await ollamaVision(FRAME_PROMPT, [fp]);
        const rep = extractJson<FrameReport>(raw);
        if (rep && typeof rep.has_burned_captions === 'boolean') {
          reports.push({
            has_burned_captions: rep.has_burned_captions,
            text_zones: Array.isArray(rep.text_zones) ? rep.text_zones.filter((z): z is Zone => z in ZONE_Y) : [],
            speaker_zone: rep.speaker_zone && rep.speaker_zone in ZONE_Y ? rep.speaker_zone : null,
            notes: String(rep.notes ?? '').slice(0, 200),
          });
          notes.push(reports[reports.length - 1].notes);
        }
      } catch (err) {
        log('frame analysis failed (skipping frame)', { err: String(err).slice(0, 120) });
      }
    }
    if (reports.length === 0) throw new Error('vision analysis produced no usable frame reports');

    const captionVotes = reports.filter((r) => r.has_burned_captions).length;
    const hasBurnedCaptions = reports.length === 1 ? captionVotes === 1 : captionVotes >= 2;
    const occupied = new Set<Zone>();
    for (const r of reports) {
      r.text_zones.forEach((z) => occupied.add(z));
      if (r.speaker_zone) occupied.add(r.speaker_zone);
    }
    const freeZone = CAPTION_ZONE_PREFERENCE.find((z) => !occupied.has(z)) ?? null;

    const report: MaterialReport = {
      framesAnalyzed: reports.length,
      hasBurnedCaptions,
      occupiedZones: [...occupied],
      safeCaptionY: freeZone ? ZONE_Y[freeZone] : null,
      frameNotes: notes,
    };
    log('material report', { video: path.basename(videoPath), ...report, frameNotes: undefined });
    return report;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}
