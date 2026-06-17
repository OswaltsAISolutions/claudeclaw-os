// NCI Engineered Reality Scoring System (Psyop Scoring lane).
//
// Chase Hughes' 20-item "Narrative Credibility Index" — how probably is a
// claim/article/event an engineered narrative (psyop)? Verbatim instrument in
// docs/psyop-nci/NCI-SCORING-SYSTEM.md (PSYOPS Identification Tool V8.3,
// © Applied Behavior Research 2024). The 20 categories are FIXED; never invent
// or "improve" them.
//
// Two-pass by Gabe's design (2026-06-13): a LOCAL abliterated model scores first
// (free, uncensored — it will not refuse to flag a government/corporate
// narrative), then a CLOUD model VERIFIES and finalizes each of the 20 scores.
// The cloud pass is authoritative. It scores manipulation FORM, not truth: a
// high score means the narrative is engineered, not that its claim is false.

import { delegate } from './specialists.js';
import { recordLegUsage } from './usage-ledger.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'psyop', ...extra }, msg);

export interface NciCategory { id: number; category: string; question: string; example: string }

// Verbatim from docs/psyop-nci/NCI-SCORING-SYSTEM.md (the official V8.3 sheet).
export const NCI_CATEGORIES: NciCategory[] = [
  { id: 1, category: 'Timing', question: 'Does the timing feel suspicious or coincidental with other events?', example: 'A story about water contamination surfaces during a corporate scandal.' },
  { id: 2, category: 'Emotional Manipulation', question: 'Does it provoke fear, outrage, or guilt without solid evidence?', example: 'Reports show crying children and dying wildlife but avoid causes.' },
  { id: 3, category: 'Uniform Messaging', question: 'Are key phrases or ideas repeated across media?', example: 'All outlets use terms like "unprecedented" and "avoidable tragedy."' },
  { id: 4, category: 'Missing Information', question: 'Are alternative views or critical details excluded?', example: 'Few sources discuss the timeline or other possible contributors.' },
  { id: 5, category: 'Simplistic Narratives', question: 'Is the story reduced to "good vs. evil" frameworks?', example: 'Blames one company entirely while ignoring systemic issues.' },
  { id: 6, category: 'Tribal Division', question: 'Does it create an "us vs. them" dynamic?', example: 'Locals are victims, while outsiders are blamed.' },
  { id: 7, category: 'Authority Overload', question: 'Are questionable "experts" driving the narrative?', example: 'Non-environmental experts dominate airtime to support policies.' },
  { id: 8, category: 'Call for Urgent Action', question: 'Does it demand immediate decisions without reflection?', example: 'Campaigns push for immediate donations and rapid policy changes.' },
  { id: 9, category: 'Overuse of Novelty', question: 'Is the event framed as shocking or unprecedented?', example: 'Media emphasizes how "shocking" and "once-in-a-lifetime" the crisis is.' },
  { id: 10, category: 'Financial/Political Gain', question: 'Do powerful groups benefit disproportionately?', example: 'A company offering cleanup services lobbies for government contracts.' },
  { id: 11, category: 'Suppression of Dissent', question: 'Are critics silenced or labeled negatively?', example: 'Opponents dismissed as "deniers" or ignored.' },
  { id: 12, category: 'False Dilemmas', question: 'Are only two extreme options presented?', example: '"Either you support this policy, or you don\'t care about the environment."' },
  { id: 13, category: 'Bandwagon Effect', question: 'Is there pressure to conform because "everyone is doing it"?', example: 'Social media influencers post identical hashtags, urging followers to join in.' },
  { id: 14, category: 'Emotional Repetition', question: 'Are the same emotional triggers repeated excessively?', example: 'Destruction and suffering imagery looped endlessly on TV and online.' },
  { id: 15, category: 'Cherry-Picked Data', question: 'Are statistics presented selectively or out of context?', example: 'Dramatic figures shared without explaining how they were calculated.' },
  { id: 16, category: 'Logical Fallacies', question: 'Are flawed arguments used to dismiss critics?', example: 'Critics labeled "out-of-touch elites" without addressing their points.' },
  { id: 17, category: 'Manufactured Outrage', question: 'Does outrage seem sudden or disconnected from facts?', example: 'Viral memes escalate anger quickly with little context provided.' },
  { id: 18, category: 'Framing Techniques', question: 'Is the story shaped to control how you perceive it?', example: 'The crisis is framed as entirely preventable, ignoring systemic factors.' },
  { id: 19, category: 'Rapid Behavior Shifts', question: 'Are groups adopting symbols or actions without clear reasoning?', example: 'Social media suddenly fills with users adding water droplet emojis to their profiles.' },
  { id: 20, category: 'Historical Parallels', question: 'Does the story mirror manipulative past events?', example: 'Past environmental crises were similarly used to pass sweeping, controversial legislation.' },
];

