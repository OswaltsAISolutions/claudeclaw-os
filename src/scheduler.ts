import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist, agentDefaultModel } from './config.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  getMissionTask,
  updateProjectItem,
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Project research runs are a heavy local dual-track chain (sleuth + oracle,
 *  then prism + heretic, then synthesis), so they get a much longer ceiling
 *  than a normal mission. The 10-minute mission cap timed out the first real
 *  research run; 25 minutes comfortably absorbs the local-model legs. */
const RESEARCH_TASK_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

let sender: Sender;

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  // .catch() so a rejection from the tick's outer orchestration (getDueTasks /
  // computeNextRun / markTaskRunning, or the awaited runDueMissionTasks) — e.g.
  // a SQLITE_BUSY read or one malformed schedule string — is logged instead of
  // becoming an unhandledRejection. The old `void runDueTasks()` let that reject
  // the floating promise; on Node's default unhandled-rejections=throw that
  // crashes the bot, and since this fires every 60s a persistent condition (a
  // corrupt schedule row) would crash-loop it. Per-task execution is already
  // guarded inside the enqueue callback; this covers the orchestration around it.
  setInterval(() => {
    runDueTasks().catch((err) => logger.error({ err }, 'Scheduler tick failed'));
  }, 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        await sender(`Scheduled task running: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`);

        // Run as a fresh agent call (no session — scheduled tasks are autonomous)
        const result = await runAgent(task.prompt, undefined, () => {}, undefined, agentDefaultModel, abortController, undefined, agentMcpAllowlist);
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        const text = result.text?.trim() || 'Task completed with no output.';
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject task output into the active chat session so user replies have context
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        updateTaskAfterRun(task.id, nextRun, text, 'success');

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    // Project research runs get the longer research ceiling; normal missions
    // keep the 10-minute cap.
    const taskTimeoutMs = mission.project_id ? RESEARCH_TASK_TIMEOUT_MS : TASK_TIMEOUT_MS;
    const timeoutMins = Math.round(taskTimeoutMs / 60000);
    const timeout = setTimeout(() => abortController.abort(), taskTimeoutMs);

    // When this mission is a project research run, mirror its outcome into the
    // linked project_item so the Workspace research library updates live.
    const writeBackResearch = (status: 'done' | 'failed', content: string) => {
      if (!mission.project_item_id) return;
      try {
        updateProjectItem(mission.project_item_id, { content, status });
      } catch (e) {
        logger.warn({ err: e, missionId: mission.id }, 'Failed to write research result back to project item');
      }
    };

    // Cross-process cancel signal: dashboard flips status to 'cancelled' in
    // SQLite, this poll picks it up within 5s and aborts the runAgent call.
    let cancelledByUser = false;
    const cancelPoll = setInterval(() => {
      // Guarded: this fires every 5s for the whole task lifetime, concurrent
      // with the agent's own DB writes, so the read is a prime SQLITE_BUSY
      // candidate. An unguarded sync throw in a setInterval callback is an
      // uncaughtException (the tick's .catch() can't reach a separate tick),
      // which would crash the bot — so swallow+log and retry next poll.
      try {
        const current = getMissionTask(mission.id);
        if (current?.status === 'cancelled') {
          cancelledByUser = true;
          abortController.abort();
          clearInterval(cancelPoll);
        }
      } catch (err) {
        logger.warn({ err, missionId: mission.id }, 'Mission cancel-poll read failed; will retry');
      }
    }, 5_000);

    try {
      // A project research run is a forced-main turn: skip the single-specialist
      // pre-pass router (skip:true) and hand the whole task to Jarvis with the
      // team server attached, so he runs the dual-track research recipe. Regular
      // missions keep their existing routing behavior (no routingOptions).
      const missionRouting = mission.project_id ? { chatId, skip: true } : undefined;
      const result = await runAgent(mission.prompt, undefined, () => {}, undefined, agentDefaultModel, abortController, undefined, agentMcpAllowlist, missionRouting);
      clearTimeout(timeout);
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
          writeBackResearch('failed', 'Research run cancelled.');
        } else {
          completeMissionTask(mission.id, null, 'failed', 'Timed out after ' + timeoutMins + ' minutes');
          writeBackResearch('failed', 'Research run timed out after ' + timeoutMins + ' minutes.');
          logger.warn({ missionId: mission.id }, 'Mission task timed out');
          try {
            await sender('Mission task timed out: "' + mission.title + '"');
          } catch (sendErr) {
            // Sender can fail for Telegram API blips or chat-not-found. We
            // still want to see it so the user isn't silently unnotified.
            logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
          }
        }
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        writeBackResearch('done', text);
        logger.info({ missionId: mission.id }, 'Mission task completed');

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
        writeBackResearch('failed', 'Research run cancelled.');
      } else {
        completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
        writeBackResearch('failed', 'Research run failed: ' + errMsg.slice(0, 500));
        logger.error({ err, missionId: mission.id }, 'Mission task failed');
      }
    } finally {
      clearInterval(cancelPoll);
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
