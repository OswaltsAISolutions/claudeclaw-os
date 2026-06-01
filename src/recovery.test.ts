// Tests for Phase 3's orphan-message recovery. Uses a real-but-temp SQLite
// file (recoverOrphanMessages opens its own connection by design — see the
// comment in recovery.ts about avoiding the per-chat top-1 drift).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { recoverOrphanMessages } from './recovery.js';

const CHAT_ID = '2007603393';

function setupDb(): { dbPath: string; db: Database.Database } {
  const dbPath = path.join(os.tmpdir(), `cc-recovery-test-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      chat_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      blocked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main'
    );
    CREATE TABLE recovery_log (
      audit_id INTEGER PRIMARY KEY,
      recovered_at INTEGER NOT NULL
    );
  `);
  return { dbPath, db };
}

function mockBotApi() {
  return {
    sendMessage: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof recoverOrphanMessages>[0];
}

describe('recoverOrphanMessages', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    const setup = setupDb();
    dbPath = setup.dbPath;
    db = setup.db;
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('sends a notice and marks recovery_log when the latest audit row has no paired user turn', async () => {
    const auditTs = Math.floor(Date.now() / 1000) - 60; // 1 min ago — within 6h
    db.prepare(
      `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('main', CHAT_ID, 'message', 'orphan message body', 0, auditTs);
    // No matching conversation_log row.

    const api = mockBotApi();
    await recoverOrphanMessages(api, { dbPath, allowedChatId: CHAT_ID });

    const sendMock = (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toContain('Heads up');
    expect(sendMock.mock.calls[0][1]).toContain('orphan message body');

    const recovered = db.prepare(`SELECT audit_id FROM recovery_log`).all() as Array<{ audit_id: number }>;
    expect(recovered).toEqual([{ audit_id: 1 }]);
  });

  it('does NOT send a notice when the latest audit row is paired in conversation_log', async () => {
    const auditTs = Math.floor(Date.now() / 1000) - 60;
    db.prepare(
      `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('main', CHAT_ID, 'message', 'paired body', 0, auditTs);
    db.prepare(
      `INSERT INTO conversation_log (chat_id, role, content, created_at, agent_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(CHAT_ID, 'user', 'paired body', auditTs + 30, 'main'); // Within 5-min match window.

    const api = mockBotApi();
    await recoverOrphanMessages(api, { dbPath, allowedChatId: CHAT_ID });

    const sendMock = (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(sendMock).not.toHaveBeenCalled();

    // Still marked recovered (so subsequent boots skip it).
    const recovered = db.prepare(`SELECT audit_id FROM recovery_log`).all();
    expect(recovered).toEqual([{ audit_id: 1 }]);
  });

  it('skips audit rows already in recovery_log (no duplicate notices)', async () => {
    const auditTs = Math.floor(Date.now() / 1000) - 60;
    db.prepare(
      `INSERT INTO audit_log (id, agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(42, 'main', CHAT_ID, 'message', 'already handled', 0, auditTs);
    db.prepare(
      `INSERT INTO recovery_log (audit_id, recovered_at) VALUES (?, ?)`,
    ).run(42, auditTs);

    const api = mockBotApi();
    await recoverOrphanMessages(api, { dbPath, allowedChatId: CHAT_ID });

    const sendMock = (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('only considers the MOST RECENT audit row per chat_id (regression for the drift bug)', async () => {
    // Two audit rows for the same chat. Older one would have been an orphan
    // (no paired conv_log), but the most-recent one is paired. We must NOT
    // notify about the older orphan — that would mean we silently drift to
    // historical orphans on every restart.
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('main', CHAT_ID, 'message', 'old orphan body', 0, now - 3600);
    db.prepare(
      `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('main', CHAT_ID, 'message', 'recent paired body', 0, now - 60);
    // Pair only the recent one.
    db.prepare(
      `INSERT INTO conversation_log (chat_id, role, content, created_at, agent_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(CHAT_ID, 'user', 'recent paired body', now - 60, 'main');

    const api = mockBotApi();
    await recoverOrphanMessages(api, { dbPath, allowedChatId: CHAT_ID });

    const sendMock = (api as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(sendMock).not.toHaveBeenCalled();

    // Only the most-recent audit row should be in recovery_log; the older
    // orphan must NOT be touched.
    const recovered = db.prepare(`SELECT audit_id FROM recovery_log ORDER BY audit_id`).all();
    expect(recovered).toEqual([{ audit_id: 2 }]);
  });
});
