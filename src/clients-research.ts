// AI agency research worker: the two-step flow Gabe specced (2026-06-10).
//
//   Stage 1, "Deep dive" (he clicks it on a lead he likes): sleuth researches
//   the actual business and produces an in-depth profile: verified facts,
//   ranked AI-implementation opportunities with evidence, a snapshot of local
//   competitors (are THEY using AI/digital better?), and an outreach plan
//   (who to contact, on what channel, with what angle). NOT a pitch.
//
//   Stage 2, "Full pitch" (only after his explicit green light): a bespoke,
//   high-level business document in the Good Nature pitch v2 spirit: what we
//   found, what we would build (phased), why now (competitor + AI landscape),
//   ROI framing, one clear next step. Never generic: owners drown in AI spam,
//   so every line must be specific to THIS company.
//
// Jobs are client_artifacts whose content JSON carries status
// queued -> running -> ready | failed. Serial worker, boot requeue,
// Telegram notify on completion via the usual notifier-setter pattern.

import fs from 'fs';

import {
  getClient,
  getClientArtifact,
  listClientArtifacts,
  pendingResearchArtifacts,
  updateClient,
  updateClientArtifact,
  type Client,
  type ClientArtifact,
} from './db.js';
import { exportArtifactDocs } from './clients-export.js';
import { delegate } from './specialists.js';
import { appendUsageDocLine, jobUsageLine, recordLegUsage, summarizeJobUsage } from './usage-ledger.js';
import { logger } from './logger.js';

const log = (msg: string) => logger.info({ scope: 'clients' }, msg);

const POLL_MS = 20_000;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;

export type ClientResearchNotifier = (client: Client, artifact: ClientArtifact, ok: boolean) => void;
let notifier: ClientResearchNotifier | null = null;
export function setClientResearchNotifier(fn: ClientResearchNotifier): void {
  notifier = fn;
}

function parseContent(a: ClientArtifact): Record<string, unknown> {
  try { return a.content ? JSON.parse(a.content) as Record<string, unknown> : {}; } catch { return {}; }
}

function setContent(id: string, content: Record<string, unknown>): void {
  updateClientArtifact(id, { content: JSON.stringify(content) });
}

