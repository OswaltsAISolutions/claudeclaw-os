import type { Api, RawApi } from 'grammy';
import Database from 'better-sqlite3';
import path from 'path';

import { ALLOWED_CHAT_ID, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { emitChatEvent } from './state.js';

interface OrphanRow {
  audit_id: number;
  chat_id: string;
  detail: string;
  audit_created_at: number;
}

const SIX_HOURS_SECS = 6 * 60 * 60;
const MATCH_WINDOW_SECS = 5 * 60;

/**
 * One-time recovery pass on boot.
 *
 * For each chat_id with a recent `audit_log` message that has no matching
 * `conversation_log` user row, send a one-shot Telegram + SSE notice so the
 * user knows their last message was clobbered by a SIGTERM mid-task. A
 * `recovery_log` row is inserted for every audit row we touch (matched or
 * notified) so subsequent boots do not re-notify.
 *
 * Safe to call multiple times; idempotent via `recovery_log`.
 *
 * Phase 2 plugs the hole going forward; this exists to handle the pre-Phase-2
 * orphans (the original 2026-05-21 9:40 PM incident).
 */
export async function recoverOrphanMessages(
  botApi: Api<RawApi>,
  opts: { dbPath?: string; allowedChatId?: string } = {},
): Promise<void> {
  const allowed = opts.allowedChatId ?? ALLOWED_CHAT_ID;
  if (!allowed) return;

  const dbPath = opts.dbPath ?? path.join(STORE_DIR, 'claudeclaw.db');
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');

    // Pull all recent message audits (regardless of recovery state) so we can
    // rank per chat_id in JS. If we filtered out recovered rows in SQL, the
    // "most recent per chat_id" would silently drift to older audit rows on
    // each restart — potentially notifying about an old orphan months later.
    const allRecent = db.prepare<[number], OrphanRow>(`
      SELECT id AS audit_id, chat_id, detail, created_at AS audit_created_at
      FROM audit_log
      WHERE action = 'message'
        AND blocked = 0
        AND created_at >= strftime('%s','now') - ?
      ORDER BY chat_id, created_at DESC
    `).all(SIX_HOURS_SECS);

    if (allRecent.length === 0) return;

    // Most-recent audit per chat_id, regardless of recovery state.
    const seen = new Set<string>();
    const candidates: OrphanRow[] = [];
    for (const row of allRecent) {
      if (seen.has(row.chat_id)) continue;
      seen.add(row.chat_id);
      candidates.push(row);
    }

    const recoveredStmt = db.prepare<[number], { audit_id: number }>(
      `SELECT audit_id FROM recovery_log WHERE audit_id = ?`,
    );

    const matchStmt = db.prepare<[string, string, number, number], { id: number }>(`
      SELECT id FROM conversation_log
      WHERE chat_id = ?
        AND role = 'user'
        AND substr(content, 1, 200) = ?
        AND created_at BETWEEN ? AND ?
      LIMIT 1
    `);

    const markStmt = db.prepare<[number, number]>(`
      INSERT OR IGNORE INTO recovery_log (audit_id, recovered_at) VALUES (?, ?)
    `);

    const nowSec = Math.floor(Date.now() / 1000);

    for (const c of candidates) {
      if (recoveredStmt.get(c.audit_id)) {
        continue; // Already handled on a previous boot. Never re-notify.
      }
      const match = matchStmt.get(
        c.chat_id,
        c.detail,
        c.audit_created_at - MATCH_WINDOW_SECS,
        c.audit_created_at + MATCH_WINDOW_SECS,
      );

      if (match) {
        // Healthy pair — record so we never re-check this audit row.
        markStmt.run(c.audit_id, nowSec);
        continue;
      }

      // Orphan. Notify once.
      const preview = c.detail.length > 120 ? c.detail.slice(0, 120) + '...' : c.detail;
      const notice =
        `Heads up: I was restarted before I could finish your last message: ` +
        `"${preview}". Want me to retry it? Reply 'yes' or resend.`;

      if (c.chat_id === allowed) {
        const numericChatId = Number.parseInt(c.chat_id, 10);
        if (!Number.isNaN(numericChatId)) {
          try {
            await botApi.sendMessage(numericChatId, notice);
          } catch (err) {
            logger.warn({ err, audit_id: c.audit_id }, 'Recovery Telegram send failed');
          }
        }
      }

      try {
        emitChatEvent({
          type: 'assistant_message',
          chatId: c.chat_id,
          agentId: 'main',
          content: notice,
          source: 'dashboard',
        });
      } catch (err) {
        logger.warn({ err }, 'Recovery SSE emit failed');
      }

      markStmt.run(c.audit_id, nowSec);
      logger.info(
        { audit_id: c.audit_id, chat_id: c.chat_id, preview: preview.slice(0, 80) },
        'Orphan-message recovery notice sent',
      );
    }
  } finally {
    db.close();
  }
}
