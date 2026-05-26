#!/usr/bin/env node
// Delegate a task to a specialist from the command line.
//
// Usage examples:
//   node dist/specialist-cli.js list
//   node dist/specialist-cli.js route "summarize this article"
//   node dist/specialist-cli.js delegate scribe "summarize the README"
//   node dist/specialist-cli.js delegate coder --max-tokens 800 "review src/foo.ts"
//
// Stdin is appended to the task if present, so you can pipe text:
//   cat README.md | node dist/specialist-cli.js delegate scribe "tldr"
//
// Output is the raw specialist response on stdout. Metadata goes to stderr.

import {
  SPECIALISTS,
  ALL_CALLSIGNS,
  delegate,
  resolveSpecialistModel,
  suggestRoute,
  intelligentRoute,
  type SpecialistCallsign,
} from './specialists.js';
import { initDatabase } from './db.js';

// The CLI runs outside the main service process, so the shared SQLite
// handle is not initialized. Calling initDatabase() here is idempotent.
initDatabase();

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  specialist-cli list',
      '  specialist-cli route "<task description>"',
      '  specialist-cli auto [--max-tokens N] [--no-memory] "<task>"',
      '  specialist-cli delegate <callsign> [--max-tokens N] [--no-memory] "<task>"',
      '',
      'auto = route + delegate in one shot. The recommended path.',
      'delegate = pick a specific specialist (use when you want cloud tier or to override).',
      '',
      'Callsigns: ' + ALL_CALLSIGNS.join(', '),
      '',
    ].join('\n'),
  );
  process.exit(2);
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdList(): Promise<void> {
  for (const cs of ALL_CALLSIGNS) {
    const spec = SPECIALISTS[cs];
    const resolved = await resolveSpecialistModel(cs).catch(() => null);
    const status = resolved
      ? resolved.fellBackFrom
        ? `OK (fallback to ${resolved.model}, wanted ${resolved.fellBackFrom})`
        : `OK (${resolved.model})`
      : `MISSING (wanted ${spec.preferredModel})`;
    process.stdout.write(`${cs.padEnd(10)} ${status}\n            ${spec.role}\n`);
  }
}

async function cmdRoute(args: string[]): Promise<void> {
  const task = args.join(' ').trim();
  if (!task) usage();
  const start = Date.now();
  const r = await intelligentRoute(task);
  const ms = Date.now() - start;
  process.stdout.write(`${r.callsign}\n`);
  process.stderr.write(`[route] ${r.callsign} via ${r.source} in ${ms}ms: ${r.reason}\n`);
}

async function cmdDelegate(args: string[]): Promise<void> {
  if (args.length < 1) usage();
  const callsign = args.shift()!.toLowerCase() as SpecialistCallsign;
  if (!ALL_CALLSIGNS.includes(callsign)) {
    process.stderr.write(`unknown callsign: ${callsign}\nValid: ${ALL_CALLSIGNS.join(', ')}\n`);
    process.exit(2);
  }
  let maxTokens: number | undefined;
  let shareMemory = true;
  const taskParts: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === '--max-tokens') {
      const v = args.shift();
      if (!v) usage();
      maxTokens = parseInt(v, 10);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) usage();
    } else if (a === '--no-memory') {
      shareMemory = false;
    } else {
      taskParts.push(a);
    }
  }
  const piped = await readStdinIfPiped();
  let task = taskParts.join(' ').trim();
  if (piped.trim()) task = task ? `${task}\n\n${piped.trim()}` : piped.trim();
  if (!task) usage();

  const startedAt = Date.now();
  const result = await delegate(callsign, task, { maxTokens, shareMemory });
  const wallMs = Date.now() - startedAt;

  process.stderr.write(
    `[${callsign}] model=${result.modelUsed}${result.fellBackFrom ? ` (fallback from ${result.fellBackFrom})` : ''} tokens~${result.tokenEstimate} took ${result.durationMs}ms (wall ${wallMs}ms)\n`,
  );
  process.stdout.write(result.output);
  if (!result.output.endsWith('\n')) process.stdout.write('\n');
}

/**
 * The recommended path: route + delegate in one shot. Jarvis should default
 * to this for any real-work task; he never has to name a specialist.
 *
 * Flow:
 *   1. intelligentRoute() picks the best callsign (or 'self')
 *   2. If 'self', prints a HANDLE_YOURSELF marker so the caller knows to
 *      do the work directly. Exit 0.
 *   3. Otherwise, delegates and streams the result back, same shape as
 *      `delegate` command output.
 */
async function cmdAuto(args: string[]): Promise<void> {
  let maxTokens: number | undefined;
  let shareMemory = true;
  const taskParts: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === '--max-tokens') {
      const v = args.shift();
      if (!v) usage();
      maxTokens = parseInt(v, 10);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) usage();
    } else if (a === '--no-memory') {
      shareMemory = false;
    } else {
      taskParts.push(a);
    }
  }
  const piped = await readStdinIfPiped();
  let task = taskParts.join(' ').trim();
  if (piped.trim()) task = task ? `${task}\n\n${piped.trim()}` : piped.trim();
  if (!task) usage();

  const routeStart = Date.now();
  const routed = await intelligentRoute(task);
  const routeMs = Date.now() - routeStart;

  process.stderr.write(
    `[auto] routed → ${routed.callsign} via ${routed.source} in ${routeMs}ms: ${routed.reason}\n`,
  );

  if (routed.callsign === 'self') {
    process.stdout.write(`HANDLE_YOURSELF: ${routed.reason}\n`);
    return;
  }

  const delegateStart = Date.now();
  const result = await delegate(routed.callsign, task, { maxTokens, shareMemory });
  const delegateMs = Date.now() - delegateStart;

  process.stderr.write(
    `[${routed.callsign}] model=${result.modelUsed}${result.fellBackFrom ? ` (fallback from ${result.fellBackFrom})` : ''} tokens~${result.tokenEstimate} took ${result.durationMs}ms (wall ${delegateMs}ms)\n`,
  );
  process.stdout.write(result.output);
  if (!result.output.endsWith('\n')) process.stdout.write('\n');
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'list':
      await cmdList();
      break;
    case 'route':
      await cmdRoute(rest);
      break;
    case 'auto':
      await cmdAuto(rest);
      break;
    case 'delegate':
      await cmdDelegate(rest);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
