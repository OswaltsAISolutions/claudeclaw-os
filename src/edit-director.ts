// The Director (Edit Bay L2): turns a creative brief + source material into a
// validated edit plan for the Timeline engine.
//
// Discipline that makes it an editor instead of a slop machine:
//   1. It LOOKS first — every source gets a vision MaterialReport + transcript
//      before a single cut is planned.
//   2. The model proposes; CODE disposes — segment timing is computed here
//      (models botch arithmetic), captions/overlays are legality-checked
//      against the vision reports, and anything unsafe is stripped or the
//      plan is rejected with an honest reason.
//   3. Captions only when NO used source has burned captions and a zone is
//      verifiably empty across all sources (Gabe's standing rules).

import fs from 'node:fs';
import path from 'node:path';

import { getLibraryItem, type LibraryItem } from './db.js';
import { analyzeVideo, type MaterialReport, type Zone } from './edit-vision.js';
import { delegate } from './specialists.js';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'director', ...extra }, msg);

// ── Server-side mirror of the Timeline plan (video/ has its own tsconfig) ──

export interface PlanWord { start: number; end: number; word: string }
export interface PlanSegment {
  src: string; startS: number; durS: number; inS?: number;
  fit?: 'cover' | 'contain' | 'blur-fill';
  kenBurns?: { from: number; to: number };
  transition?: 'cut' | 'fade'; transitionS?: number; volume?: number;
}
export interface PlanOverlay {
  kind: 'title' | 'card' | 'lower-third' | 'image';
  text?: string; sub?: string; src?: string; startS: number; durS: number; y?: number;
}
export interface PlanAudio {
  src: string; startS: number; inS?: number; durS?: number; volume?: number;
  fadeInS?: number; fadeOutS?: number; duckUnderSpeech?: boolean;
}
export interface TimelinePlan {
  aspect: '9:16' | '16:9' | '1:1';
  durationS: number;
  background?: string;
  video: PlanSegment[];
  overlays?: PlanOverlay[];
  audio?: PlanAudio[];
  captions?: { words: PlanWord[]; y?: number; accent?: string } | null;
}

// ── Director input/output ───────────────────────────────────────────────

export interface DirectorInput {
  itemIds: string[];
  brief: string;               // Gabe's direction, verbatim
  aspect: '9:16' | '16:9' | '1:1';
  targetDurationS?: number;    // soft target; narration can stretch it
  allowNarration?: boolean;    // brief may call for narration; this is the budget switch
  materials?: SourceMaterial[]; // pre-gathered reports (revise loop: vision runs once, not per round)
  revision?: DirectorRevision; // QC verdict from a failed render of a previous plan
}

export interface DirectorRevision {
  issues: string[];            // QC inspector findings on the finished frames
  previousSummary?: string;    // what the failed plan did (overlays/captions), so it isn't repeated
}

export interface SourceMaterial {
  item: LibraryItem;
  file: string;                // absolute path
  report: MaterialReport;
  durationS: number;
}

export interface DirectorResult {
  ok: boolean;
  error?: string;
  plan?: TimelinePlan;         // segments use ABSOLUTE source paths in src (worker stages + rewrites)
  sourceFiles?: Record<string, string>; // plan src token -> absolute path
  narrationText?: string | null;
  captionsWanted?: boolean;
  safeCaptionY?: number | null;
  notes?: string;
}

// Model-facing draft shape (sequential segments; code computes positions).
interface DraftSegment { item?: string; inS?: number; durS?: number; transition?: string; fit?: string; kenBurnsTo?: number; keepSourceAudio?: boolean }
interface DraftOverlay { kind?: string; text?: string; sub?: string; atS?: number; durS?: number }
interface DraftPlan {
  segments?: DraftSegment[];
  overlays?: DraftOverlay[];
  narrationText?: string | null;
  captionsWanted?: boolean;
  notes?: string;
}

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
    try { return JSON.parse(candidates[k]) as T; } catch { /* earlier */ }
  }
  return null;
}