function extractJson(s: string): Record<string, unknown> | null {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

// Bulk-list dives run their two heavy cloud legs (sleuth research, prism
// synthesis) on Opus 4.8: half Fable 5's per-token cost, state-of-the-art at
// this kind of knowledge work. Fable 5 earned those seats on two eval edges
// (taboo-research refusals, an exactly-vs-at-least precision trap); neither
// is load-bearing for local-business dossiers. Max-depth dives keep the
// specialists' default Fable 5: Good Nature always, or any job whose content
// JSON carries "depth":"max". Lenses (mercury) and scribe/coder are untouched.
const BULK_DIVE_MODEL = 'claude-opus-4-8';
function heavyLegModel(client: Client, artifact: ClientArtifact): string | undefined {
  if (/good nature/i.test(client.company)) return undefined;     // extreme dive: full power
  if (String(parseContent(artifact).depth) === 'max') return undefined;
  return BULK_DIVE_MODEL;
}

function clientBrief(c: Client): string {
  return [
    `Company: ${c.company}`,
    c.industry ? `Industry: ${c.industry}` : '',
    c.location ? `Location: ${c.location}` : '',
    c.contact_info ? `Known contact path: ${c.contact_info}` : '',
    c.pain_points ? `Observed weaknesses (pre-verified):\n${c.pain_points}` : '',
    c.notes ? `Scout notes:\n${c.notes}` : '',
  ].filter(Boolean).join('\n');
}

// v2 (Gabe 2026-06-11): the deep dive is now FOUR research lenses + a
// synthesis pass, so the dossier covers everything he specced: website,
// reviews, social, advertising, and inferred INTERNAL inefficiencies (the
// Good Nature pattern: job posts, employee reviews, and customer complaints
// reveal where manual work and broken workflows live).
const DIVE_LENSES: Array<{ key: string; build: (brief: string) => string; maxTokens?: number }> = [
  {
    key: 'website_marketing',
    build: (brief) => [
      'LENS: website + marketing teardown of a real local business (for an AI consultant\'s internal brief). Open their actual website. Assess: design age, mobile experience, page speed signals, online booking / instant quote capability, service pages, SEO basics (title tags, locations served, blog freshness), and whether they appear in the first results when you search their service + city. Also check whether they run ads: search the Meta Ad Library (facebook.com/ads/library) for their name and check Google search results for sponsored listings. Then check 2-3 LOCAL competitors and note what those competitors do better digitally.',
      '', brief, '',
      'Return ONLY: {"findings": [{"fact": "specific observed fact", "evidence": "url"}], "ads_status": "what you verified about their paid advertising (or none found)", "competitors": [{"name": "", "digital_edge": "", "implication": ""}]}',
      'Only report what you actually observed on pages you opened. No assumptions.',
    ].join('\n'),
  },
  {
    key: 'reputation',
    build: (brief) => [
      'LENS: reviews + reputation mining of a real local business. Check Google reviews, Yelp, BBB, Facebook reviews, Angi/HomeAdvisor where applicable. Report: counts and averages per platform, whether the owner responds to reviews, recency, and MOST IMPORTANTLY the recurring complaint themes in negative/mixed reviews (scheduling problems, no-shows, communication gaps, billing confusion: these reveal internal workflow failures we can fix with automation). Quote 1-2 short representative complaint fragments.',
      '', brief, '',
      'Return ONLY: {"findings": [{"fact": "", "evidence": "url"}], "review_themes": ["recurring theme: what customers repeatedly praise or complain about"], "owner_responds": "yes/no/partial + evidence"}',
      'Real quotes and numbers only from pages you opened.',
      'BE TIGHT so the JSON never truncates: max 6 findings, max 5 review_themes, one short sentence per field.',
    ].join('\n'),
    // Review-heavy companies (solar especially) blew the 2200 default
    // (unparseable -> retry, Ecohouse 2026-06-12 14:55).
    maxTokens: 3000,
  },
  {
    key: 'social',
    build: (brief) => [
      'LENS: social media audit of a real local business. Find their Facebook, Instagram, TikTok, LinkedIn, YouTube. Report: which exist, follower counts, last post date, posting cadence, content quality (real job photos vs nothing vs stock), engagement signals, and whether they use social for lead capture at all.',
      '', brief, '',
      'Return ONLY: {"findings": [{"fact": "", "evidence": "url"}], "social_status": "one-paragraph honest verdict on their social presence"}',
      'Only platforms you actually found and opened; say plainly when a platform does not exist.',
    ].join('\n'),
  },
  {
    key: 'internal_ops',
    build: (brief) => [
      'LENS: internal-operations inference from PUBLIC data for a real local business. Hunt: job postings (Indeed, ZipRecruiter, their site) and what the roles reveal about manual work (e.g. hiring an "office coordinator to answer phones and schedule" = manual dispatch); employee reviews (Indeed/Glassdoor) mentioning broken systems, paperwork, or chaos; customer review complaints that imply internal process failures (double-bookings, lost requests, slow quotes); any visible tooling (booking widgets, CRM badges, "powered by" footers) that shows their software stack or its absence. ALSO hunt specifically for FIXABLE problems in their current systems: named software they use that users complain about (check app-store/G2/Capterra reviews of that product, employee gripes), subscription tools a custom build could replace, manual quoting/estimating where automatic quoting could win jobs, route-heavy operations (movers, couriers, multi-crew field service) with no sign of route optimization (gas + labor hours leak), and disconnected tools (scheduling, invoicing, CRM that clearly do not talk to each other). The goal: where do hours and money leak INSIDE the business that AI workflows, custom apps/CRMs, or system integration could fix, the way a lawn-care company manually typing 60 service texts a day leaks hours.',
      '', brief, '',
      'Return ONLY: {"findings": [{"fact": "", "evidence": "url"}], "internal_ops_signals": ["specific inferred internal inefficiency + the public evidence for it"], "fixable_problems": [{"problem": "specific bug/inefficiency/subscription pain in their current operation or software", "evidence": "url or public signal", "fix": "what we could build or repair for them"}]}',
      'Inference is allowed here but EVERY inference must cite the public signal it rests on. No free-floating guesses.',
      'BE TIGHT so the JSON never truncates: max 6 findings, max 5 internal_ops_signals, max 6 fixable_problems, one short sentence per field.',
    ].join('\n'),
    // The fixable_problems shape made this lens's JSON materially bigger; at
    // 2200 it truncated mid-array (unparseable -> retry, seen 12:17 first run),
    // and 3200 still clipped once on a complaint-heavy company (Vespa 13:31).
    maxTokens: 4000,
  },
];

async function runDeepDive(client: Client, artifact: ClientArtifact): Promise<void> {
  const brief = clientBrief(client);

  // Four lenses, serial (the worker is one job at a time by design; the
  // specialists pool is shared with the rest of Jarvis).
  const lensResults: Record<string, unknown> = {};
  for (const lens of DIVE_LENSES) {
    try {
      let parsed: Record<string, unknown> | null = null;
      // One retry on unparseable output: a lens dropping out loses a whole
      // research angle (the first v2 run lost review-theme mining this way).
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        // mercury (Sonnet, Brave prefetch) runs the extraction lenses: at 78
        // companies x 4 lenses, Fable-tier sleuth here was the single biggest
        // drain on the weekly Max allowance (2026-06-11). Synthesis stays on
        // prism/Fable where the cross-lens reasoning actually pays.
        const res = await delegate('mercury' as never, lens.build(brief), { shareMemory: false, maxTokens: lens.maxTokens ?? 2200 });
        recordLegUsage('deep_dive', artifact.id, `lens:${lens.key}`, res, attempt);
        parsed = extractJson(res.output);
        if (!parsed && attempt === 0) log(`lens ${lens.key} unparseable for ${client.company}; retrying once (tail: ${JSON.stringify(res.output.slice(-160))})`);
      }
      lensResults[lens.key] = parsed ?? { findings: [], parse_error: true };
    } catch (err) {
      lensResults[lens.key] = { findings: [], error: String(err).slice(0, 150) };
    }
  }

  // Synthesis on prism: merge lenses into the dossier shape the drawer
  // renders, with value framing an ROI-minded owner responds to. Bulk dives
  // downshift this leg to Opus 4.8; max-depth dives (Good Nature) stay on
  // prism's default Fable 5. See heavyLegModel().
  const synth = await delegate('prism' as never, [
    'You are synthesizing four research lenses on a real local business into ONE internal dossier for an AI-implementation consultant (Oswalt\'s AI Solutions, Columbus OH). The consultant\'s offer: modern websites/landing pages with booking, SEO + Google Ads (SETUP-ONLY: build campaigns and hand over the keys), AI phone/text answering + review automation, internal workflow automation, AND full inside-the-business modernization: automatic quoting, route optimization (gas + labor savings), custom apps and custom CRMs, fixing or replacing buggy/overpriced subscription software they currently suffer with, and connecting their disconnected systems into one integrated stack. Essentially anything AI can do for a business. The dossier must make the value case so concretely that the owner\'s reaction to the eventual pitch is "this person can save us money, make us more efficient, and make us look far better online." Strict honesty: every claim traces to lens evidence; never invent numbers.',
    '',
    `BUSINESS:\n${brief}`,
    '',
    `LENS website_marketing: ${JSON.stringify(lensResults.website_marketing).slice(0, 4000)}`,
    `LENS reputation: ${JSON.stringify(lensResults.reputation).slice(0, 3500)}`,
    `LENS social: ${JSON.stringify(lensResults.social).slice(0, 2500)}`,
    `LENS internal_ops: ${JSON.stringify(lensResults.internal_ops).slice(0, 3000)}`,
    '',
    'Return ONLY this JSON:',
    `{
  "profile": "5-7 sentence verified company profile incl. digital posture",
  "opportunities": [{"title": "", "whats_broken": "specific, with evidence", "what_wed_build": "concrete fix", "business_impact": "dollars-and-hours framing, conservative, no invented figures"}],
  "review_themes": ["from the reputation lens"],
  "ads_status": "from the website lens",
  "social_status": "from the social lens",
  "internal_ops_signals": ["from the internal lens, each with its public evidence"],
  "fixable_problems": [{"problem": "any bug, inefficiency, or subscription-software pain found anywhere in the lenses that we could fix or replace for them", "evidence": "the public signal", "fix": "what we would build/repair"}],
  "competitors": [{"name": "", "digital_edge": "", "implication": ""}],
  "outreach": {"who": "", "channel": "", "angle": "the single observation most likely to get a reply", "timing": ""},
  "contacts": [{"name": "", "role": "", "phone": "", "email": "", "linkedin": "", "note": ""}],
  "sources": ["all urls the lenses actually used"]
}`,
    '',
    'Rules: 4-7 opportunities ranked by impact (lead with the one that costs them the most today). contacts = decision-makers / main line only, verified fields only. Drop any lens claim that lacks evidence. fixable_problems is a STANDING ORDER from the consultant: ALWAYS surface every issue, bug, or inefficiency the lenses found that we could fix, even small ones and even if it overlaps an opportunity; an empty array is only acceptable when the lenses genuinely found nothing fixable.',
  ].join('\n'), { shareMemory: false, maxTokens: 4600, model: heavyLegModel(client, artifact) });
  recordLegUsage('deep_dive', artifact.id, 'synthesis', synth);

  const out = extractJson(synth.output);
  if (!out || !out.profile) throw new Error('deep dive synthesis returned no parseable JSON');
  const usage = summarizeJobUsage(artifact.id);
  setContent(artifact.id, {
    status: 'ready',
    completed_at: Math.floor(Date.now() / 1000),
    version: 2,
    ...out,
    usage,
    lens_raw: lensResults,
  });
  appendUsageDocLine(jobUsageLine('deep_dive', client.company, usage));
  updateClientArtifact(artifact.id, { title: `Deep dive: ${client.company}` });

  // Enrich the client card with verified decision-maker contacts: the
  // drawer's Contact section reads structured JSON from contact_info.
  const contacts = (Array.isArray(out.contacts) ? out.contacts : [])
    .filter((c): c is Record<string, string> => !!c && typeof c === 'object')
    .map((c) => ({
      name: typeof c.name === 'string' ? c.name : undefined,
      role: typeof c.role === 'string' ? c.role : undefined,
      phone: typeof c.phone === 'string' ? c.phone : undefined,
      email: typeof c.email === 'string' ? c.email : undefined,
      linkedin: typeof c.linkedin === 'string' ? c.linkedin : undefined,
      note: typeof c.note === 'string' ? c.note : undefined,
    }))
    .filter((c) => c.phone || c.email || c.linkedin || c.name);
  if (contacts.length) {
    const primary = contacts[0];
    updateClient(client.id, {
      contact_info: JSON.stringify({ contacts }),
      ...(primary.name && primary.name.toLowerCase() !== 'company' ? { contact_name: primary.name } : {}),
      ...(primary.role ? { contact_role: primary.role } : {}),
    });
  }
}

