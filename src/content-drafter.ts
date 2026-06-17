// Content Engine staged drafting (P3).
//
// Two-step, never one: generateBrief() turns a flagged library item into a
// content BRIEF (hook, angle, beats, key facts, why-now). Gabe reviews it in
// the Studio; only on his greenlight does generateScript() write the full
// script in that track's voice. The voices below are the product — they are
// Gabe's two on-camera personas, not generic copywriting.

import { randomBytes } from 'node:crypto';
import {
  createContentDraft,
  getContentDraft,
  updateContentDraft,
  type ContentDraft,
  type LibraryItem,
} from './db.js';
import { delegate } from './specialists.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'content-draft', ...extra }, msg);

// ── Voices (per track, with the platform depth split Gabe locked 2026-06-10) ──

const VOICE_AI_TIKTOK = [
  'VOICE: Gabe (GCruise), AI track on TikTok. Audience: regular people whose AI knowledge stops at ChatGPT, plus curious small-business owners.',
  'Style: HOOK-FIRST. The first line must stop the scroll. Buzzword-friendly and high energy is GOOD here ("AI can change your life" — and it is true, so say it with conviction, never as a scam pitch).',
  'Shape: hook (1-2 lines) -> live demo / proof moment (his real Jarvis/ClaudeClaw system on screen, real numbers, real output) -> one concrete takeaway the viewer can do TODAY -> soft CTA (follow for the build).',
  'Length: 30-60 seconds spoken (~90-160 words). Short sentences. No jargon without a 5-word translation. Talking-head, casual, [ON SCREEN: ...] cues for text overlays.',
].join('\n');

const VOICE_AI_YOUTUBE = [
  'VOICE: Gabe (GCruise), AI track on YouTube. Same audience entry point as his TikTok (beginners, regular people) but WAY more depth, plus businesses that want to implement AI.',
  'Style: in-depth teaching. Open with the payoff (what you will be able to do by the end), then build step by step. Empowering, energetic, accessible — a guide, not a lecturer. Beginner-safe: every term defined the first time it appears.',
  'Shape: cold-open hook (the result, shown) -> what we are building/learning and why it matters -> chaptered walkthrough with [SCREEN: ...] cues -> business angle where natural (how a real company would use this) -> recap + next step.',
  'Length: 5-12 minutes spoken. Concrete demos from his real system beat theory every time.',
].join('\n');

const VOICE_REAL_WORLD = [
  'VOICE: Gabe (GCruise), Real-World track (Instagram + X). Format: single-narrator talking-head monologue, black suit and tie, same background every video.',
  'Style: sophisticated truth-telling. Storytelling first — build the story like a case: context, the players, follow the money, what they are not telling you. Intellectual AND passionate. Independent, NOT partisan; the loyalty is to the truth and to the country, not a party.',
  'Hard rules: never invent a fact. Distinguish documented fact from allegation from his own read — say "documented", "alleged", "my read" out loud. Moral spine: it always lands on what this means for ordinary people and what a good person does about it.',
  'Shape: cold-open line that names the uncomfortable truth -> the story, beat by beat -> the receipts (key facts) -> the so-what -> one closing line that sticks.',
  'Length: 60-90 seconds for IG/X (~150-250 words spoken).',
].join('\n');

export function voiceFor(track: string, platform: string): string {
  if (track === 'real_world') return VOICE_REAL_WORLD;
  return platform === 'youtube' ? VOICE_AI_YOUTUBE : VOICE_AI_TIKTOK;
}

// ── Brief ──────────────────────────────────────────────────────────────

export interface BriefPayload {
  hook: string;
  angle: string;
  story_beats: string[];
  key_facts: Array<{ fact: string; source: string; needs_verification: boolean }>;
  why_now: string;
  format_notes: string;
}

function itemContext(item: LibraryItem): string {
  return [
    'SOURCE POST:',
    `platform: ${item.platform}`,
    `source url: ${item.url} (fetch it if you need more than the excerpt below)`,
    item.author_handle ? `author: ${item.author_handle}` : '',
    item.content_angle ? `flagged angle: ${item.content_angle}` : '',
    item.notes ? `gabe's note when saving: ${item.notes}` : '',
    item.caption ? `caption: ${item.caption.slice(0, 2000)}` : '',
    item.transcript ? `transcript: ${item.transcript.slice(0, 9000)}` : '(no transcript)',
  ].filter(Boolean).join('\n');
}

function extractJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

/**
 * Stage 1: brief. Creates a content_drafts row (status 'brief', or 'failed'
 * with the error preserved so the Studio shows an honest state).
 */