/** Gather + analyze the source material the director will plan with. */
export async function gatherMaterials(itemIds: string[]): Promise<SourceMaterial[]> {
  const out: SourceMaterial[] = [];
  for (const id of itemIds) {
    const item = getLibraryItem(id);
    if (!item || !item.media_file || item.media_type !== 'video') {
      throw new Error(`source ${id} has no video media`);
    }
    const file = path.join(STORE_DIR, 'library', item.id, item.media_file);
    if (!fs.existsSync(file)) throw new Error(`source ${id} media file missing`);
    const durationS = item.duration_s ?? 30;
    const report = await analyzeVideo(file, durationS);
    out.push({ item, file, report, durationS });
  }
  return out;
}

function materialBriefing(materials: SourceMaterial[]): string {
  return materials.map((m) => {
    const t = m.item.transcript ? `transcript: ${m.item.transcript.slice(0, 500)}` : 'no speech (music/ambient only)';
    return [
      `SOURCE ${m.item.id} — ${Math.round(m.durationS)}s`,
      `  visual: ${m.report.frameNotes.slice(0, 2).join(' | ').slice(0, 240)}`,
      `  burned-in captions: ${m.report.hasBurnedCaptions ? 'YES' : 'no'} | zones with text/speaker: ${m.report.occupiedZones.join(', ') || 'none'}`,
      `  ${t}`,
    ].join('\n');
  }).join('\n\n');
}

/**
 * Plan an edit. The heavy reasoner (atlas) proposes; this function verifies
 * and resolves into a concrete TimelinePlan or rejects with a reason.
 */