async function runFullPitch(client: Client, artifact: ClientArtifact): Promise<void> {
  // Ground the pitch in the latest ready deep dive; require one upstream.
  const dive = listClientArtifacts(client.id)
    .find((a) => a.kind === 'deep_dive' && String(parseContent(a).status) === 'ready');
  if (!dive) throw new Error('no completed deep dive to ground the pitch');
  const diveData = parseContent(dive);

  const research = await delegate('sleuth' as never, [
    'Deeper pass for a client pitch: verify and extend this brief with anything decision-relevant you can find NOW (recent reviews, hiring posts, new competitors, whether local competitors visibly use AI/automation: online booking, chatbots, instant quotes, review automation). STRICT JSON only: {"updates": ["new or corrected facts with evidence"], "competitor_ai_usage": ["specific competitor: specific AI/digital capability observed"], "sources": ["urls"]}',
    '',
    clientBrief(client),
    `Prior deep dive: ${JSON.stringify(diveData).slice(0, 4000)}`,
  ].join('\n'), { shareMemory: false, maxTokens: 2000, model: heavyLegModel(client, artifact) });
  recordLegUsage('full_pitch', artifact.id, 'research', research);
  const extra = extractJson(research.output) ?? {};

  const pitch = await delegate('scribe' as never, [
    'Write a bespoke client pitch document in clean Markdown for Oswalt\'s AI Solutions (an AI-implementation consultancy for local businesses, Columbus OH). Audience: the owner/CEO of the company below. Tone: high-level business language, confident, concrete, zero AI-hype buzzwords, zero generic filler. Every claim must trace to the research provided; never invent capabilities, numbers, or competitor facts.',
    'HARD RULES: (1) NEVER mention testimonials, client counts, case studies, or social proof of any kind. (2) Advertising is offered SETUP-ONLY: we build and tune the campaigns and hand over the keys; never promise ongoing ad management. (3) Full-price positioning: no discounts, pilots, or free offers.',
    '',
    'Structure exactly:',
    '# Prepared for [Company]',
    '## What we noticed (their specific situation, respectful but direct)',
    '## What we would build (phased: quick win first, then the bigger fixes; each phase = what it is, what it changes day-to-day)',
    '## The landscape (how local competitors are using digital/AI, what falling behind quietly costs; diplomatic wording)',
    '## What this looks like in numbers (hours saved, calls captured, jobs won: conservative framing from the research; no invented dollar figures)',
    '## Why us (insider operator in a $10M service business, systems we run daily; one short paragraph, no bragging)',
    '## The next step (ONE clear low-friction ask: a 20-minute walkthrough)',
    '',
    `RESEARCH:\n${clientBrief(client)}\n\nDEEP DIVE: ${JSON.stringify(diveData).slice(0, 5000)}\n\nFRESH PASS: ${JSON.stringify(extra).slice(0, 2500)}`,
  ].join('\n'), { shareMemory: false, maxTokens: 4000 });
  recordLegUsage('full_pitch', artifact.id, 'draft', pitch);

  if (!pitch.output || pitch.output.trim().length < 400) throw new Error('pitch draft came back too short');
  const usage = summarizeJobUsage(artifact.id);
  setContent(artifact.id, {
    status: 'ready',
    completed_at: Math.floor(Date.now() / 1000),
    markdown: pitch.output.trim(),
    research_updates: extra,
    usage,
  });
  appendUsageDocLine(jobUsageLine('full_pitch', client.company, usage));
  updateClientArtifact(artifact.id, { title: `Pitch draft: ${client.company}` });
}