export type PsyopBand = 'low' | 'moderate' | 'strong' | 'overwhelming';

export interface PsyopItemScore { id: number; category: string; score: number; evidence: string }

export interface PsyopScoreResult {
  subject: string;
  items: PsyopItemScore[];
  total: number;                 // 20-100
  band: PsyopBand;
  bandLabel: string;
  truthAgendaNote: string | null; // host's "psyop built on truth" caveat for the mid band
  localModel: string | null;
  verifyModel: string | null;
  disclaimer: string;
}

const DISCLAIMER =
  'This scores manipulation FORM, not truth. A high score means the narrative is being engineered, ' +
  'not that its underlying claim is false; a low score does not make a claim true.';

// Official V8.3 bands (the printed instrument governs; the video host paraphrased
// different thresholds on-air — see NCI-SCORING-SYSTEM.md).
export function bandFor(total: number): { band: PsyopBand; label: string } {
  if (total <= 25) return { band: 'low', label: 'Low likelihood of a PSYOP' };
  if (total <= 50) return { band: 'moderate', label: 'Moderate likelihood — look deeper' };
  if (total <= 75) return { band: 'strong', label: 'Strong likelihood — manipulation likely' };
  return { band: 'overwhelming', label: 'Overwhelming signs of a PSYOP' };
}

// Last brace-balanced JSON block wins (abliterated + cloud models both echo the
// prompt while reasoning; the real answer is the final object emitted).
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

interface RawItem { id?: number; score?: number; evidence?: string }
interface RawScore { items?: RawItem[] }

// Coerce a raw model object into a clean, complete 20-item array. Any item the
// model omitted or mis-scored defaults to 1 (Not Present) — an unjustified high
// score is the failure mode that makes this worthless, so we never fabricate up.
function normalizeItems(raw: RawScore | null): PsyopItemScore[] {
  const byId = new Map<number, RawItem>();
  for (const it of raw?.items ?? []) {
    if (it && typeof it.id === 'number') byId.set(it.id, it);
  }
  return NCI_CATEGORIES.map((cat) => {
    const r = byId.get(cat.id);
    let score = Math.round(Number(r?.score));
    if (!Number.isFinite(score) || score < 1) score = 1;
    if (score > 5) score = 5;
    // Reject filler/placeholder evidence: a model that writes "placeholder"
    // or "n/a" instead of a real observation must never reach the UI — junk
    // evidence is exactly what makes a scoring tool untrustworthy.
    const raw = typeof r?.evidence === 'string' ? r.evidence.trim() : '';
    const isFiller = raw.length < 8 || /^(placeholder|n\/?a|none|tbd|unknown|na|example|todo)\.?$/i.test(raw);
    const evidence = isFiller ? '(no specific evidence cited)' : raw.slice(0, 300);
    return { id: cat.id, category: cat.category, score, evidence };
  });
}

function categoriesBlock(): string {
  return NCI_CATEGORIES.map((c) => `${c.id}. ${c.category} — ${c.question} (e.g. ${c.example})`).join('\n');
}

const SHAPE =
  'Respond with ONE JSON object and nothing after it: {"items":[{"id":<1-20>,"score":<1-5>,"evidence":"<one sentence tied to THIS subject>"}, ... all 20]}. ' +
  'Score 1 = Not Present (no signs), 5 = Overwhelmingly Present (clear, strong evidence). ' +
  'Every score MUST be justified by a concrete observation about the subject. If a pattern is not actually present, score it 1 — do NOT inflate. ' +
  'Each "evidence" MUST be a real one-sentence observation about THIS subject — never output "placeholder", "n/a", "none", or any filler.';

function buildLocalPrompt(subject: string, text: string): string {
  return [
    'You are scoring a subject against the NCI Engineered Reality Scoring System (Chase Hughes), a 20-item test for how engineered/manipulated a narrative is. This detects manipulation FORM, not truth.',
    '',
    `SUBJECT: ${subject}`,
    'MATERIAL TO SCORE:',
    text.slice(0, 8000),
    '',
    'The 20 categories:',
    categoriesBlock(),
    '',
    SHAPE,
  ].join('\n');
}