export async function generateBrief(item: LibraryItem, platform: string): Promise<ContentDraft> {
  const track = item.track === 'real_world' ? 'real_world' : 'ai';
  const id = randomBytes(4).toString('hex');

  const prompt = [
    'You are preparing a CONTENT BRIEF for a video Gabe will record. Not the script yet — the brief he greenlights first. Return STRICT JSON only, no prose.',
    '',
    voiceFor(track, platform),
    '',
    itemContext(item),
    '',
    'Build the brief FROM this source post (it is the seed — the video is Gabe\'s take, not a repost).',
    track === 'real_world'
      ? 'Real-world rule: list every load-bearing factual claim under key_facts with where it comes from (the post itself = source "post"; common knowledge = "known"; anything else = name it) and set needs_verification true for any claim that should be checked before he says it on camera.'
      : 'AI-track rule: key_facts = the concrete capabilities/numbers/tools shown; mark needs_verification true only for claims not demonstrated in the source.',
    '',
    'Return ONLY this JSON shape:',
    '{"hook":"the scroll-stopping opening line","angle":"one sentence: the take this video makes","story_beats":["3-6 beats in order"],"key_facts":[{"fact":"...","source":"post|known|<name>","needs_verification":false}],"why_now":"one line on timeliness","format_notes":"platform-specific delivery notes"}',
  ].join('\n');

  try {
    const res = await delegate('scribe', prompt, { shareMemory: false, maxTokens: 1400 });
    const brief = extractJson<BriefPayload>(res.output);
    if (!brief || !brief.hook || !Array.isArray(brief.story_beats)) {
      const draft = createContentDraft(id, item.id, track, platform, { status: 'failed', error: 'model returned unparseable brief' });
      log('brief failed (unparseable)', { item: item.id });
      return draft;
    }
    const draft = createContentDraft(id, item.id, track, platform, { brief: JSON.stringify(brief), modelUsed: 'scribe' });
    log('brief ready', { item: item.id, draft: id, platform });
    return draft;
  } catch (err) {
    const draft = createContentDraft(id, item.id, track, platform, { status: 'failed', error: String(err).slice(0, 300) });
    log('brief failed', { item: item.id, err: String(err).slice(0, 200) });
    return draft;
  }
}

// ── Script (only after greenlight) ─────────────────────────────────────

export async function generateScript(draft: ContentDraft, item: LibraryItem): Promise<ContentDraft> {
  updateContentDraft(draft.id, { status: 'greenlit', error: null });

  const brief = (() => {
    try { return draft.brief ? (JSON.parse(draft.brief) as BriefPayload) : null; } catch { return null; }
  })();

  // Fact-check verdicts (when the checker has run) override the brief's raw
  // VERIFY flags: confirmed gets stated plainly with the receipt on screen,
  // false never gets spoken, disputed/unverified stay hedged.
  let factDirectives = '';
  try {
    const v = draft.verification ? JSON.parse(draft.verification) as {
      claims?: Array<{ claim: string; verdict: string; correction: string | null; dispute_reason?: string; sources: Array<{ url: string }> }>;
    } : null;
    if (draft.verification_status === 'done' && v?.claims?.length) {
      const lines: string[] = [];
      for (const c of v.claims) {
        const host = c.sources?.[0]?.url ? (() => { try { return new URL(c.sources[0].url).hostname.replace(/^www\./, ''); } catch { return null; } })() : null;
        if (c.verdict === 'confirmed') lines.push(`CONFIRMED — state it plainly and with confidence; add an [ON SCREEN: ${host ?? 'source'}] receipt cue at the natural moment: ${c.claim}`);
        else if (c.verdict === 'false') lines.push(`FALSE — NEVER say the original claim.${c.correction ? ` State the corrected version instead: ${c.correction}` : ' Drop it from the script entirely.'} (original: ${c.claim})`);
        else if (c.verdict === 'disputed') lines.push(`DISPUTED — present it as contested, name the tension honestly (${c.dispute_reason ?? 'sources conflict'}): ${c.claim}`);
        else lines.push(`UNVERIFIED — hedge exactly as the voice requires ("alleged", "reportedly", "my read"): ${c.claim}`);
      }
      factDirectives = `FACT-CHECK VERDICTS (the research team checked these — follow each directive exactly):\n${lines.join('\n')}`;
    }
  } catch { /* fall back to raw flags below */ }

  const unverified = (brief?.key_facts ?? []).filter((f) => f.needs_verification);
  const prompt = [
    'Gabe GREENLIT this brief. Write the full word-for-word script he will deliver on camera. Output ONLY the script text (with [ON SCREEN: ...] / [SCREEN: ...] cues where the voice calls for them) — no preamble, no commentary.',
    '',
    voiceFor(draft.track, draft.platform),
    '',
    'THE APPROVED BRIEF:',
    JSON.stringify(brief ?? {}, null, 2),
    '',
    itemContext(item),
    '',
    'Rules: follow the brief\'s beats. Write it to be SPOKEN — read-aloud rhythm, contractions, no bullet lists in the spoken text.',
    factDirectives || (unverified.length
      ? `UNVERIFIED CLAIMS (${unverified.length}): hedge these exactly as the voice requires ("alleged", "reportedly", "my read") — never state them as settled fact: ${unverified.map((f) => f.fact).join(' | ')}`
      : ''),
  ].filter(Boolean).join('\n');

  const maxTokens = draft.platform === 'youtube' ? 4000 : 1600;
  try {
    const res = await delegate('scribe', prompt, { shareMemory: false, maxTokens });
    const script = res.output.trim();
    if (!script || script.length < 80) {
      updateContentDraft(draft.id, { status: 'failed', error: 'model returned an empty/too-short script' });
      log('script failed (short)', { draft: draft.id });
      return refetch(draft);
    }
    updateContentDraft(draft.id, { status: 'scripted', script, model_used: 'scribe' });
    log('script ready', { draft: draft.id, words: script.split(/\s+/).length });
    // Upload metadata rides along with every script. Fire-and-forget: the
    // script response returns immediately; the kit lands ~15s later and the
    // Studio's poll picks it up. A kit failure never touches the script.
    void generatePublishKit(refetch(draft))
      .catch((err) => log('publish kit failed (script unaffected)', { draft: draft.id, err: String(err).slice(0, 150) }));
    return refetch(draft);
  } catch (err) {
    updateContentDraft(draft.id, { status: 'failed', error: String(err).slice(0, 300) });
    log('script failed', { draft: draft.id, err: String(err).slice(0, 200) });
    return refetch(draft);
  }
}