export async function directTimeline(input: DirectorInput): Promise<DirectorResult> {
  let materials: SourceMaterial[];
  try {
    materials = input.materials ?? await gatherMaterials(input.itemIds);
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 250) };
  }

  const anyBurned = materials.some((m) => m.report.hasBurnedCaptions);
  // Caption zone must be free across ALL sources (segments share the frame).
  const occupiedEverywhere = new Set<Zone>(materials.flatMap((m) => m.report.occupiedZones));
  const ZONE_Y: Record<Zone, number> = { top: 0.06, 'upper-middle': 0.26, middle: 0.46, 'lower-middle': 0.66, bottom: 0.82 };
  const freeZone = (['lower-middle', 'bottom', 'upper-middle', 'top'] as Zone[]).find((z) => !occupiedEverywhere.has(z)) ?? null;
  const safeCaptionY = freeZone ? ZONE_Y[freeZone] : null;

  const prompt = [
    'You are the EDITOR for a professional short-video studio. Plan ONE edit from the brief and the analyzed source material below. You decide cuts, order, pacing, overlays, and whether narration/captions serve the brief. Answer with a single JSON object and nothing after it.',
    '',
    `BRIEF (from the creator, follow it exactly): ${input.brief}`,
    `FORMAT: ${input.aspect}, target length ~${input.targetDurationS ?? 25}s.`,
    input.allowNarration ? 'Narration IS available (professional TTS voice) if the brief calls for it.' : 'Do NOT use narration.',
    '',
    'SOURCE MATERIAL (already analyzed — trust these reports):',
    materialBriefing(materials),
    '',
    'HARD RULES (violations get your plan rejected by the validator):',
    `- Captions: ${anyBurned ? 'FORBIDDEN — at least one source already has burned-in captions.' : safeCaptionY === null ? 'FORBIDDEN — no zone is free of text/speaker across all sources.' : 'allowed (set captionsWanted true only if they serve the brief).'}`,
    '- Never place overlays where the source reports text or the speaker.',
    '- A segment must not keep its source audio AND have narration over it at the same time unless the brief says so.',
    '- Segment inS + durS must fit inside the source duration.',
    '- 2-6 segments. Keep cuts purposeful, not frantic.',
    ...(input.revision ? [
      '',
      'REVISION: a previous plan from this same brief rendered, but quality control FAILED the finished video. Issues seen on the output frames:',
      ...input.revision.issues.slice(0, 8).map((i) => `- ${i}`),
      input.revision.previousSummary ? `The failed plan did: ${input.revision.previousSummary}` : '',
      'Produce a CORRECTED plan: move or DROP the offending text overlays, prefer fewer overlays, and if captions collided with content set captionsWanted false. Do not repeat the failed placements.',
    ].filter(Boolean) : []),
    '',
    'The JSON object must have exactly these keys:',
    '- segments: array (plays in order; positions are computed for you). Each: item (source id string), inS (number, where to start in the source), durS (number, seconds to use), transition ("cut" or "fade"), fit ("blur-fill" recommended for vertical), keepSourceAudio (boolean), kenBurnsTo (number, optional slow-zoom end scale like 1.08, omit for none).',
    '- overlays: array (may be empty). Each: kind ("title", "card", or "lower-third"), text (string), sub (string optional), atS (number, when it appears), durS (number).',
    '- narrationText: string of the exact words to be spoken, or null. Write it to be SPOKEN, broadcast-documentary style, and sized to the video length (~2.5 words/second).',
    '- captionsWanted: boolean.',
    '- notes: one line on your editorial intent.',
  ].join('\n');

  let draft: DraftPlan | null = null;
  try {
    const res = await delegate('atlas', prompt, { shareMemory: false, maxTokens: 2200 });
    draft = extractJson<DraftPlan>(res.output);
  } catch (err) {
    return { ok: false, error: `director model failed: ${String(err).slice(0, 200)}` };
  }
  if (!draft || !Array.isArray(draft.segments) || draft.segments.length === 0) {
    return { ok: false, error: 'director produced no usable plan' };
  }

  // ── Validate + resolve (code is the authority) ──
  const byId = new Map(materials.map((m) => [m.item.id, m]));
  const segments: PlanSegment[] = [];
  const sourceFiles: Record<string, string> = {};
  // Which source is on screen when: overlay legality is judged against the
  // segment(s) an overlay actually appears over, not the whole-video union
  // (the union over-drops — source B's lower-third zone shouldn't forbid a
  // title shown only while source A plays).
  const segSpans: Array<{ startS: number; durS: number; mat: SourceMaterial }> = [];
  let cursor = 0;
  for (const s of draft.segments.slice(0, 6)) {
    const mat = s.item ? byId.get(s.item) : undefined;
    if (!mat) return { ok: false, error: `plan references unknown source "${s.item}"` };
    let inS = Math.max(0, Number(s.inS) || 0);
    let durS = Number(s.durS) || 0;
    if (durS < 1) durS = 2;
    if (inS + durS > mat.durationS) {
      // Clamp instead of reject: trim into bounds, keep at least 1s.
      inS = Math.max(0, Math.min(inS, mat.durationS - 1));
      durS = Math.max(1, mat.durationS - inS);
    }
    const token = `SRC_${mat.item.id}`;
    sourceFiles[token] = mat.file;
    segments.push({
      src: token,
      startS: cursor,
      durS: Math.round(durS * 100) / 100,
      inS: Math.round(inS * 100) / 100,
      fit: s.fit === 'cover' || s.fit === 'contain' ? s.fit : 'blur-fill',
      transition: s.transition === 'fade' ? 'fade' : 'cut',
      transitionS: s.transition === 'fade' ? 0.5 : undefined,
      volume: s.keepSourceAudio ? 1 : 0,
      kenBurns: typeof s.kenBurnsTo === 'number' && s.kenBurnsTo > 1 && s.kenBurnsTo < 1.3 ? { from: 1, to: s.kenBurnsTo } : undefined,
    });
    segSpans.push({ startS: cursor, durS, mat });
    cursor += durS;
  }
  const durationS = Math.round(cursor * 100) / 100;

  /** Union of occupied zones across the sources visible during [atS, atS+durS). */
  const zonesDuring = (atS: number, durS: number): Set<Zone> => {
    const occupied = new Set<Zone>();
    for (const span of segSpans) {
      if (span.startS < atS + durS && atS < span.startS + span.durS) {
        span.mat.report.occupiedZones.forEach((z) => occupied.add(z));
      }
    }
    return occupied;
  };

  // Overlays: clamp into the timeline; EVERY text overlay must land in a zone
  // the vision pass verified empty in the segment(s) it appears over, or it
  // gets dropped. (QC refused two renders for centered titles over busy
  // footage — the rule is enforced here, before the render ever happens.)
  const TITLE_ZONE_PREFERENCE: Zone[] = ['upper-middle', 'top', 'middle', 'lower-middle'];
  const TITLE_Y: Record<Zone, number> = { top: 0.06, 'upper-middle': 0.22, middle: 0.42, 'lower-middle': 0.64, bottom: 0.8 };
  const overlays: PlanOverlay[] = [];
  for (const o of (draft.overlays ?? []).slice(0, 5)) {
    if (!o || typeof o.text !== 'string' || !o.text.trim()) continue;
    const kind = o.kind === 'card' ? 'card' : o.kind === 'lower-third' ? 'lower-third' : 'title';
    const atS = Math.max(0, Math.min(Number(o.atS) || 0, Math.max(0, durationS - 1)));
    const durS = Math.max(0.8, Math.min(Number(o.durS) || 2.5, durationS - atS));
    const occupiedHere = zonesDuring(atS, durS);
    if (kind === 'lower-third' && (occupiedHere.has('bottom') || occupiedHere.has('lower-middle'))) {
      log('dropped lower-third (zone occupied during its window)', { text: o.text.slice(0, 40), atS });
      continue;
    }
    const titleZone = kind === 'title' ? TITLE_ZONE_PREFERENCE.find((z) => !occupiedHere.has(z)) ?? null : null;
    if (kind === 'title' && titleZone === null) {
      log('dropped title (no free zone during its window)', { text: o.text.slice(0, 40), atS });
      continue;
    }
    overlays.push({
      kind,
      text: o.text.slice(0, 90),
      sub: typeof o.sub === 'string' ? o.sub.slice(0, 90) : undefined,
      startS: atS,
      durS,
      // Cards dim the whole frame behind their text (safe anywhere);
      // titles must sit in a zone verified empty for THEIR window.
      y: kind === 'title' && titleZone ? TITLE_Y[titleZone] : undefined,
    });
  }

  // Caption legality, recomputed over the sources the cut actually USES
  // (captions span the whole video, so the zone must be free across every
  // used source — but an unused source's zones no longer forbid anything).
  const usedIds = new Set(segSpans.map((s) => s.mat.item.id));
  const usedMaterials = materials.filter((m) => usedIds.has(m.item.id));
  const usedBurned = usedMaterials.some((m) => m.report.hasBurnedCaptions);
  const usedOccupied = new Set<Zone>(usedMaterials.flatMap((m) => m.report.occupiedZones));
  const usedFreeZone = (['lower-middle', 'bottom', 'upper-middle', 'top'] as Zone[]).find((z) => !usedOccupied.has(z)) ?? null;
  const finalSafeCaptionY = usedFreeZone ? ZONE_Y[usedFreeZone] : null;
  const captionsLegal = !usedBurned && finalSafeCaptionY !== null;
  const captionsWanted = !!draft.captionsWanted && captionsLegal;
  const narrationText = input.allowNarration && typeof draft.narrationText === 'string' && draft.narrationText.trim().length > 0
    ? draft.narrationText.trim().slice(0, 4000)
    : null;

  const plan: TimelinePlan = {
    aspect: input.aspect,
    durationS,
    video: segments,
    overlays,
    audio: [], // narration/music tracks are attached by the worker (it owns synthesis + timing)
    captions: null, // worker attaches words after narration synth (or source words)
  };

  log('plan ready', { segments: segments.length, overlays: overlays.length, durationS, narration: !!narrationText, captionsWanted, revision: !!input.revision, notes: (draft.notes ?? '').slice(0, 80) });
  return { ok: true, plan, sourceFiles, narrationText, captionsWanted, safeCaptionY: finalSafeCaptionY, notes: draft.notes?.slice(0, 200) };
}
