// Content Library auto-categorizer.
//
// Files each saved X/IG post into the umbrella -> subcategory taxonomy.
// The defining principle: categorize by the post's THESIS/SUBJECT, not by
// the entities it happens to mention. A clip about lobbying in Congress is
// "Power & Geopolitics > Foreign Influence on US" even if it names a group;
// a clip about that group's history goes under "History". Same entity,
// different folder, because the argument is different.
//
// Hybrid model routing (per Gabe): try the cloud writer first for sharp
// naming; if it refuses or returns junk (its guardrails can balk on the
// taboo material this library is built for), fall back to the local
// uncensored model so nothing ever goes unfiled. Local never refuses.

import {
  assignItemCategory,
  ensureCategory,
  findSubcategoryByName,
  findUmbrellaByName,
  listCategoryTree,
  updateLibraryItem,
  type CategoryNode,
  type LibraryItem,
} from './db.js';
import { delegate } from './specialists.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'library-cat', ...extra }, msg);

export type ContentIntent = 'content' | 'build' | 'reference';
export type ContentTrack = 'ai' | 'real_world';
export type ContentPlatform = 'tiktok' | 'youtube' | 'instagram' | 'x';

export interface CategorizeResult {
  tags: string[];
  analysis: Record<string, unknown>;
  folders: Array<{ umbrella: string; subcategory: string; primary: boolean }>;
  newUmbrellas: string[];
  newSubcategories: Array<{ umbrella: string; subcategory: string }>;
  modelUsed: 'cloud' | 'local';
  intent: ContentIntent;
  track: ContentTrack | null;
  platforms: ContentPlatform[];
  contentScore: number;
  contentAngle: string | null;
}

interface Assignment {
  umbrella: string;
  subcategory: string;
  is_primary?: boolean;
  new_umbrella?: boolean;
  new_subcategory?: boolean;
}

interface ModelOutput {
  tags?: unknown;
  content_type?: string;
  hook_summary?: string;
  research_leads?: unknown;
  assignments?: Assignment[];
  intent?: string;
  track?: string;
  platforms?: unknown;
  content_score?: unknown;
  content_angle?: string;
}

function taxonomySnapshot(tree: CategoryNode[]): string {
  return tree
    .map((u) => {
      const subs = (u.subcategories ?? []).map((s) => s.name).join(', ');
      return `- ${u.name}${u.description ? ` (${u.description})` : ''}\n    subcategories: ${subs || '(none yet)'}`;
    })
    .join('\n');
}

// Compact two-track Creator Brief. This is what makes the gate vibe-aware:
// it is NOT "make a video out of everything" — most saves are build/reference.
const CREATOR_BRIEF = [
  "THE CREATOR (Gabe, handle GCruise). He saves posts for THREE different reasons. Decide which one this post is — most posts are NOT content.",
  '',
  'INTENT — pick exactly one:',
  '- "content": a genuine idea/angle for a PUBLIC video or post in one of his two tracks below. Only if it truly fits his vibe. Be selective.',
  '- "build": something to build into or run inside HIS OWN system, never published. ALL quant / finance / trading / markets / algo / personal-tooling / automation-for-himself posts are "build", never "content".',
  '- "reference": saved to learn from or as background/inspiration; not a content idea and not a thing he is building.',
  '',
  'TWO CONTENT TRACKS (only matters when intent = "content"):',
  '- track "ai" -> platforms tiktok + youtube. Thesis: AI is the future and EVERY person can benefit by building their own AI system. EMPOWERMENT / teaching / how-to / showcasing what HE built. Positive, forward-looking (NOT "AI controls us" doom). Audience: AI-curious regular people whose knowledge stops at ChatGPT, plus small businesses wanting to implement AI. Topics: AI for beginners, free/cheap tools (free LLMs via OpenRouter), local agents, hardware/setup guides, make-your-computer-make-money, AI-for-your-business, and proof-demos of his own Jarvis/ClaudeClaw builds. Depth split: tiktok = punchy hook-first informational ("AI can change your life" energy, accessible buzzwords welcome); youtube = same topics but in-depth tutorials and business-implementation walkthroughs. Voice: energetic, accessible.',
  '- track "real_world" -> platforms instagram + x. Lane: world events + real-time geopolitics, governments, wars/conflict, following the money, lobbying, corruption, real (un-sanitized) history, morality (how to be good, how we take the country back). Voice: sophisticated truth-telling, intellectual, passionate, independent NOT partisan; single-narrator monologue.',
  '',
  'GATE RULES:',
  '- Default to "build" for anything quant/finance/markets/trading, and to "reference" for general learning. Reserve "content" for posts that clearly fit one of the two tracks above.',
  '- content_score (0-100) = how strong this is as a CONTENT opportunity (fit-to-vibe + uniqueness + timeliness + substance). For intent build/reference set content_score = 0.',
  '- For intent "content": set track + platforms (ai => ["tiktok","youtube"], real_world => ["instagram","x"]) and a one-line content_angle (the hook / story angle). For build/reference: track=null, platforms=[], content_angle=null.',
].join('\n');