async function runDemoSite(client: Client, artifact: ClientArtifact): Promise<void> {
  const dive = listClientArtifacts(client.id)
    .find((a) => a.kind === 'deep_dive' && String(parseContent(a).status) === 'ready');
  if (!dive) throw new Error('no completed deep dive to ground the demo site');
  const diveData = parseContent(dive);

  const res = await delegate('coder' as never, [
    'Build a COMPLETE single-file index.html: a modern, beautiful landing page that shows this real local business what their outdated web presence could become. This is the centerpiece of a sales pitch ("see it before you buy it"), so it must look genuinely professional on first load.',
    '',
    'Hard requirements:',
    '- ONE self-contained HTML file: all CSS in a <style> tag, minimal vanilla JS in a <script> tag, no external resources except system fonts.',
    '- Mobile-responsive, smooth, generous whitespace, a confident accent color fitting the trade, sticky nav, hero with a strong headline about THEIR actual services, services section from their REAL service list, a prominent "Book online" / "Get an instant quote" CTA flow (visual mock: buttons + a simple quote form that does not submit anywhere), contact section with their REAL phone/address, footer.',
    '- HONESTY RULES: use only facts from the research below (real services, real phone, real address, real years-in-business). NO invented testimonials, NO invented star ratings, NO invented statistics, NO stock-photo placeholders. Where a real photo would go, use tasteful CSS gradient/shape placeholders.',
    '- Include exactly one small footer line: "Concept design by Oswalt\'s AI Solutions".',
    '- Output ONLY the raw HTML document, starting with <!DOCTYPE html>. No commentary, no markdown fences. Do NOT write any files to disk and do NOT use SEND_FILE; the HTML must come back inline as your text response.',
    '',
    `BUSINESS RESEARCH:\n${clientBrief(client)}\n\nDEEP DIVE: ${JSON.stringify(diveData).slice(0, 5000)}`,
  ].join('\n'), { shareMemory: false, maxTokens: 8000 });
  recordLegUsage('demo_site', artifact.id, 'build', res);

  // Models wrap the document in prose, fences, or (the coder persona's
  // habit) write it to disk and answer with a [SEND_FILE:path|label]
  // directive. Handle all three rather than trusting the response shape.
  let raw = res.output;
  const sendFile = raw.match(/\[SEND_FILE:([^|\]]+)(?:\|[^\]]*)?\]/);
  if (sendFile) {
    try { raw = fs.readFileSync(sendFile[1].trim(), 'utf8'); }
    catch { /* file gone; fall through to inline parsing of the original */ }
  }
  const docMatch = raw.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
  const html = (docMatch?.[0] ?? raw.replace(/^[\s\S]*?```html?\s*/i, '').replace(/```[\s\S]*$/, '')).trim();
  if (!/^<!DOCTYPE html>/i.test(html) || html.length < 2000 || !/<\/html>\s*$/i.test(html)) {
    throw new Error(`demo site generation came back malformed (got: ${res.output.slice(0, 120).replace(/\s+/g, ' ')}...)`);
  }
  const usage = summarizeJobUsage(artifact.id);
  setContent(artifact.id, { status: 'ready', completed_at: Math.floor(Date.now() / 1000), html, usage });
  appendUsageDocLine(jobUsageLine('demo_site', client.company, usage));
  updateClientArtifact(artifact.id, { title: `Demo site: ${client.company}` });
}

