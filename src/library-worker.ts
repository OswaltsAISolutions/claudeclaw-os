// Content Library ingestion worker.
//
// Serial pipeline for X / Instagram posts saved via share-to-Jarvis or the
// dashboard: metadata (yt-dlp, anonymous-first) -> media download (1080p cap,
// gallery-dl fallback for photos) -> local transcription (resident
// faster-whisper FastAPI on 127.0.0.1:3147) -> LLM tagging (scribe) -> ready.
//
// Design rules:
//   - One platform hit at a time, 30-60s jitter between items (account safety).
//   - Honest status machine; failures are explicit, never silent
//     (failed_auth | failed_gone | failed_extract | failed_transcribe).
//   - Steps are idempotent and keyed by item id, so boot requeue is safe.
//   - Cookies are FALLBACK only (~/.claudeclaw/cookies/<platform>.txt),
//     anonymous-first; main-account cookies must never be used here.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { STORE_DIR, X_BEARER_TOKEN } from './config.js';
import {
  getLibraryItem,
  nextQueuedLibraryItem,
  requeueStuckLibraryItems,
  updateLibraryItem,
  type LibraryItem,
} from './db.js';
import { categorizeItem, type CategorizeResult } from './library-categorizer.js';
import { arxivIdFromUrl } from './library-shared.js';
import { logger } from './logger.js';
import { delegate } from './specialists.js';

const log = (scope: string, msg: string) => logger.info({ scope }, msg);

const LIBRARY_DIR = path.join(STORE_DIR, 'library');
const COOKIES_DIR = path.join(os.homedir(), '.claudeclaw', 'cookies');
const WHISPER_URL = 'http://127.0.0.1:3147';
const POLL_MS = 3000;
const JITTER_MIN_MS = 30_000;
const JITTER_MAX_MS = 60_000;

// Resolve external binaries once at boot; absolute paths first because the
// systemd service PATH may not include ~/.local/bin or the venv.
function resolveBin(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

const BIN = {
  ytdlp: resolveBin([path.join(os.homedir(), '.local/bin/yt-dlp'), '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']),
  gallerydl: resolveBin([path.join(os.homedir(), 'venvs/media/bin/gallery-dl'), '/usr/local/bin/gallery-dl']),
  ffmpeg: resolveBin(['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']),
  python: resolveBin([path.join(os.homedir(), 'venvs/media/bin/python'), '/usr/bin/python3']),
};

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let whisperProc: ReturnType<typeof spawn> | null = null;
let ytdlpAutoUpdatedAt = 0;

// bot.ts registers a notifier so the worker can edit the Telegram ack message
// when an item finishes or fails, without a circular import.
type LibraryNotifier = (item: LibraryItem, phase: 'ready' | 'failed', cat?: CategorizeResult) => void;
let notifier: LibraryNotifier | null = null;
export function setLibraryNotifier(fn: LibraryNotifier): void {
  notifier = fn;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs = 180_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ok */ } }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
}

function cookieArgs(platform: string): string[] {
  const file = path.join(COOKIES_DIR, `${platform}.txt`);
  return fs.existsSync(file) ? ['--cookies', file] : [];
}

function classifyFetchError(stderr: string): 'failed_auth' | 'failed_gone' | 'failed_extract' {
  const s = stderr.toLowerCase();
  if (/login|cookies|authentication|rate.?limit|403|401|account/.test(s)) return 'failed_auth';
  if (/404|not found|unavailable|deleted|no longer|private/.test(s)) return 'failed_gone';
  return 'failed_extract';
}

/** yt-dlp metadata fetch, anonymous first, cookie fallback on auth errors. */
async function fetchMetadata(item: LibraryItem): Promise<{ meta: Record<string, unknown> | null; failure?: string; error?: string }> {
  if (!BIN.ytdlp) return { meta: null, failure: 'failed_extract', error: 'yt-dlp not installed' };

  let res = await run(BIN.ytdlp, ['-J', '--no-download', '--no-warnings', item.url]);
  if (res.code !== 0 && classifyFetchError(res.stderr) === 'failed_auth' && cookieArgs(item.platform).length) {
    res = await run(BIN.ytdlp, ['-J', '--no-download', '--no-warnings', ...cookieArgs(item.platform), item.url]);
  }
  if (res.code !== 0) {
    // Extractor breakage: self-update once per 6h then retry once.
    const failure = classifyFetchError(res.stderr);
    if (failure === 'failed_extract' && Date.now() - ytdlpAutoUpdatedAt > 6 * 3600_000) {
      ytdlpAutoUpdatedAt = Date.now();
      await run(BIN.ytdlp, ['-U'], 120_000);
      const retry = await run(BIN.ytdlp, ['-J', '--no-download', '--no-warnings', ...cookieArgs(item.platform), item.url]);
      if (retry.code === 0) {
        try { return { meta: JSON.parse(retry.stdout) }; } catch { /* fall through */ }
      }
    }
    return { meta: null, failure, error: res.stderr.slice(-600) };
  }
  try {
    return { meta: JSON.parse(res.stdout) };
  } catch {
    return { meta: null, failure: 'failed_extract', error: 'yt-dlp returned unparseable JSON' };
  }
}