function buildPrompt(item: LibraryItem, tree: CategoryNode[]): string {
  return [
    'You are the librarian + content scout for a creator who saves X and Instagram posts. Your job: file this post into the taxonomy AND decide whether it is a content opportunity. Return STRICT JSON only, no prose.',
    '',
    CREATOR_BRIEF,
    '',
    'THE TAXONOMY (umbrellas and their existing subcategories):',
    taxonomySnapshot(tree),
    '',
    'RULES:',
    '1. Categorize by the THESIS / SUBJECT of the post, NOT by the entities it mentions. Example: a post arguing a foreign country influences US politics belongs under "Power & Geopolitics > Foreign Influence on US", NOT under a history folder, even if it names a people or religion. A post about that people\'s history across centuries belongs under "History & Hidden History". Same entity, different folder, because the argument differs.',
    '2. STRONGLY prefer an existing subcategory. Only invent a NEW subcategory when the post is genuinely distinct from every existing one under the best-fit umbrella. New subcategories are encouraged when truly warranted (set "new_subcategory": true and give the name).',
    '3. Almost always reuse an existing UMBRELLA. Only set "new_umbrella": true if the post truly fits NONE of the umbrellas above (this should be rare).',
    '4. A post may belong to MORE THAN ONE folder if it genuinely spans them (e.g. a Claude Code quant-trading bot = "Finance & Markets > Quant & Algo Trading" AND "AI & Tech > Builds & Setups"). Mark exactly ONE assignment "is_primary": true (the single best home).',
    '5. Subcategory names: short, specific, Title Case (2-4 words). Do not duplicate an existing one with different wording.',
    '',
    'POST TO FILE:',
    `platform: ${item.platform}`,
    item.author_handle ? `author: ${item.author_handle}` : '',
    item.notes ? `user note: ${item.notes}` : '',
    item.caption ? `caption: ${item.caption.slice(0, 1500)}` : '',
    item.transcript ? `transcript: ${item.transcript.slice(0, 7000)}` : '(no transcript / not a video)',
    '',
    'Return ONLY this JSON shape:',
    '{"intent":"content|build|reference","track":"ai|real_world|null","platforms":["tiktok|youtube|instagram|x"],"content_score":0,"content_angle":"one-line hook if content else null","tags":["3-6 short lowercase tags"],"content_type":"theory|content_idea|learning|news|tool|entertainment","hook_summary":"one sentence on why it was worth saving","research_leads":["0-3 specific questions worth a deep research run"],"assignments":[{"umbrella":"...","subcategory":"...","is_primary":true,"new_umbrella":false,"new_subcategory":false}]}',
  ].filter(Boolean).join('\n');
}

const REFUSAL_RE = /\b(i can'?t|i cannot|i'?m (sorry|unable|not able)|i won'?t|i am unable|cannot assist|can'?t help with|not comfortable|against my)\b/i;

const VALID_PLATFORMS: ContentPlatform[] = ['tiktok', 'youtube', 'instagram', 'x'];
const DEFAULT_PLATFORMS: Record<ContentTrack, ContentPlatform[]> = {
  ai: ['tiktok', 'youtube'],
  real_world: ['instagram', 'x'],
};

/** Normalize the model's content-gate fields, defaulting safely (most posts are NOT content). */
function normalizeContentFields(out: ModelOutput | null): {
  intent: ContentIntent;
  track: ContentTrack | null;
  platforms: ContentPlatform[];
  contentScore: number;
  contentAngle: string | null;
} {
  const rawIntent = String(out?.intent ?? '').toLowerCase().trim();
  const intent: ContentIntent =
    rawIntent === 'content' ? 'content' : rawIntent === 'build' ? 'build' : 'reference';

  const rawTrack = String(out?.track ?? '').toLowerCase().trim();
  let track: ContentTrack | null =
    rawTrack === 'ai' ? 'ai' : rawTrack === 'real_world' ? 'real_world' : null;

  let platforms: ContentPlatform[] = Array.isArray(out?.platforms)
    ? (out!.platforms as unknown[])
        .map((p) => String(p).toLowerCase().trim())
        .filter((p): p is ContentPlatform => (VALID_PLATFORMS as string[]).includes(p))
    : [];

  let scoreNum = Number(out?.content_score);
  let contentScore = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : 0;
  let contentAngle =
    typeof out?.content_angle === 'string' && out.content_angle.trim() && out.content_angle.trim().toLowerCase() !== 'null'
      ? out.content_angle.trim().slice(0, 280)
      : null;

  if (intent !== 'content') {
    // Non-content saves never carry a track/platforms/score/angle.
    track = null;
    platforms = [];
    contentScore = 0;
    contentAngle = null;
  } else {
    // Content: backfill platforms from the track default if the model omitted them.
    if (!platforms.length && track) platforms = [...DEFAULT_PLATFORMS[track]];
  }

  return { intent, track, platforms, contentScore, contentAngle };
}

