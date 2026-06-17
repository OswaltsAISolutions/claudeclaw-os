// Edit Bay render worker (E1).
//
// Serial queue (one GPU, one chrome): takes a render job, gets word-level
// timing from the local whisper server, stages the source video into the
// Remotion project's public dir, and spawns `remotion render`. Outputs land
// in store/renders/<jobId>/out.mp4. Honest failure states; renders are
// idempotent so anything interrupted by a restart simply re-queues.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getEditProjectByRenderJobId,
  getLibraryItem,
  getRenderJob,
  listRenderJobs,
  nextQueuedRenderJob,
  requeueStuckRenderJobs,
  updateEditProject,
  updateRenderJob,
  type RenderJob,
} from './db.js';
import { PROJECT_ROOT, STORE_DIR } from './config.js';
import { logger } from './logger.js';

const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info({ scope: 'render', ...extra }, msg);

const VIDEO_DIR = path.join(PROJECT_ROOT, 'video');
const RENDERS_DIR = path.join(STORE_DIR, 'renders');
const WHISPER_URL = 'http://127.0.0.1:3147';
// The bin dir of whatever node runs this service — survives nvm upgrades.
const NODE_BIN_DIR = path.dirname(process.execPath);
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;

let notifier: ((job: RenderJob) => void) | null = null;
export function setRenderNotifier(fn: (job: RenderJob) => void): void {
  notifier = fn;
}

interface Word { start: number; end: number; word: string }

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // detached -> own process group, so a timeout kill takes the WHOLE tree
    // (npx -> remotion node -> headless chrome), not just npx. An orphaned
    // chrome would keep hogging the GPU and racing the next render.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      detached: true,
      env: { ...process.env, PATH: `${NODE_BIN_DIR}:${process.env.PATH ?? ''}` },
    });
    let out = '';
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }, opts.timeoutMs ?? RENDER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.slice(-8000) }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, out: String(err) }); });
  });
}