// The draft can be DELETEd while a generation is in flight; never blow up the
// route with a non-null assertion in that case.
function refetch(draft: ContentDraft): ContentDraft {
  return getContentDraft(draft.id) ?? { ...draft, status: 'failed', error: 'draft was deleted during generation' };
}

// ── Publish kit (upload-time metadata, generated right after the script) ──

export interface PublishKit {
  title: string;          // video title (YouTube) / first-line hook (others)
  caption: string;        // post caption in Gabe's voice for the platform
  hashtags: string[];
  thumbnail_text: string; // 2-5 word overlay for thumbnail/cover
}

const PLATFORM_KIT_NOTES: Record<string, string> = {
  tiktok: 'TikTok: caption short and punchy (under 150 chars before tags), 3-5 hashtags mixing one broad (#ai) with niche ones, thumbnail_text = the bold overlay words.',
  youtube: 'YouTube: title under 70 chars, curiosity + payoff, no clickbait lies; caption = 2-3 sentence description with the takeaway first; 4-6 hashtags; thumbnail_text = 2-4 punchy words.',
  instagram: 'Instagram Reels: caption opens with the hook line then one short paragraph, 5-8 hashtags at the end, thumbnail_text = 2-4 words for the cover.',
  x: 'X: caption IS the post — one or two hard-hitting sentences, max 1-2 hashtags (X culture punishes hashtag spam), thumbnail_text = optional overlay words.',
};

export async function generatePublishKit(draft: ContentDraft): Promise<void> {
  if (!draft.script) return;
  const prompt = [
    'Write the UPLOAD METADATA for this finished video script. Return STRICT JSON only, no prose.',
    '',
    voiceFor(draft.track, draft.platform),
    '',
    PLATFORM_KIT_NOTES[draft.platform] ?? '',
    '',
    'THE SCRIPT:',
    draft.script.slice(0, 6000),
    '',
    'Rules: same voice as the script, lead with what makes someone stop scrolling, never promise more than the script delivers, no invented facts.',
    '',
    'Return ONLY: {"title":"...","caption":"...","hashtags":["no # prefix"],"thumbnail_text":"2-5 words"}',
  ].filter(Boolean).join('\n');

  const res = await delegate('scribe', prompt, { shareMemory: false, maxTokens: 600 });
  const kit = extractJson<PublishKit>(res.output);
  if (!kit || typeof kit.title !== 'string' || typeof kit.caption !== 'string') {
    log('publish kit unparseable', { draft: draft.id });
    return;
  }
  updateContentDraft(draft.id, {
    publish_kit: JSON.stringify({
      title: kit.title.slice(0, 150),
      caption: kit.caption.slice(0, 2200),
      hashtags: Array.isArray(kit.hashtags) ? kit.hashtags.filter((h) => typeof h === 'string').map((h) => h.replace(/^#/, '')).slice(0, 8) : [],
      thumbnail_text: typeof kit.thumbnail_text === 'string' ? kit.thumbnail_text.slice(0, 60) : '',
    } satisfies PublishKit),
  });
  log('publish kit ready', { draft: draft.id });
}
