import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { logToHiveMind } from './db.js';
import { logger } from './logger.js';
import {
  delegate,
  SPECIALISTS,
  ALL_CALLSIGNS,
  type SpecialistCallsign,
  type DelegateResult,
} from './specialists.js';

// ── Jarvis orchestration tools ───────────────────────────────────────
//
// This module gives the MAIN Jarvis agent (and only the main agent) an
// in-process MCP server named "team" so he can do what he is for: think
// big, make a plan, break it into independent sub-tasks, and hand those
// sub-tasks to the specialist best suited to each one, running several at
// once when they do not depend on each other.
//
// Everything routes through specialists.delegate(), so tier resolution,
// the hive_mind log, the honesty labels (UNGROUNDED / NO_TOOLS_FALLBACK /
// CLOUD_FALLBACK notices), and memory sharing all behave exactly as they
// do everywhere else. The tool layer adds no new execution path, only a
// way for Jarvis to fan work out and gather it back.
//
// Recursion is bounded by construction: this server is attached ONLY to
// the main agent's query (see agent.ts). A delegated specialist runs via
// delegateCloud / delegateClaw / direct-ollama, none of which attach this
// server, so a specialist can never sub-delegate. Depth is exactly one.

/** Per-task output cap so a single verbose specialist cannot blow out
 *  Jarvis's context window when several results come back at once. Generous
 *  on purpose: Jarvis needs the substance to synthesize a real answer. */
const MAX_TASK_OUTPUT_CHARS = 12_000;

/** Upper bound on a single parallel fan-out. Keeps concurrency sane and
 *  forces Jarvis to think about decomposition rather than shotgunning. */
const MAX_PARALLEL_TASKS = 6;

const callsignEnum = z.enum(
  ALL_CALLSIGNS as [SpecialistCallsign, ...SpecialistCallsign[]],
);

type CallToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function asText(text: string, isError = false): CallToolText {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function clip(s: string): { body: string; truncated: boolean } {
  if (s.length <= MAX_TASK_OUTPUT_CHARS) return { body: s, truncated: false };
  return { body: s.slice(0, MAX_TASK_OUTPUT_CHARS), truncated: true };
}

/** Render one specialist result into a labeled block Jarvis can read. */
function formatResult(r: DelegateResult): string {
  const { body, truncated } = clip(r.output ?? '');
  const meta = [
    `model: ${r.modelUsed}`,
    `${Math.round(r.durationMs / 100) / 10}s`,
    r.fellBackFrom ? `fell back from ${r.fellBackFrom}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const trunc = truncated ? `\n[...output truncated at ${MAX_TASK_OUTPUT_CHARS} chars]` : '';
  return `=== @${r.callsign} (${meta}) ===\n${body || '[empty output]'}${trunc}`;
}

/** Build the task text handed to a specialist, prepending optional context. */
function buildTask(task: string, context?: string): string {
  const ctx = context?.trim();
  return ctx ? `[Context from Jarvis]\n${ctx}\n[End context]\n\n${task}` : task;
}

/**
 * Construct the in-process "team" MCP server bound to a specific chat.
 *
 * chatId is captured in a closure (the SDK tool handler signature gives us
 * no way to thread it through per call) so every sub-delegation logs under
 * the right conversation and shares that chat's hivemind memory. Pass the
 * live chatId of the turn; an empty string lets delegate() fall back to
 * ALLOWED_CHAT_ID.
 */
export function createTeamMcpServer(chatId: string) {
  const delegateTool = tool(
    'delegate',
    [
      'Hand ONE self-contained sub-task to ONE specialist on your team and get their result back.',
      'Use this once you have a plan and a clean sub-task that a single specialist can finish well.',
      'Pick the specialist whose role fits best (call team_roster if you are unsure who).',
      'If you have several independent sub-tasks you want done at the same time, use delegate_parallel instead so they run concurrently.',
      'The specialist runs with real tools (files, shell, web) on its own model; you get back its finished work, which you should verify and fold into your own answer rather than pasting raw.',
    ].join(' '),
    {
      callsign: callsignEnum.describe(
        'Which specialist handles this sub-task. See team_roster for who does what.',
      ),
      task: z
        .string()
        .min(1)
        .describe('A clear, self-contained instruction. The specialist does not see the chat; spell out what you need.'),
      context: z
        .string()
        .optional()
        .describe('Optional background to prepend (facts, constraints, prior findings) so the specialist has what it needs.'),
    },
    async (args): Promise<CallToolText> => {
      const { callsign, task, context } = args;
      logger.info({ callsign, taskPreview: task.slice(0, 80) }, '[team] delegate');
      console.log(`[team] delegate -> @${callsign}: ${task.slice(0, 80)}`);
      try {
        const result = await delegate(callsign, buildTask(task, context), {
          chatId,
          shareMemory: true,
        });
        try {
          logToHiveMind('main', chatId, 'orchestrate', `delegated to ${callsign}`, JSON.stringify({
            mode: 'single',
            callsign,
            model: result.modelUsed,
            durationMs: result.durationMs,
            taskPreview: task.slice(0, 120),
          }));
        } catch { /* hive log is best-effort */ }
        return asText(formatResult(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ callsign, err: msg }, '[team] delegate failed');
        return asText(`@${callsign} could not complete the task: ${msg}`, true);
      }
    },
  );

  const delegateParallelTool = tool(
    'delegate_parallel',
    [
      'Fan out MULTIPLE independent sub-tasks to specialists that run AT THE SAME TIME, then get all their results back together.',
      'This is how you save wall-clock time on a big job: split it into parts that do not depend on each other and dispatch them in a single call.',
      'Each entry chooses its own specialist (entries may reuse the same specialist or pick different ones).',
      'Results come back labeled by callsign in the order you listed them. One sub-task failing does NOT abort the others; failures are reported inline so you can react.',
      'Only batch parts that are truly independent. If sub-task B needs sub-task A finished first, do A with delegate, read it, then do B.',
      'After the results return, YOU synthesize them into one coherent answer; do not just concatenate.',
    ].join(' '),
    {
      tasks: z
        .array(
          z.object({
            callsign: callsignEnum.describe('Specialist for this sub-task.'),
            task: z.string().min(1).describe('Self-contained instruction for this sub-task.'),
            context: z.string().optional().describe('Optional background to prepend for this sub-task.'),
          }),
        )
        .min(1)
        .max(MAX_PARALLEL_TASKS)
        .describe(
          `Between 1 and ${MAX_PARALLEL_TASKS} INDEPENDENT sub-tasks to run concurrently. Keep each one self-contained.`,
        ),
    },
    async (args): Promise<CallToolText> => {
      const { tasks } = args;
      const callsigns = tasks.map((t) => t.callsign);
      logger.info({ count: tasks.length, callsigns }, '[team] delegate_parallel');
      console.log(`[team] delegate_parallel x${tasks.length} -> ${callsigns.map((c) => '@' + c).join(', ')}`);

      const startedAt = Date.now();
      const settled = await Promise.allSettled(
        tasks.map((t) => delegate(t.callsign, buildTask(t.task, t.context), { chatId, shareMemory: true })),
      );
      const wallMs = Date.now() - startedAt;

      let okCount = 0;
      const blocks = settled.map((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          okCount += 1;
          return formatResult(outcome.value);
        }
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        return `=== @${callsigns[i]} (FAILED) ===\n${reason}`;
      });

      try {
        logToHiveMind('main', chatId, 'orchestrate', `parallel fan-out x${tasks.length}`, JSON.stringify({
          mode: 'parallel',
          callsigns,
          okCount,
          failCount: tasks.length - okCount,
          wallMs,
        }));
      } catch { /* hive log is best-effort */ }

      const header =
        `Ran ${tasks.length} sub-task(s) in parallel: ${okCount} succeeded, ` +
        `${tasks.length - okCount} failed, ${Math.round(wallMs / 100) / 10}s wall time.\n` +
        'Synthesize these into one answer; verify any factual claims that carry an [unverified] label.\n';
      return asText(header + '\n' + blocks.join('\n\n'));
    },
  );

  const rosterTool = tool(
    'team_roster',
    [
      'List your specialist team so you can decide who to delegate a sub-task to.',
      'Returns each callsign with its role, tier, model, and strengths.',
      'Live tier/model truth (including any runtime overrides) is also at GET /api/specialists.',
    ].join(' '),
    {},
    async (): Promise<CallToolText> => {
      const lines = ALL_CALLSIGNS.map((cs) => {
        const s = SPECIALISTS[cs];
        const caps = s.capabilities.slice(0, 6).join(', ');
        return `@${cs} [${s.tier} / ${s.preferredModel}] ${s.role}` + (caps ? `\n    strengths: ${caps}` : '');
      });
      return asText(
        'Your specialist team (delegate sub-tasks to these via delegate / delegate_parallel):\n\n' +
          lines.join('\n'),
      );
    },
  );

  return createSdkMcpServer({
    name: 'team',
    version: '1.0.0',
    tools: [delegateTool, delegateParallelTool, rosterTool],
  });
}
