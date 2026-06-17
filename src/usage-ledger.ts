// Measured cloud-usage recorder (Gabe directive 2026-06-12: "measured, not
// estimated"). One row per model call ("leg") in the usage_ledger table,
// plus a human-readable rolling summary in docs/USAGE.md — the docs/ file is
// what fresh Claude sessions and the Jarvis persona already read, so every
// consumer sees the same truth without querying SQLite.
//
// Generic by design: scope + ref_id let any lane log here (deep_dive today;
// fact_check / render / edge_judge later) with no schema change.

import fs from 'fs';
import path from 'path';

import { insertUsageLedger, listUsageLedger, sumUsageSince } from './db.js';
import type { DelegateResult } from './specialists.js';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

// Output-price multipliers vs claude-fable-5 ($10/$50 per MTok; out $50 = 1.0):
// opus 4.x $25 out -> 0.5, sonnet 4.x $15 out -> 0.3, haiku 4.5 $5 out -> 0.1.
// Non-cloud (Ollama tags) burn no cap -> 0. Unknown claude-* defaults to 1.0
// (over-counting beats silently under-counting the cap).
const COST_WEIGHTS: Array<[RegExp, number]> = [
  [/fable-5/i, 1.0],
  [/opus-4/i, 0.5],
  [/sonnet/i, 0.3],
  [/haiku/i, 0.1],
];

export function costWeight(model: string | null | undefined): number {
  if (!model) return 1.0;
  if (!/^claude-/i.test(model)) return 0;
  for (const [re, w] of COST_WEIGHTS) {
    if (re.test(model)) return w;
  }
  return 1.0;
}

/** Record one delegate call. NEVER throws: accounting must not break jobs. */
export function recordLegUsage(
  scope: string,
  refId: string,
  leg: string,
  res: DelegateResult,
  retries = 0,
): void {
  try {
    insertUsageLedger({
      scope,
      refId,
      leg,
      model: res.modelUsed,
      tokensIn: res.tokensIn ?? 0,
      tokensOut: res.tokensOut ?? 0,
      costWeight: costWeight(res.modelUsed),
      durationMs: res.durationMs,
      retries,
      meta: JSON.stringify({
        measured: res.tokensIn != null,
        ...(res.costUsd != null ? { cost_usd: res.costUsd } : {}),
        ...(res.fellBackFrom ? { fell_back_from: res.fellBackFrom } : {}),
      }),
    });
  } catch (err) {
    logger.warn({ scope, refId, leg, err: String(err).slice(0, 120) }, '[usage] ledger write failed');
  }
}

export interface JobUsage {
  legs: number;
  tokens_in: number;
  tokens_out: number;
  weighted_out: number;
  duration_ms: number;
  retries: number;
  models: string[];
  measured: boolean; // false if any leg lacked SDK usage (e.g. local fallback)
}

export function summarizeJobUsage(refId: string): JobUsage {
  const rows = listUsageLedger(refId);
  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))] as string[];
  let measured = rows.length > 0;
  for (const r of rows) {
    try {
      if (r.meta && JSON.parse(r.meta).measured === false) measured = false;
    } catch { /* meta optional */ }
  }
  return {
    legs: rows.length,
    tokens_in: rows.reduce((s, r) => s + r.tokens_in, 0),
    tokens_out: rows.reduce((s, r) => s + r.tokens_out, 0),
    weighted_out: rows.reduce((s, r) => s + r.tokens_out * (r.cost_weight ?? 1.0), 0),
    duration_ms: rows.reduce((s, r) => s + (r.duration_ms ?? 0), 0),
    retries: rows.reduce((s, r) => s + r.retries, 0),
    models,
    measured,
  };
}

export const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(Math.round(n)));

const USAGE_DOC = path.join(PROJECT_ROOT, 'docs', 'USAGE.md');
const LOG_HEADING = '## Log (newest first)';

/** Append one job line to docs/USAGE.md and refresh the rolling-7-day header. */
export function appendUsageDocLine(line: string): void {
  try {
    const week = sumUsageSince(Math.floor(Date.now() / 1000) - 7 * 86400);
    const header = [
      '# USAGE.md — measured cloud burn (auto-written by src/usage-ledger.ts)',
      '',
      'Source of truth: usage_ledger table in store/claudeclaw.db (per-leg rows).',
      'tokens_in includes cache writes + reads (full context processed). "weighted"',
      '= tokens_out x model cost weight (fable-5 = 1.0, opus 0.5, sonnet 0.3).',
      '',
      `**Rolling 7-day total: ${fmtK(week.tokens_in)} in / ${fmtK(week.tokens_out)} out` +
        ` (weighted ~${fmtK(week.weighted_out)} fable-equiv) across ${week.jobs} jobs / ${week.legs} legs.**` +
        ` Updated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST.`,
      '',
      LOG_HEADING,
      '',
    ].join('\n');
    let tail = '';
    if (fs.existsSync(USAGE_DOC)) {
      const cur = fs.readFileSync(USAGE_DOC, 'utf8');
      const idx = cur.indexOf(LOG_HEADING);
      tail = idx >= 0 ? cur.slice(idx + LOG_HEADING.length).replace(/^\s*\n/, '') : '';
    }
    fs.writeFileSync(USAGE_DOC, `${header}- ${line}\n${tail}`);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 120) }, '[usage] USAGE.md write failed');
  }
}

/** One-line job summary for USAGE.md / SESSIONS.md notes. */
export function jobUsageLine(scope: string, label: string, u: JobUsage): string {
  const stamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const models = u.models.map((m) => m.replace(/^claude-/, '')).join(' + ') || 'n/a';
  return `${stamp} ${scope} ${label} — ${fmtK(u.tokens_in)} in / ${fmtK(u.tokens_out)} out` +
    ` (weighted ${fmtK(u.weighted_out)}), ${u.legs} legs, ${(u.duration_ms / 60000).toFixed(1)} min,` +
    ` ${u.retries} retries [${models}]${u.measured ? '' : ' [PARTIALLY UNMEASURED]'}`;
}