async function tick(): Promise<void> {
  if (!running || busy) return;
  const job = pendingResearchArtifacts()[0];
  if (!job) { schedule(); return; }
  busy = true;
  let backoffMs = 0;
  const client = getClient(job.client_id);
  try {
    if (!client) throw new Error('client vanished');
    setContent(job.id, { ...parseContent(job), status: 'running' });
    log(`research job ${job.kind} for ${client.company} started`);
    if (job.kind === 'deep_dive') await runDeepDive(client, job);
    else if (job.kind === 'demo_site') await runDemoSite(client, job);
    else await runFullPitch(client, job);
    log(`research job ${job.kind} for ${client.company} ready`);
    const fresh = getClientArtifact(job.id);
    if (client && fresh) {
      exportArtifactDocs(client, fresh); // mirror into the Desktop company folder
      try { notifier?.(client, fresh, true); } catch { /* non-fatal */ }
    }
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 300);
    // Usage/rate-limit exhaustion (e.g. the weekly Max cap): do NOT burn the
    // queue into failures. Put the job back, nap an hour, retry: the worker
    // pauses itself at the cap and resumes itself after the reset.
    // A cap-hit mid-run surfaces as a bare "Claude Code process exited with
    // code 1" (B & B Roofing, 2026-06-11 23:25), which fails FAST on every
    // subsequent job and would torch the whole queue; treat it as limit-ish
    // too, but bounded (3 tries) so a genuinely broken job still fails.
    const prev = parseContent(job);
    const retries = typeof prev.limit_retries === 'number' ? prev.limit_retries : 0;
    const limitish = /rate.?limit|quota|usage limit|exceeded|exhausted|429|overloaded|too many requests/i.test(msg);
    const crashish = /exited with code/i.test(msg);
    if (limitish || (crashish && retries < 3)) {
      setContent(job.id, {
        status: 'queued',
        requeued_after_limit: Math.floor(Date.now() / 1000),
        limit_retries: retries + 1,
        // Preserve max-depth across requeues so a cap-hit can't silently
        // downshift a full-power dive to the bulk Opus legs.
        ...(String(parseContent(job).depth) === 'max' ? { depth: 'max' } : {}),
      });
      backoffMs = 60 * 60 * 1000;
      log(`research job ${job.kind} for ${client?.company ?? job.client_id} hit a usage/rate limit or cap-crash (retry ${retries + 1}); worker napping 60 min (job requeued)`);
    } else {
      setContent(job.id, { status: 'failed', error: msg });
      log(`research job ${job.kind} failed: ${msg}`);
      const fresh = getClientArtifact(job.id);
      if (client && fresh) { try { notifier?.(client, fresh, false); } catch { /* non-fatal */ } }
    }
  } finally {
    busy = false;
    if (backoffMs > 0) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), backoffMs);
    } else {
      schedule();
    }
  }
}

function schedule(): void {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), POLL_MS);
}

export function startClientResearchWorker(): void {
  if (running) return;
  running = true;
  timer = setTimeout(() => void tick(), 10_000);
  log('client research worker started');
}

export function stopClientResearchWorker(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