async function wordsFor(mediaPath: string): Promise<{ words: Word[]; durationS: number }> {
  const wav = path.join(os.tmpdir(), `render-${path.basename(mediaPath, path.extname(mediaPath))}-${Date.now() % 100000}.wav`);
  try {
    const ff = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mediaPath, '-ar', '16000', '-ac', '1', wav], { timeoutMs: 120_000 });
    if (ff.code !== 0) throw new Error(`audio extract failed: ${ff.out.slice(0, 200)}`);
    const res = await fetch(`${WHISPER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: wav, words: true }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const data = await res.json() as { ok: boolean; error?: string; duration_s?: number; segments?: Array<{ words?: Word[] }> };
    if (!data.ok) throw new Error(`whisper: ${data.error ?? 'unknown'}`);
    const words = (data.segments ?? []).flatMap((s) => s.words ?? []);
    return { words, durationS: data.duration_s ?? 0 };
  } finally {
    try { fs.unlinkSync(wav); } catch { /* tmp */ }
  }
}

async function processJob(job: RenderJob): Promise<void> {
  if (job.kind === 'timeline') return processTimelineJob(job);
  return processCaptionClipJob(job);
}

// ── kind 'timeline': directed/collage/faceless edits via the Director ───

async function processTimelineJob(job: RenderJob): Promise<void> {
  const spec = (() => {
    try {
      return job.spec ? JSON.parse(job.spec) as {
        item_ids?: string[]; brief?: string; aspect?: string; target_s?: number; allow_narration?: boolean;
        voiceover_file?: string; captions?: boolean;
      } : {};
    } catch { return {}; }
  })();

  updateRenderJob(job.id, { status: 'preparing', error: null });
  const staged = new Set<string>();
  const propsFile = path.join(VIDEO_DIR, `props-${job.id}.json`);
  const outDir = path.join(RENDERS_DIR, job.id);
  // QC auto-revise: round 1 plans fresh; a QC fail feeds the issues back to
  // the Director for ONE corrected plan. Vision material reports are gathered
  // once and reused; narration audio is cached so a revision never re-spends
  // ElevenLabs credits on identical text.
  const MAX_ROUNDS = 2;

  try {
    // Gabe's voiceover (the usual case on the faceless channel): time it
    // FIRST so the Director plans visuals to fit his read, not the reverse.
    let vo: { absPath: string; words: Word[]; durationS: number } | null = null;
    if (spec.voiceover_file) {
      const voAbs = path.resolve(PROJECT_ROOT, spec.voiceover_file);
      if (!voAbs.startsWith(STORE_DIR + path.sep) || !fs.existsSync(voAbs)) {
        updateRenderJob(job.id, { status: 'failed', error: 'voiceover file missing' });
        return;
      }
      const timed = await wordsFor(voAbs);
      vo = { absPath: voAbs, words: timed.words, durationS: timed.durationS };
    }

    const { directTimeline, gatherMaterials } = await import('./edit-director.js');
    let materials: Awaited<ReturnType<typeof gatherMaterials>>;
    try {
      materials = await gatherMaterials(spec.item_ids ?? []);
    } catch (err) {
      updateRenderJob(job.id, { status: 'failed', error: String(err).slice(0, 250) });
      return;
    }

    fs.mkdirSync(path.join(VIDEO_DIR, 'public'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'out.mp4');
    let narrCache: { text: string; words: Word[]; durationS: number } | null = null;
    let revision: { issues: string[]; previousSummary?: string } | undefined;
    let lastOutputRel: string | null = null;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const result = await directTimeline({
        itemIds: spec.item_ids ?? [],
        materials,
        brief: vo
          ? `${spec.brief ?? ''}\n\n(A recorded voiceover of ${Math.round(vo.durationS)} seconds will play over the whole video — plan the visuals to fill that length. Do not write narrationText.)`
          : (spec.brief ?? ''),
        aspect: spec.aspect === '16:9' ? '16:9' : spec.aspect === '1:1' ? '1:1' : '9:16',
        targetDurationS: vo ? Math.ceil(vo.durationS + 1) : spec.target_s,
        allowNarration: vo ? false : spec.allow_narration !== false,
        revision,
      });
      if (!result.ok || !result.plan || !result.sourceFiles) {
        if (round === 1 || !revision) {
          updateRenderJob(job.id, { status: 'failed', error: result.error ?? 'director rejected the brief' });
        } else {
          // Round 1's render exists and failed QC; the revision attempt died —
          // surface the original verdict, keep the output for inspection.
          updateRenderJob(job.id, {
            status: 'qc_failed',
            output_file: lastOutputRel,
            error: `QC failed: ${revision.issues.join('; ').slice(0, 280)} (revision attempt failed: ${(result.error ?? 'no plan').slice(0, 80)})`,
          });
        }
        return;
      }
      const plan = result.plan;
      updateRenderJob(job.id, { spec: JSON.stringify({ ...spec, director_notes: result.notes ?? null, qc_round: round }) });

      // Stage sources into the Remotion public dir; rewrite plan tokens.
      // (Round 2 reuses round 1's copies — same job, same names.)
      const tokenToFile = new Map<string, string>();
      for (const [token, abs] of Object.entries(result.sourceFiles)) {
        const name = `render-${job.id}-${token}.mp4`;
        const dest = path.join(VIDEO_DIR, 'public', name);
        if (!staged.has(dest)) { fs.copyFileSync(abs, dest); staged.add(dest); }
        tokenToFile.set(token, name);
      }
      for (const seg of plan.video) {
        const name = tokenToFile.get(seg.src);
        if (!name) throw new Error(`unstaged source token ${seg.src}`);
        seg.src = name;
      }

      // Gabe's voiceover: attach his read + word-synced captions in the
      // verified-safe zone (informational labels live upstream; nothing gates).
      if (vo) {
        const voName = `render-${job.id}-vo${path.extname(vo.absPath) || '.mp3'}`;
        const voDest = path.join(VIDEO_DIR, 'public', voName);
        if (!staged.has(voDest)) { fs.copyFileSync(vo.absPath, voDest); staged.add(voDest); }
        const voStart = 0.3;
        const voEnd = voStart + vo.durationS;
        if (voEnd + 0.4 > plan.durationS && plan.video.length > 0) {
          const grow = voEnd + 0.4 - plan.durationS;
          plan.video[plan.video.length - 1].durS += grow;
          plan.durationS = Math.round((plan.durationS + grow) * 100) / 100;
        }
        plan.audio = [...(plan.audio ?? []), { src: voName, startS: voStart, volume: 1, fadeOutS: 0.3 }];
        if (spec.captions !== false && result.safeCaptionY !== null && result.safeCaptionY !== undefined && vo.words.length > 0) {
          plan.captions = {
            words: vo.words.map((w) => ({ start: Math.round((w.start + voStart) * 100) / 100, end: Math.round((w.end + voStart) * 100) / 100, word: w.word })),
            y: result.safeCaptionY,
            accent: '#FFD400',
          };
        }
      }

      // Narration: synthesize, time, attach (and stretch the tail if needed).
      if (!vo && result.narrationText) {
        const narrName = `render-${job.id}-narr.mp3`;
        const narrDest = path.join(VIDEO_DIR, 'public', narrName);
        if (!narrCache || narrCache.text !== result.narrationText) {
          const { synthesizeNarration } = await import('./narrator.js');
          const narr = await synthesizeNarration(result.narrationText, outDir);
          fs.copyFileSync(narr.audioFile, narrDest);
          staged.add(narrDest);
          narrCache = { text: result.narrationText, words: narr.words, durationS: narr.durationS };
        }
        const narrStart = 0.6;
        const narrEnd = narrStart + narrCache.durationS;
        if (narrEnd + 0.4 > plan.durationS && plan.video.length > 0) {
          const grow = narrEnd + 0.4 - plan.durationS;
          plan.video[plan.video.length - 1].durS += grow;
          plan.durationS = Math.round((plan.durationS + grow) * 100) / 100;
        }
        plan.audio = [...(plan.audio ?? []), { src: narrName, startS: narrStart, volume: 1, fadeOutS: 0.4 }];
        if (result.captionsWanted && result.safeCaptionY !== null) {
          plan.captions = {
            words: narrCache.words.map((w) => ({ start: Math.round((w.start + narrStart) * 100) / 100, end: Math.round((w.end + narrStart) * 100) / 100, word: w.word })),
            y: result.safeCaptionY ?? undefined,
            accent: '#FFD400',
          };
        }
      }

      fs.writeFileSync(propsFile, JSON.stringify({ plan }));
      updateRenderJob(job.id, { status: 'rendering' });
      const render = await run('npx', [
        'remotion', 'render', 'src/index.ts', 'Timeline', outFile,
        `--props=${propsFile}`, '--log=error',
      ], { cwd: VIDEO_DIR });
      if (render.code !== 0 || !fs.existsSync(outFile)) {
        updateRenderJob(job.id, { status: 'failed', error: `render failed: ${render.out.slice(-400)}` });
        return;
      }
      lastOutputRel = path.relative(PROJECT_ROOT, outFile);

      // The no-slop gate: the inspector reviews the FINISHED frames.
      const { qcCheck } = await import('./edit-vision.js');
      const qc = await qcCheck(outFile, plan.durationS);
      if (qc.passed) {
        updateRenderJob(job.id, { status: 'ready', output_file: lastOutputRel, error: null });
        log('timeline render done', { job: job.id, round, durationS: plan.durationS });
        return;
      }
      if (round === MAX_ROUNDS) {
        updateRenderJob(job.id, {
          status: 'qc_failed',
          output_file: lastOutputRel,
          error: `QC failed (after ${MAX_ROUNDS} rounds): ${qc.issues.join('; ').slice(0, 330)}`,
        });
        log('timeline qc failed, rounds exhausted', { job: job.id, issues: qc.issues.length });
        return;
      }
      // Feed the verdict back to the Director and try once more.
      revision = {
        issues: qc.issues,
        previousSummary: [
          (plan.overlays ?? []).map((o) => `${o.kind} "${(o.text ?? '').slice(0, 30)}" at ${o.startS}s`).join(', ') || 'no overlays',
          plan.captions ? `captions at y=${plan.captions.y}` : 'no captions',
        ].join('; '),
      };
      updateRenderJob(job.id, { status: 'preparing', error: `QC round ${round} failed, revising: ${qc.issues.join('; ').slice(0, 200)}` });
      log('qc failed, revising plan', { job: job.id, round, issues: qc.issues.length });
    }
  } catch (err) {
    updateRenderJob(job.id, { status: 'failed', error: String(err).slice(0, 400) });
    log('timeline render failed', { job: job.id, err: String(err).slice(0, 200) });
  } finally {
    for (const f of staged) { try { fs.unlinkSync(f); } catch { /* staged */ } }
    try { fs.unlinkSync(propsFile); } catch { /* props */ }
    const fresh = getRenderJob(job.id);
    if (fresh && ['ready', 'failed', 'qc_failed'].includes(fresh.status)) {
      try { notifier?.(fresh); } catch (err) { log('render notifier failed', { err: String(err).slice(0, 120) }); }
      // Faceless workbench: reflect the outcome on the owning project so it
      // never sticks at 'rendering' (ready -> done; any fail -> back to approved).
      const proj = getEditProjectByRenderJobId(job.id);
      if (proj && proj.status === 'rendering') {
        updateEditProject(proj.id, { status: fresh.status === 'ready' ? 'done' : 'approved' });
      }
    }
  }
}

// ── kind 'caption_clip': single-source word-synced captions ─────────────

async function processCaptionClipJob(job: RenderJob): Promise<void> {
  const spec = (() => {
    try { return job.spec ? JSON.parse(job.spec) as { aspect?: string; accent?: string } : {}; } catch { return {}; }
  })();
  const aspect = spec.aspect === '16:9' ? '16:9' : '9:16';
  const accent = typeof spec.accent === 'string' ? spec.accent : '#FFD400';

  updateRenderJob(job.id, { status: 'preparing', error: null });
  const publicCopy = path.join(VIDEO_DIR, 'public', `render-${job.id}.mp4`);
  const propsFile = path.join(VIDEO_DIR, `props-${job.id}.json`);
  const outDir = path.join(RENDERS_DIR, job.id);

  try {
    // Inside the try so the failure ping fires for these too.
    const item = job.item_id ? getLibraryItem(job.item_id) : null;
    if (!item || !item.media_file || item.media_type !== 'video') {
      updateRenderJob(job.id, { status: 'failed', error: 'source item has no video media' });
      return;
    }
    const srcPath = path.join(STORE_DIR, 'library', item.id, item.media_file);
    if (!fs.existsSync(srcPath)) {
      updateRenderJob(job.id, { status: 'failed', error: `media file missing: ${item.media_file}` });
      return;
    }

    // HARD GATES (Gabe's standing caption rules): the editor LOOKS at the
    // footage before it is allowed to render. Blind renders are how captions
    // ended up on top of a video's own captions — never again.
    const { analyzeVideo } = await import('./edit-vision.js');
    const report = await analyzeVideo(srcPath, item.duration_s ?? undefined);
    updateRenderJob(job.id, { spec: JSON.stringify({ ...spec, aspect, analysis: report }) });
    if (report.hasBurnedCaptions) {
      updateRenderJob(job.id, { status: 'failed', error: 'source already has captions — rule: never double-caption' });
      return;
    }
    if (report.safeCaptionY === null) {
      updateRenderJob(job.id, { status: 'failed', error: 'no safe caption zone — every region has text or the speaker (rule: never cover content)' });
      return;
    }

    const { words, durationS } = await wordsFor(srcPath);
    if (words.length === 0) {
      updateRenderJob(job.id, { status: 'failed', error: 'no speech detected in the source (captions need spoken words)' });
      return;
    }

    fs.mkdirSync(path.join(VIDEO_DIR, 'public'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    // Real copy: the Remotion bundler does not follow symlinks out of public/.
    fs.copyFileSync(srcPath, publicCopy);
    fs.writeFileSync(propsFile, JSON.stringify({
      videoSrc: `render-${job.id}.mp4`,
      durationS,
      aspect,
      words,
      accent,
      // Captions land only in the zone the vision pass verified empty.
      captionY: report.safeCaptionY,
    }));

    updateRenderJob(job.id, { status: 'rendering' });
    const outFile = path.join(outDir, 'out.mp4');
    const render = await run('npx', [
      'remotion', 'render', 'src/index.ts', 'CaptionedClip', outFile,
      `--props=${propsFile}`, '--log=error',
    ], { cwd: VIDEO_DIR });

    if (render.code !== 0 || !fs.existsSync(outFile)) {
      updateRenderJob(job.id, { status: 'failed', error: `render failed: ${render.out.slice(-400)}` });
      return;
    }
    updateRenderJob(job.id, { status: 'ready', output_file: path.relative(PROJECT_ROOT, outFile), error: null });
    log('render ready', { job: job.id, item: item.id, aspect, words: words.length });
  } catch (err) {
    updateRenderJob(job.id, { status: 'failed', error: String(err).slice(0, 400) });
    log('render failed', { job: job.id, err: String(err).slice(0, 200) });
  } finally {
    try { fs.unlinkSync(publicCopy); } catch { /* staged copy */ }
    try { fs.unlinkSync(propsFile); } catch { /* props */ }
    const fresh = getRenderJob(job.id);
    if (fresh && (fresh.status === 'ready' || fresh.status === 'failed')) {
      try { notifier?.(fresh); } catch (err) { log('render notifier failed', { err: String(err).slice(0, 120) }); }
    }
  }
}

// ── Queue loop (mirrors the library worker pattern) ─────────────────────

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick(): Promise<void> {
  if (running) return;
  const job = nextQueuedRenderJob();
  if (!job) return;
  running = true;
  try {
    await processJob(job);
  } catch (err) {
    updateRenderJob(job.id, { status: 'failed', error: String(err).slice(0, 300) });
  } finally {
    running = false;
  }
}

export function kickRenderWorker(): void {
  void tick().catch((err) => log('tick failed', { err: String(err).slice(0, 200) }));
}

export function startRenderWorker(): void {
  if (timer) return;
  const requeued = requeueStuckRenderJobs();
  if (requeued > 0) log('requeued interrupted renders', { count: requeued });
  timer = setInterval(kickRenderWorker, 15_000);
  log('render worker started', { pending: listRenderJobs(10).filter((j) => j.status === 'queued').length });
}

export function stopRenderWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