function extractJson(text: string): ModelOutput | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as ModelOutput; } catch { return null; }
}

async function callModel(callsign: string, prompt: string): Promise<{ out: ModelOutput | null; refused: boolean }> {
  try {
    const res = await delegate(callsign as never, prompt, { shareMemory: false, maxTokens: 900 });
    const out = extractJson(res.output);
    const refused = !out && REFUSAL_RE.test(res.output);
    return { out, refused };
  } catch (err) {
    log('model call failed', { callsign, err: String(err).slice(0, 200) });
    return { out: null, refused: false };
  }
}

/**
 * Categorize one item and persist its folder assignments.
 * Cloud (scribe) first; on refusal or junk, local uncensored (oracle).
 */
export async function categorizeItem(item: LibraryItem): Promise<CategorizeResult> {
  const tree = listCategoryTree();
  const prompt = buildPrompt(item, tree);

  let modelUsed: 'cloud' | 'local' = 'cloud';
  let { out } = await callModel('scribe', prompt);
  // Refusal OR unparseable -> the content likely tripped cloud guardrails.
  // Fall back to the local uncensored model, which never refuses.
  if (!out || !Array.isArray(out.assignments) || out.assignments.length === 0) {
    const local = await callModel('oracle', prompt);
    if (local.out && Array.isArray(local.out.assignments) && local.out.assignments.length > 0) {
      out = local.out;
      modelUsed = 'local';
    } else if (!out) {
      out = local.out ?? {};
      modelUsed = 'local';
    }
  }

  const gate = normalizeContentFields(out);

  const result: CategorizeResult = {
    tags: Array.isArray(out?.tags) ? (out!.tags as unknown[]).filter((t) => typeof t === 'string').slice(0, 6) as string[] : [],
    analysis: {
      content_type: out?.content_type ?? null,
      hook_summary: out?.hook_summary ?? null,
      research_leads: Array.isArray(out?.research_leads) ? out!.research_leads!.slice(0, 3) : [],
    },
    folders: [],
    newUmbrellas: [],
    newSubcategories: [],
    modelUsed,
    intent: gate.intent,
    track: gate.track,
    platforms: gate.platforms,
    contentScore: gate.contentScore,
    contentAngle: gate.contentAngle,
  };

  const assignments = Array.isArray(out?.assignments) ? out!.assignments! : [];
  // Guarantee a primary: if none flagged, the first assignment becomes primary.
  let primaryClaimed = assignments.some((a) => a.is_primary);
  let assignedAny = false;

  for (const a of assignments) {
    if (!a || typeof a.umbrella !== 'string' || typeof a.subcategory !== 'string') continue;
    const umbrellaName = a.umbrella.trim();
    const subName = a.subcategory.trim();
    if (!umbrellaName || !subName) continue;

    // Resolve umbrella: reuse existing; only create when the model insists none fit.
    let umbrella = findUmbrellaByName(umbrellaName);
    if (!umbrella) {
      if (!a.new_umbrella) {
        // Model named an umbrella that doesn't exist but didn't flag it new:
        // safest is to skip creating a stray top-level; try treating it as a
        // subcategory miss instead by skipping this assignment.
        log('skipped assignment with unknown umbrella (not flagged new)', { umbrella: umbrellaName, item: item.id });
        continue;
      }
      const created = ensureCategory('umbrella', null, umbrellaName, { createdBy: 'jarvis' });
      umbrella = { id: created.id } as never;
      if (created.created) result.newUmbrellas.push(umbrellaName);
    }
    const umbrellaId = (umbrella as { id: string }).id;

    // Resolve subcategory: reuse existing; create freely when warranted.
    let sub = findSubcategoryByName(umbrellaId, subName);
    let subCreated = false;
    if (!sub) {
      const created = ensureCategory('subcategory', umbrellaId, subName, { createdBy: 'jarvis' });
      subCreated = created.created;
      sub = { id: created.id } as never;
      if (subCreated) result.newSubcategories.push({ umbrella: umbrellaName, subcategory: subName });
    }
    const subId = (sub as { id: string }).id;

    let isPrimary = !!a.is_primary;
    if (!primaryClaimed && !assignedAny) { isPrimary = true; primaryClaimed = true; }
    assignItemCategory(item.id, subId, isPrimary);
    assignedAny = true;
    result.folders.push({ umbrella: umbrellaName, subcategory: subName, primary: isPrimary });
  }

  updateLibraryItem(item.id, {
    tags: result.tags.length ? JSON.stringify(result.tags) : null,
    analysis: JSON.stringify({ ...result.analysis, model_used: modelUsed }),
    intent: result.intent,
    track: result.track,
    platforms: result.platforms.length ? JSON.stringify(result.platforms) : null,
    content_score: result.contentScore,
    content_angle: result.contentAngle,
  });

  log('categorized', { item: item.id, model: modelUsed, intent: result.intent, track: result.track, score: result.contentScore, folders: result.folders.length, newUmb: result.newUmbrellas.length, newSub: result.newSubcategories.length });
  return result;
}