function buildVerifyPrompt(subject: string, text: string, localItems: PsyopItemScore[] | null): string {
  const draft = localItems
    ? 'A first-pass draft score (verify and CORRECT each one against the material; change any score that is not justified):\n' +
      localItems.map((i) => `${i.id}. ${i.category}: ${i.score} — ${i.evidence}`).join('\n')
    : 'No usable first-pass draft; score all 20 yourself from the material.';
  return [
    'You are the verifier for an NCI Engineered Reality score (Chase Hughes\' 20-item psyop-detection instrument). Be rigorous and skeptical of inflated scores. This measures manipulation FORM, not truth.',
    '',
    `SUBJECT: ${subject}`,
    'MATERIAL:',
    text.slice(0, 8000),
    '',
    'The 20 categories:',
    categoriesBlock(),
    '',
    draft,
    '',
    'Produce the FINAL verified scores. ' + SHAPE,
  ].join('\n');
}

export interface ScoreOptions {
  refId: string;               // psyop_scores row id, for usage-ledger logging
  verifyModel?: string;        // cloud model for the verify pass (default opus-4.8)
  signal?: AbortSignal;
}

/**
 * Run the two-pass NCI score. Local (oracle) drafts; cloud (prism @ verifyModel)
 * verifies and finalizes. Resilient: if the local draft is unparseable, the
 * verifier scores from scratch. Throws only if BOTH passes fail to produce a
 * usable 20-item result.
 */
export async function scorePsyop(
  subject: string,
  text: string,
  opts: ScoreOptions,
): Promise<{ result: PsyopScoreResult; localRaw: string }> {
  const verifyModel = opts.verifyModel || 'claude-opus-4-8';

  // ── Pass 1: local abliterated draft (free, uncensored). Non-fatal on failure.
  let localItems: PsyopItemScore[] | null = null;
  let localRaw = '';
  let localModel: string | null = null;
  try {
    const local = await delegate('oracle', buildLocalPrompt(subject, text), {
      shareMemory: false,
      maxTokens: 3000,
      signal: opts.signal,
    });
    localRaw = local.output ?? '';
    localModel = local.modelUsed;
    recordLegUsage('psyop', opts.refId, 'local:draft', local);
    const parsed = extractJson<RawScore>(localRaw);
    if (parsed) localItems = normalizeItems(parsed);
  } catch (err) {
    log('local draft failed (verifier will score from scratch)', { err: String(err).slice(0, 160) });
  }

  // ── Pass 2: cloud verify (authoritative). Fatal if it cannot produce items.
  const verify = await delegate('prism', buildVerifyPrompt(subject, text, localItems), {
    shareMemory: false,
    maxTokens: 3000,
    model: verifyModel,
    signal: opts.signal,
  });
  recordLegUsage('psyop', opts.refId, 'verify', verify);
  const verifyParsed = extractJson<RawScore>(verify.output ?? '');

  // Prefer verified items; fall back to the local draft if the cloud parse
  // failed but the local one succeeded; only then give up.
  let items: PsyopItemScore[];
  if (verifyParsed) {
    items = normalizeItems(verifyParsed);
  } else if (localItems) {
    log('verify parse failed; using local draft as final', {});
    items = localItems;
  } else {
    throw new Error('neither local nor verify pass produced a usable 20-item score');
  }

  const total = items.reduce((s, i) => s + i.score, 0);
  const { band, label } = bandFor(total);
  // The host's interpretive nuance: a mid-range total often means a real story
  // wrapped in an agenda. Surfaced only as a note; the official bands govern.
  const truthAgendaNote = total >= 40 && total <= 75
    ? 'Mid-range total: often a real/true core wrapped in an engineered agenda (the hardest kind to spot). Weigh the high-scoring categories.'
    : null;

  const result: PsyopScoreResult = {
    subject,
    items,
    total,
    band,
    bandLabel: label,
    truthAgendaNote,
    localModel,
    verifyModel: verify.modelUsed,
    disclaimer: DISCLAIMER,
  };
  log('score complete', { subject: subject.slice(0, 60), total, band, localModel, verifyModel: verify.modelUsed });
  return { result, localRaw };
}