function decodeEntities(s: string): string {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Full X post text via the official v2 API (app-only bearer). yt-dlp
 * truncates long-form ("note") tweets to ~280 chars; note_tweet.text holds
 * the complete post. Non-fatal: returns null if no bearer / not found.
 */
async function fetchXFullText(tweetId: string): Promise<string | null> {
  if (!X_BEARER_TOKEN) return null;
  try {
    const r = await fetch(`https://api.x.com/2/tweets/${tweetId}?tweet.fields=note_tweet,text`, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { data?: { text?: string; note_tweet?: { text?: string } } };
    const t = d?.data?.note_tweet?.text || d?.data?.text || '';
    return t ? decodeEntities(t) : null;
  } catch {
    return null;
  }
}

/** Cache the official X embed HTML (free, no auth). Non-fatal on failure. */
async function fetchOembed(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=false&dnt=true`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { html?: string };
    return data.html ?? null;
  } catch {
    return null;
  }
}

async function downloadMedia(item: LibraryItem, mediaDir: string): Promise<{ ok: boolean; file?: string; thumb?: string; failure?: string; error?: string }> {
  if (!BIN.ytdlp) return { ok: false, failure: 'failed_extract', error: 'yt-dlp not installed' };
  fs.mkdirSync(mediaDir, { recursive: true });

  const args = [
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '-o', path.join(mediaDir, 'media.%(ext)s'),
    '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '--no-warnings', '--no-playlist',
    ...cookieArgs(item.platform),
    item.url,
  ];
  const res = await run(BIN.ytdlp, args, 600_000);
  let files = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
  let media = files.find((f) => f.startsWith('media.') && !f.endsWith('.jpg') && !f.endsWith('.json'));

  // Photo / carousel posts: yt-dlp often reports "no video"; gallery-dl handles images.
  if (!media && BIN.gallerydl) {
    await run(BIN.gallerydl, ['-D', mediaDir, '-f', 'photo_{num}.{extension}', ...cookieArgs(item.platform), item.url], 300_000);
    files = fs.readdirSync(mediaDir);
    media = files.find((f) => /^photo_\d+\./.test(f));
  }

  const thumb = files.find((f) => f.startsWith('media.') && f.endsWith('.jpg'));
  if (!media && !thumb) {
    // Text-only X posts are fine: the cached oEmbed carries the display.
    if (item.platform === 'x') return { ok: true };
    return { ok: false, failure: classifyFetchError(res.stderr), error: res.stderr.slice(-600) };
  }
  return { ok: true, file: media, thumb };
}

async function whisperHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const h = (await res.json()) as { ready?: boolean };
    return !!h.ready;
  } catch {
    return false;
  }
}

/** Spawn the resident whisper service if nothing is listening yet. */
export async function ensureWhisperServer(): Promise<void> {
  if (await whisperHealthy()) return;
  if (!BIN.python) {
    log('library', 'whisper server unavailable: no python venv found');
    return;
  }
  const script = path.join(process.cwd(), 'scripts', 'whisper_server.py');
  if (!fs.existsSync(script)) {
    log('library', `whisper server script missing: ${script}`);
    return;
  }
  const logDir = path.join(STORE_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'whisper-server.log'), 'a');
  whisperProc = spawn(BIN.python, [script], {
    detached: false,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  whisperProc.on('exit', (code) => {
    log('library', `whisper server exited (code ${code})`);
    whisperProc = null;
  });
  log('library', 'whisper server starting (model load may take a minute on first run)');
}

async function transcribe(item: LibraryItem, mediaDir: string, mediaFile: string): Promise<{ ok: boolean; text?: string; segments?: string; durationS?: number; error?: string }> {
  if (!BIN.ffmpeg) return { ok: false, error: 'ffmpeg not installed' };
  const src = path.join(mediaDir, mediaFile);
  const wav = path.join(mediaDir, 'audio16k.wav');

  const ff = await run(BIN.ffmpeg, ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], 300_000);
  if (ff.code !== 0 || !fs.existsSync(wav)) {
    // No audio stream (e.g. silent clip or photo) is not an error condition.
    if (/does not contain any stream|no audio/i.test(ff.stderr)) return { ok: true, text: '' };
    return { ok: false, error: `ffmpeg: ${ff.stderr.slice(-400)}` };
  }

  // Whisper may still be loading its model on first boot; wait up to 3 min.
  for (let i = 0; i < 36; i++) {
    if (await whisperHealthy()) break;
    if (i === 0) await ensureWhisperServer();
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!(await whisperHealthy())) {
    return { ok: false, error: 'whisper service not ready (see store/logs/whisper-server.log)' };
  }

  try {
    const res = await fetch(`${WHISPER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: wav }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const data = (await res.json()) as { ok: boolean; text?: string; segments?: unknown; duration_s?: number; error?: string };
    if (!data.ok) return { ok: false, error: data.error ?? 'transcription failed' };
    return { ok: true, text: data.text ?? '', segments: JSON.stringify(data.segments ?? []), durationS: data.duration_s };
  } catch (err) {
    return { ok: false, error: `whisper request failed: ${String(err).slice(0, 300)}` };
  } finally {
    try { fs.unlinkSync(wav); } catch { /* ok */ }
  }
}

function pickStr(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickNum(meta: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

// ── arXiv papers (System 2 of the 2026-06-10 money-systems slice) ──────────
// Quant papers ride the same library pipeline: meta from the arXiv Atom API,
// PDF download, PyMuPDF text extraction (media venv), then the regular
// categorizer plus a paper-card extraction (method / alpha claim / limits).

function atomField(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

async function processArxivItem(item: LibraryItem, mediaDir: string, rel: (p: string) => string): Promise<void> {
  const arxivId = arxivIdFromUrl(item.url);
  if (!arxivId) {
    updateLibraryItem(item.id, { status: 'failed_extract', error: 'could not parse arXiv id from URL' });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }

  // 1. Metadata from the arXiv Atom API (no key needed).
  updateLibraryItem(item.id, { status: 'fetching_meta', error: null });
  let title = '';
  let abstract = '';
  try {
    const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
      headers: { 'User-Agent': 'claudeclaw-library/1.0' },
    });
    const xml = await res.text();
    const entry = xml.match(/<entry>[\s\S]*?<\/entry>/)?.[0] ?? '';
    title = atomField(entry, 'title') ?? arxivId;
    abstract = atomField(entry, 'summary') ?? '';
    const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).slice(0, 8);
    const published = atomField(entry, 'published');
    updateLibraryItem(item.id, {
      author_name: authors.join(', ') || null,
      caption: `${title}${abstract ? `\n\n${abstract}` : ''}`.slice(0, 4000),
      posted_at: published ? Math.floor(Date.parse(published) / 1000) || null : null,
      raw_metadata: JSON.stringify({ arxivId, title, authors, published }).slice(0, 10_000),
    });
  } catch (err) {
    updateLibraryItem(item.id, { status: 'failed_extract', error: `arXiv API: ${String(err).slice(0, 200)}` });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }

  // 2. PDF download.
  updateLibraryItem(item.id, { status: 'downloading' });
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    const res = await fetch(`https://arxiv.org/pdf/${arxivId}`, {
      headers: { 'User-Agent': 'claudeclaw-library/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(mediaDir, 'paper.pdf'), buf);
    updateLibraryItem(item.id, {
      media_dir: rel(mediaDir),
      media_file: 'paper.pdf',
      media_type: 'pdf',
    });
  } catch (err) {
    updateLibraryItem(item.id, { status: 'failed_extract', error: `PDF download: ${String(err).slice(0, 200)}` });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }

  // 3. Text extraction (PyMuPDF in the media venv); reuses the transcript
  // column so search, the drawer, and research flows work unchanged.
  updateLibraryItem(item.id, { status: 'transcribing' });
  if (!BIN.python) {
    updateLibraryItem(item.id, { status: 'failed_transcribe', error: 'python (media venv) not found' });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }
  const ex = await run(BIN.python, [path.join(process.cwd(), 'scripts', 'pdf_extract.py'), path.join(mediaDir, 'paper.pdf')], 120_000);
  let pdfText = '';
  try {
    const parsed = JSON.parse(ex.stdout.trim() || '{}') as { ok?: boolean; text?: string; error?: string };
    if (!parsed.ok || !parsed.text) throw new Error(parsed.error ?? `pdf_extract exit ${ex.code}`);
    pdfText = parsed.text;
  } catch (err) {
    updateLibraryItem(item.id, { status: 'failed_transcribe', error: `pdf extract: ${String(err).slice(0, 200)}` });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }
  updateLibraryItem(item.id, { transcript: pdfText });

  // 4. Categorize via the regular librarian (files it under e.g.
  // Finance & Markets > Quant & Algo Trading), then merge a paper card
  // into analysis so the drawer shows the quant-relevant fields.
  updateLibraryItem(item.id, { status: 'tagging' });
  let cat: CategorizeResult | undefined;
  try {
    cat = await categorizeItem(getLibraryItem(item.id)!);
  } catch (err) {
    log('library', `categorize failed for ${item.id}: ${String(err).slice(0, 200)}`);
  }
  try {
    const cardPrompt = [
      'Extract a structured card from this quantitative-finance paper. Return STRICT JSON only.',
      `Title: ${title}`,
      abstract ? `Abstract: ${abstract.slice(0, 2000)}` : '',
      `Body (truncated): ${pdfText.slice(0, 12_000)}`,
      '',
      'JSON shape: {"method":"one-line description of the core method","asset_class":"equities|crypto|prediction-markets|fx|rates|multi|other","alpha_claim":"the concrete edge/result claimed, with numbers if given","data_used":"datasets/periods","limitations":"honest weaknesses","replication_difficulty":"low|medium|high","practical_use":"what a solo builder with a home server could actually do with this"}',
    ].filter(Boolean).join('\n');
    const res = await delegate('scribe' as never, cardPrompt, { shareMemory: false, maxTokens: 700 });
    const m = res.output.match(/\{[\s\S]*\}/);
    if (m) {
      const card = JSON.parse(m[0]) as Record<string, unknown>;
      const cur = getLibraryItem(item.id)!;
      let analysis: Record<string, unknown> = {};
      try { analysis = cur.analysis ? JSON.parse(cur.analysis) as Record<string, unknown> : {}; } catch { /* fresh */ }
      analysis.paper_card = card;
      updateLibraryItem(item.id, { analysis: JSON.stringify(analysis) });
    }
  } catch (err) {
    log('library', `paper card failed for ${item.id}: ${String(err).slice(0, 200)}`);
  }

  updateLibraryItem(item.id, { status: 'ready', error: null });
  log('library', `item ${item.id} ready (arxiv ${arxivId})`);
  notifier?.(getLibraryItem(item.id)!, 'ready', cat);
}

async function processItem(item: LibraryItem): Promise<void> {
  const mediaDir = path.join(LIBRARY_DIR, item.id);
  const rel = (p: string) => path.relative(process.cwd(), p);

  // arXiv papers take their own pipeline (no yt-dlp / whisper involved).
  if (item.platform === 'arxiv') {
    await processArxivItem(item, mediaDir, rel);
    return;
  }

  // 1. Metadata
  updateLibraryItem(item.id, { status: 'fetching_meta', error: null });
  const { meta, failure, error } = await fetchMetadata(item);
  let caption = '';
  if (meta) {
    caption = decodeEntities(pickStr(meta, 'description', 'title') ?? '');
    updateLibraryItem(item.id, {
      author_name: pickStr(meta, 'uploader', 'channel', 'creator'),
      author_handle: pickStr(meta, 'uploader_id', 'channel_id'),
      caption,
      posted_at: pickNum(meta, 'timestamp', 'release_timestamp'),
      duration_s: pickNum(meta, 'duration'),
      like_count: pickNum(meta, 'like_count'),
      repost_count: pickNum(meta, 'repost_count'),
      comment_count: pickNum(meta, 'comment_count'),
      raw_metadata: JSON.stringify(meta).slice(0, 200_000),
    });
  } else if (failure === 'failed_gone') {
    updateLibraryItem(item.id, { status: 'failed_gone', error: error ?? 'post unavailable' });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }
  // X: cache the official embed regardless; it is also the text-only fallback.
  if (item.platform === 'x') {
    const html = await fetchOembed(item.url);
    if (html) updateLibraryItem(item.id, { oembed_html: html });
    if (!meta && !html) {
      updateLibraryItem(item.id, { status: failure ?? 'failed_extract', error: error ?? 'metadata and oEmbed both failed' });
      notifier?.(getLibraryItem(item.id)!, 'failed');
      return;
    }
    // Enrich from the official API even when yt-dlp gave nothing (photo and
    // text posts): full note_tweet text beats yt-dlp's truncation, and the
    // URL carries the author when metadata is absent.
    const urlMatch = item.url.match(/x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (urlMatch) {
      const [, urlUser, tid] = urlMatch;
      const fullText = await fetchXFullText(tid);
      if (fullText && fullText.length > caption.length) {
        caption = fullText;
        updateLibraryItem(item.id, { caption });
      }
      const cur = getLibraryItem(item.id)!;
      if (!cur.author_handle && urlUser && urlUser !== 'i') {
        updateLibraryItem(item.id, { author_handle: urlUser, author_name: cur.author_name ?? urlUser });
      }
    }
  } else if (!meta) {
    updateLibraryItem(item.id, { status: failure ?? 'failed_extract', error: error ?? 'metadata fetch failed' });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }

  // 2. Media
  updateLibraryItem(item.id, { status: 'downloading' });
  const dl = await downloadMedia(item, mediaDir);
  if (!dl.ok) {
    updateLibraryItem(item.id, { status: dl.failure ?? 'failed_extract', error: dl.error ?? 'media download failed' });
    notifier?.(getLibraryItem(item.id)!, 'failed');
    return;
  }
  const isVideo = !!dl.file && !/^photo_/.test(dl.file);
  updateLibraryItem(item.id, {
    media_dir: rel(mediaDir),
    media_file: dl.file ?? null,
    thumbnail_path: dl.thumb ?? null,
    media_type: dl.file ? (isVideo ? 'video' : 'photo') : 'text',
  });

  // 3. Transcript (videos only)
  let transcript = '';
  if (dl.file && isVideo) {
    updateLibraryItem(item.id, { status: 'transcribing' });
    const tr = await transcribe(item, mediaDir, dl.file);
    if (!tr.ok) {
      // Honest failure state; media stays playable, retry redoes this step.
      updateLibraryItem(item.id, { status: 'failed_transcribe', error: tr.error ?? 'transcription failed' });
      notifier?.(getLibraryItem(item.id)!, 'failed');
      return;
    }
    transcript = tr.text ?? '';
    updateLibraryItem(item.id, {
      transcript,
      transcript_segments: tr.segments ?? null,
      duration_s: tr.durationS ?? undefined,
    });
  }

  // 4. Categorize: tags + analysis + folder assignments (hybrid cloud/local).
  // categorizeItem persists tags/analysis and the umbrella/subcategory links.
  updateLibraryItem(item.id, { status: 'tagging' });
  let cat: CategorizeResult | undefined;
  try {
    cat = await categorizeItem(getLibraryItem(item.id)!);
  } catch (err) {
    log('library', `categorize failed for ${item.id}: ${String(err).slice(0, 200)}`);
  }
  updateLibraryItem(item.id, { status: 'ready', error: null });
  log('library', `item ${item.id} ready (${item.platform}, ${dl.file ?? 'text'})`);
  notifier?.(getLibraryItem(item.id)!, 'ready', cat);

  // Story clustering rides after the ack: a save about an already-saved story
  // collapses into one Studio card. Fire-and-forget; no-op for non-content.
  if (cat?.intent === 'content') {
    const { clusterContentItem } = await import('./content-cluster.js');
    void clusterContentItem(item.id);
  }
}

async function tick(): Promise<void> {
  if (!running) return;
  let delay = POLL_MS;
  try {
    const item = nextQueuedLibraryItem();
    if (item) {
      await processItem(item);
      // Jitter between platform hits, account safety over throughput.
      delay = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
    }
  } catch (err) {
    log('library', `worker tick error: ${String(err).slice(0, 300)}`);
    delay = 15_000;
  }
  if (running) timer = setTimeout(() => void tick(), delay);
}

export function startLibraryWorker(): void {
  if (running) return;
  running = true;
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  const requeued = requeueStuckLibraryItems();
  if (requeued > 0) log('library', `requeued ${requeued} stuck item(s) from previous run`);
  const missing = Object.entries(BIN).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) log('library', `missing binaries: ${missing.join(', ')} (some ingestion steps will fail honestly)`);
  void ensureWhisperServer();
  timer = setTimeout(() => void tick(), 2000);
  log('library', 'content library worker started');
}

export function stopLibraryWorker(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (whisperProc) { try { whisperProc.kill('SIGTERM'); } catch { /* ok */ } whisperProc = null; }
}

export const LIBRARY_MEDIA_ROOT = LIBRARY_DIR;
