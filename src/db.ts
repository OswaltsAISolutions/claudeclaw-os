import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DB_ENCRYPTION_KEY, STORE_DIR } from './config.js';
import { cosineSimilarity } from './embeddings.js';
import { logger } from './logger.js';

// ── Field-Level Encryption (AES-256-GCM) ────────────────────────────
// All message bodies (WhatsApp, Slack) are encrypted before storage
// and decrypted on read. The key lives in .env (DB_ENCRYPTION_KEY).

let encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const hex = DB_ENCRYPTION_KEY;
  if (!hex || hex.length < 32) {
    throw new Error(
      'DB_ENCRYPTION_KEY is missing or too short. Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add to .env',
    );
  }
  encryptionKey = Buffer.from(hex, 'hex');
  return encryptionKey;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a compact string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encryptField(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string produced by encryptField().
 * Returns the original plaintext. If decryption fails (wrong key, tampered),
 * returns the raw input unchanged (graceful fallback for pre-encryption data).
 */
export function decryptField(ciphertext: string): string {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext; // Not encrypted, return as-is
    const [ivHex, authTagHex, dataHex] = parts;
    if (!ivHex || !authTagHex || !dataHex) return ciphertext;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed: probably pre-encryption plaintext data
    return ciphertext;
  }
}

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      prompt      TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      next_run    INTEGER NOT NULL,
      last_run    INTEGER,
      last_result TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS sessions (
      chat_id    TEXT NOT NULL,
      agent_id   TEXT NOT NULL DEFAULT 'main',
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'conversation',
      raw_text      TEXT NOT NULL,
      summary       TEXT NOT NULL,
      entities      TEXT NOT NULL DEFAULT '[]',
      topics        TEXT NOT NULL DEFAULT '[]',
      connections   TEXT NOT NULL DEFAULT '[]',
      importance    REAL NOT NULL DEFAULT 0.5,
      salience      REAL NOT NULL DEFAULT 1.0,
      consolidated  INTEGER NOT NULL DEFAULT 0,
      embedding     TEXT,
      created_at    INTEGER NOT NULL,
      accessed_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS consolidations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      source_ids    TEXT NOT NULL,
      summary       TEXT NOT NULL,
      insight       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wa_message_map (
      telegram_msg_id INTEGER PRIMARY KEY,
      wa_chat_id      TEXT NOT NULL,
      contact_name    TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wa_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_chat_id  TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_wa_outbox_unsent ON wa_outbox(sent_at) WHERE sent_at IS NULL;

    CREATE TABLE IF NOT EXISTS wa_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON wa_messages(chat_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS conversation_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL,
      session_id  TEXT,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_convo_log_chat ON conversation_log(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      session_id      TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      context_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      did_compact     INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_chat ON token_usage(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS slack_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      user_name    TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS hive_mind (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      chat_id     TEXT NOT NULL,
      action      TEXT NOT NULL,
      summary     TEXT NOT NULL,
      artifacts   TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hive_mind_agent ON hive_mind(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hive_mind_time ON hive_mind(created_at DESC);

    CREATE TABLE IF NOT EXISTS inter_agent_tasks (
      id            TEXT PRIMARY KEY,
      from_agent    TEXT NOT NULL,
      to_agent      TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      result        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inter_agent_tasks_status ON inter_agent_tasks(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS mission_tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      assigned_agent  TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',
      result          TEXT,
      error           TEXT,
      created_by      TEXT NOT NULL DEFAULT 'dashboard',
      priority        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      completed_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_mission_status
      ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);

    -- Workspace: Claude-Projects-style hub. A project groups goals, tasks, and
    -- a research library; project_items is the flexible content store.
    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      instructions    TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'active',
      color           TEXT NOT NULL DEFAULT 'cyan',
      created_by      TEXT NOT NULL DEFAULT 'dashboard',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_worked_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_projects_status
      ON projects(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS project_items (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,              -- 'goal' | 'task' | 'research'
      category        TEXT,                       -- research category; null for goal/task
      title           TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      url             TEXT,
      source          TEXT,
      status          TEXT,                       -- goal/task: open|doing|done ; research: null|running|done|failed
      assigned_agent  TEXT,
      metadata        TEXT,                       -- JSON blob
      pinned          INTEGER NOT NULL DEFAULT 0,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_by      TEXT NOT NULL DEFAULT 'dashboard',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_items_project
      ON project_items(project_id, kind, sort_order ASC, created_at DESC);

    CREATE TABLE IF NOT EXISTS library_items (
      id                   TEXT PRIMARY KEY,
      url                  TEXT NOT NULL UNIQUE,        -- canonicalized
      platform             TEXT NOT NULL,               -- 'x' | 'instagram'
      source               TEXT NOT NULL DEFAULT 'telegram', -- telegram|dashboard|bookmark_sync|dyi_export
      author_name          TEXT,
      author_handle        TEXT,
      caption              TEXT,
      posted_at            INTEGER,
      duration_s           REAL,
      media_type           TEXT,                        -- video|photo|carousel|text
      media_dir            TEXT,                        -- store/library/<id>/
      media_file           TEXT,                        -- main media filename within media_dir
      thumbnail_path       TEXT,
      oembed_html          TEXT,                        -- cached publish.twitter.com embed (X only)
      like_count           INTEGER,
      repost_count         INTEGER,
      comment_count        INTEGER,
      transcript           TEXT,
      transcript_segments  TEXT,                        -- JSON [{start,end,text}]
      tags                 TEXT,                        -- JSON string[]
      notes                TEXT,                        -- user note from share message
      analysis             TEXT,                        -- JSON {content_type,hook_summary,research_leads,research_item_id}
      project_id           TEXT,
      status               TEXT NOT NULL DEFAULT 'queued',
      -- queued|fetching_meta|downloading|transcribing|tagging|ready
      -- |failed_auth|failed_gone|failed_extract|failed_transcribe
      error                TEXT,
      retry_count          INTEGER NOT NULL DEFAULT 0,
      raw_metadata         TEXT,                        -- full yt-dlp/gallery-dl JSON
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_library_items_feed
      ON library_items(platform, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_library_items_status
      ON library_items(status);

    -- Content Library taxonomy: two levels (umbrella -> subcategory),
    -- many-to-many to items so one stored file can live in many folders.
    CREATE TABLE IF NOT EXISTS categories (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,            -- 'umbrella' | 'subcategory'
      parent_id   TEXT,                     -- null for umbrella; umbrella id for subcategory
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL,            -- normalized for matching/dedup
      description TEXT,                     -- helps the categorizer route + avoid dupes
      created_by  TEXT NOT NULL DEFAULT 'seed', -- seed | jarvis | user
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    -- Unique within scope: umbrellas unique by slug (parent_id IS NULL via the
    -- COALESCE), subcategories unique by (parent, slug).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_scope_slug
      ON categories(COALESCE(parent_id, ''), slug);
    CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id, sort_order);

    CREATE TABLE IF NOT EXISTS library_item_categories (
      item_id     TEXT NOT NULL,
      category_id TEXT NOT NULL,            -- the SUBcategory id (umbrella via its parent)
      is_primary  INTEGER NOT NULL DEFAULT 0,
      confidence  REAL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (item_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lic_category ON library_item_categories(category_id);
    CREATE INDEX IF NOT EXISTS idx_lic_item ON library_item_categories(item_id);

    -- Content Engine staged drafting (2026-06-10): brief first, script only
    -- after Gabe greenlights. One item can accumulate several drafts
    -- (different platforms / retakes); newest wins in the UI.
    CREATE TABLE IF NOT EXISTS content_drafts (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      track       TEXT NOT NULL,             -- 'ai' | 'real_world'
      platform    TEXT NOT NULL,             -- tiktok|youtube|instagram|x
      status      TEXT NOT NULL DEFAULT 'brief', -- brief|greenlit|scripted|rejected|failed
      brief       TEXT,                      -- JSON {hook,angle,beats[],key_facts[],why_now,format_notes}
      script      TEXT,                      -- full script text once scripted
      model_used  TEXT,
      error       TEXT,
      verification        TEXT,              -- JSON {claims:[{claim,verdict,sources,...}],summary} from the fact-checker
      verification_status TEXT,              -- none|running|done|failed
      publish_kit         TEXT,              -- JSON {title,caption,hashtags[],thumbnail_text} for upload time
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_content_drafts_item ON content_drafts(item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_drafts_status ON content_drafts(status, updated_at DESC);

    -- Edit Bay render jobs (E1 2026-06-10): the render worker turns library
    -- videos (and later raw anchor takes / faceless assemblies) into finished
    -- clips via whisper word timing + Remotion.
    CREATE TABLE IF NOT EXISTS render_jobs (
      id          TEXT PRIMARY KEY,
      item_id     TEXT,                      -- library item the render is based on
      kind        TEXT NOT NULL,             -- 'caption_clip' (E1) | future kinds
      status      TEXT NOT NULL DEFAULT 'queued', -- queued|preparing|rendering|ready|failed
      spec        TEXT,                      -- JSON {aspect,accent,...}
      output_file TEXT,                      -- absolute-relative store/renders/<id>/out.mp4
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status, created_at);

    -- Edit Projects (faceless workbench 2026-06-11): Gabe drives every video.
    -- A project = picked source clips + idea/message + script (labeled, never
    -- gated) + render direction + optional his-voice voiceover.
    CREATE TABLE IF NOT EXISTS edit_projects (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'idea', -- idea|approved|rendering|done|archived
      item_ids      TEXT,                  -- JSON string[] of library item ids
      idea_notes    TEXT,                  -- the message/idea worked out with Jarvis
      script        TEXT,                  -- script/overview text (voiceover or framing)
      script_labels TEXT,                  -- JSON claim verdicts (informational only)
      brief         TEXT,                  -- render direction for the Director
      aspect        TEXT NOT NULL DEFAULT '9:16',
      voiceover_file TEXT,                 -- store/edit-projects/<id>/<file>
      render_job_id TEXT,                  -- latest render job
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edit_projects_status ON edit_projects(status, updated_at DESC);

    -- Edge Scanner (2026-06-10): read-only prediction-market dislocation
    -- measurement. Kalshi = the only venue legally tradable from Ohio;
    -- Polymarket is scanned as a free fair-value signal feed only.
    -- edge_pairs: candidate/confirmed matches between a Kalshi market and a
    -- Polymarket market (heuristic match, optionally LLM-verified).
    CREATE TABLE IF NOT EXISTS edge_pairs (
      id               TEXT PRIMARY KEY,
      kalshi_ticker    TEXT NOT NULL,
      kalshi_title     TEXT,
      poly_condition_id TEXT NOT NULL,
      poly_question    TEXT,
      poly_event_slug  TEXT,
      category         TEXT,
      end_date         TEXT,
      match_score      REAL,
      llm_confidence   REAL,              -- null = not yet LLM-checked
      status           TEXT NOT NULL DEFAULT 'candidate',  -- candidate | confirmed | rejected
      invert           INTEGER NOT NULL DEFAULT 0,         -- 1 = poly YES maps to kalshi NO
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE (kalshi_ticker, poly_condition_id)
    );
    CREATE INDEX IF NOT EXISTS idx_edge_pairs_status ON edge_pairs(status, updated_at DESC);

    -- edge_opportunities: observed dislocations with lifecycle tracking.
    -- A row opens when first seen, gets last_seen/max refreshed while it
    -- persists, and closes when it disappears -> duration dataset for the
    -- go/no-go decision on live capital.
    CREATE TABLE IF NOT EXISTS edge_opportunities (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,     -- negrisk_yes | negrisk_no | xvenue | kalshi_intra | kalshi_spread
      ref         TEXT NOT NULL,     -- event slug / pair id / ticker (stable per opportunity source)
      title       TEXT,
      venue       TEXT,              -- polymarket | kalshi | cross
      category    TEXT,
      detail      TEXT,              -- JSON: legs, prices, fee flags, sizes
      gross_edge  REAL,              -- per-$1 contract (set), before fees
      net_edge    REAL,              -- after venue fee model (conservative)
      depth_usd   REAL,              -- null = unknown (no order-book depth in v1)
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      max_net_edge REAL,
      status      TEXT NOT NULL DEFAULT 'open',  -- open | closed
      closed_at   INTEGER,
      alerted_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_edge_opps_open ON edge_opportunities(status, kind, ref);
    CREATE INDEX IF NOT EXISTS idx_edge_opps_seen ON edge_opportunities(last_seen DESC);

    -- edge_stats: hourly snapshot for the dashboard chart.
    CREATE TABLE IF NOT EXISTS edge_stats (
      ts               INTEGER PRIMARY KEY,  -- hour bucket (epoch seconds)
      kalshi_markets   INTEGER,
      poly_events      INTEGER,
      pairs_candidate  INTEGER,
      pairs_confirmed  INTEGER,
      opps_open        INTEGER,
      opps_new         INTEGER,
      best_net_edge    REAL
    );

    -- edge_paper_trades: simulated fills against REAL Kalshi books. This is
    -- the go/no-go evidence: 4 weeks of honest fake-money P&L decides whether
    -- real capital ever gets funded. No order endpoint is ever called.
    CREATE TABLE IF NOT EXISTS edge_paper_trades (
      id              TEXT PRIMARY KEY,
      opportunity_id  TEXT,
      kalshi_ticker   TEXT NOT NULL,
      title           TEXT,
      category        TEXT,
      side            TEXT NOT NULL,      -- yes | no | arb (intra YES+NO pair)
      qty             INTEGER NOT NULL,
      entry_price     REAL NOT NULL,      -- per contract (arb: combined pair cost)
      entry_fee       REAL NOT NULL,      -- total entry fee (fee model)
      entry_poly_fair REAL,               -- Polymarket mid at entry (the thesis)
      edge_captured   REAL,               -- theoretical edge locked at entry
      opened_at       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',  -- open | closed | settled
      mark_price      REAL,
      marked_at       INTEGER,
      exit_price      REAL,
      exit_fee        REAL,
      exit_reason     TEXT,               -- convergence | settlement
      result          TEXT,               -- yes | no (settlement only)
      realized_pnl    REAL,
      closed_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_paper_status ON edge_paper_trades(status, opened_at DESC);

    -- AI agency lane (2026-06-10): client pipeline for Oswalt's AI Solutions.
    -- clients: one row per business in the pipeline (Good Nature first).
    CREATE TABLE IF NOT EXISTS clients (
      id              TEXT PRIMARY KEY,
      company         TEXT NOT NULL,
      contact_name    TEXT,
      contact_role    TEXT,
      contact_info    TEXT,
      industry        TEXT,
      location        TEXT,
      stage           TEXT NOT NULL DEFAULT 'lead',  -- lead | contacted | pitched | pilot | active | closed_won | closed_lost
      pain_points     TEXT,               -- freetext
      notes           TEXT,
      next_action     TEXT,
      next_action_due INTEGER,            -- epoch seconds
      monthly_value   REAL,               -- $/mo once active (real numbers only)
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage, updated_at DESC);

    -- client_artifacts: demos, proposals, ROI sheets produced for a client.
    CREATE TABLE IF NOT EXISTS client_artifacts (
      id          TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      kind        TEXT NOT NULL,      -- service_texts_demo | proposal | roi | note
      title       TEXT,
      content     TEXT,               -- JSON or markdown, per kind
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_client_artifacts ON client_artifacts(client_id, created_at DESC);

    -- usage_ledger: measured (not estimated) cloud-token burn, one row per
    -- model call ("leg"). Generic by design: scope+ref_id let ANY lane log
    -- here (deep_dive today; fact_check / render / edge_judge later) with no
    -- schema change. cost_weight = the model's output-price multiplier vs
    -- claude-fable-5 (=1.0) so totals can be cost-compared across models.
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      scope       TEXT NOT NULL,      -- 'deep_dive' | 'full_pitch' | 'demo_site' | future scopes
      ref_id      TEXT,               -- job/artifact id the leg belongs to
      leg         TEXT,               -- 'lens:reputation' | 'synthesis' | 'research' | ...
      model       TEXT,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      cost_weight REAL,
      duration_ms INTEGER,
      retries     INTEGER NOT NULL DEFAULT 0,
      meta        TEXT                -- JSON: raw usage breakdown, cost estimate, notes
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ledger ON usage_ledger(scope, ts DESC);

    -- psyop_scores: Chase Hughes NCI Engineered Reality Scoring System runs.
    -- Each row = one scored subject (claim/article/event). local_json = the
    -- abliterated first pass, final_json = the cloud-verified PsyopScoreResult.
    -- Additive, owned by the Psyop Scoring lane (see docs/RESUME-psyop.md).
    CREATE TABLE IF NOT EXISTS psyop_scores (
      id           TEXT PRIMARY KEY,
      subject      TEXT NOT NULL,        -- short label for what was scored
      input_text   TEXT,                 -- the text/claim that was scored
      source_url   TEXT,                 -- optional source link
      status       TEXT NOT NULL DEFAULT 'scoring', -- scoring | ready | failed
      total        INTEGER,              -- 20-100
      band         TEXT,                 -- low | moderate | strong | overwhelming
      local_json   TEXT,                 -- raw local (oracle) 20-item draft
      final_json   TEXT,                 -- verified PsyopScoreResult JSON
      model_local  TEXT,
      model_verify TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_psyop_scores ON psyop_scores(created_at DESC);

    CREATE TABLE IF NOT EXISTS social_accounts (
      platform      TEXT PRIMARY KEY,   -- 'x'
      user_id       TEXT,               -- platform user id
      handle        TEXT,
      access_token  TEXT NOT NULL,      -- encryptField()
      refresh_token TEXT,               -- encryptField()
      expires_at    INTEGER,            -- epoch seconds
      scopes        TEXT,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meet_sessions (
      id              TEXT PRIMARY KEY,         -- session id from the provider's join response
      agent_id        TEXT NOT NULL,            -- which agent is in the meeting
      meet_url        TEXT NOT NULL,
      bot_name        TEXT NOT NULL,
      platform        TEXT NOT NULL DEFAULT 'google_meet',
      provider        TEXT NOT NULL DEFAULT 'pika',  -- pika (avatar) | recall (voice-only)
      status          TEXT NOT NULL DEFAULT 'joining', -- joining | live | left | failed
      voice_id        TEXT,
      image_path      TEXT,                     -- avatar image used for this session (pika only)
      brief_path      TEXT,                     -- path to the frozen system prompt file
      created_at      INTEGER NOT NULL,
      joined_at       INTEGER,
      left_at         INTEGER,
      post_notes      TEXT,                     -- post-meeting notes, fetched after leave
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meet_status ON meet_sessions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_meet_agent ON meet_sessions(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS warroom_meetings (
      id          TEXT PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      duration_s  INTEGER,
      mode        TEXT NOT NULL DEFAULT 'direct',  -- direct | auto
      pinned_agent TEXT DEFAULT 'main',
      entry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_meetings_time ON warroom_meetings(started_at DESC);

    CREATE TABLE IF NOT EXISTS warroom_transcript (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  TEXT NOT NULL,
      speaker     TEXT NOT NULL,     -- 'user' | agent id | 'system'
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES warroom_meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_transcript_meeting ON warroom_transcript(meeting_id, created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL DEFAULT 'main',
      chat_id     TEXT NOT NULL DEFAULT '',
      action      TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '',
      blocked     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, created_at DESC);

    -- Per-workspace personalization (workspace name, hotkey mod, mission
    -- column order/widths, etc). Simple key/value with last-write-wins;
    -- no auth scoping because the dashboard token is the auth boundary.
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Append-only version history for agent files edited from the
    -- dashboard (CLAUDE.md, agent.yaml). Replaces the single-file .backup
    -- approach so the user can browse prior versions and restore any.
    -- file_kind is the editor's tab key ('claudemd' | 'agent-yaml').
    -- Content stored inline; size cap is enforced at the API layer
    -- (200KB for CLAUDE.md, 64KB for agent.yaml).
    CREATE TABLE IF NOT EXISTS agent_file_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      file_kind   TEXT NOT NULL,
      content     TEXT NOT NULL,
      byte_size   INTEGER NOT NULL,
      sha256      TEXT NOT NULL,
      author      TEXT NOT NULL DEFAULT 'dashboard',
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_file_history_lookup
      ON agent_file_history(agent_id, file_kind, created_at DESC);

    -- LLM-generated suggestions for spinning off specialized agents.
    -- The analyzer scans hive_mind activity grouped by agent_id and
    -- spots when one agent is doing several distinct domains that
    -- would benefit from being split. Each suggestion lives until the
    -- user dismisses it (sets dismissed_at) or acts on it. We keep
    -- dismissed rows so re-running analysis doesn't keep re-suggesting
    -- the same split — the analyzer skips parents+IDs that already
    -- have a non-superseded suggestion.
    CREATE TABLE IF NOT EXISTS agent_suggestions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent            TEXT NOT NULL,
      suggested_id          TEXT NOT NULL,
      suggested_name        TEXT NOT NULL,
      suggested_description TEXT NOT NULL,
      reasoning             TEXT NOT NULL,
      activity_share_pct    INTEGER,
      created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      dismissed_at          INTEGER,
      acted_at              INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_suggestions_active
      ON agent_suggestions(from_agent, created_at DESC)
      WHERE dismissed_at IS NULL AND acted_at IS NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      summary,
      raw_text,
      entities,
      topics,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
    END;

    -- Phase 2.4: Compaction event tracking
    CREATE TABLE IF NOT EXISTS compaction_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      pre_tokens  INTEGER NOT NULL DEFAULT 0,
      post_tokens INTEGER NOT NULL DEFAULT 0,
      turn_count  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_session ON compaction_events(session_id, created_at DESC);

    -- Phase 4.2: Skill health checks
    CREATE TABLE IF NOT EXISTS skill_health (
      skill_id    TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'unchecked',
      error_msg   TEXT NOT NULL DEFAULT '',
      last_check  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Phase 4.3: Skill usage analytics
    CREATE TABLE IF NOT EXISTS skill_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id    TEXT NOT NULL,
      chat_id     TEXT NOT NULL DEFAULT '',
      agent_id    TEXT NOT NULL DEFAULT 'main',
      triggered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      tokens_used INTEGER NOT NULL DEFAULT 0,
      succeeded   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_id, triggered_at DESC);

    -- Phase 6.2: Session summaries
    CREATE TABLE IF NOT EXISTS session_summaries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL UNIQUE,
      summary     TEXT NOT NULL,
      key_decisions TEXT NOT NULL DEFAULT '[]',
      turn_count  INTEGER NOT NULL DEFAULT 0,
      total_cost  REAL NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

export function initDatabase(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'claudeclaw.db');

  // Validate encryption key is available before proceeding
  getEncryptionKey();

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Wait up to 5s on write locks. Multiple agent processes (main + research +
  // comms + content + ops) run initDatabase() at startup; without this a
  // concurrent ALTER can throw SQLITE_BUSY on whichever process loses the race.
  db.pragma('busy_timeout = 5000');
  createSchema(db);
  runMigrations(db);

  // Restrict database file permissions (owner-only read/write)
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
    fs.chmodSync(STORE_DIR, 0o700);
  } catch { /* non-fatal on platforms that don't support chmod */ }
}

/**
 * Add a column to a table if it doesn't already exist. Tolerates the
 * concurrent-startup race where two agent processes both observe the column
 * as missing and both attempt the ALTER; whichever loses sees "duplicate
 * column" and treats it as a no-op.
 */
function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  typeAndDefault: string,
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
  } catch (err: any) {
    if (/duplicate column/i.test(err?.message ?? '')) return;
    throw err;
  }
}

/** Add columns that may not exist in older databases. */
function runMigrations(database: Database.Database): void {
  // Add context_tokens column to token_usage (introduced for accurate context tracking)
  const cols = database.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>;
  const hasContextTokens = cols.some((c) => c.name === 'context_tokens');
  if (!hasContextTokens) {
    database.exec(`ALTER TABLE token_usage ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0`);
  }

  // Workspace: link a mission task back to the project + research item it fills.
  addColumnIfMissing(database, 'mission_tasks', 'project_id', 'TEXT');
  addColumnIfMissing(database, 'mission_tasks', 'project_item_id', 'TEXT');

  // Content Engine: intent gate + track/platform + scoring on library items.
  addColumnIfMissing(database, 'library_items', 'intent', `TEXT`);            // content | build | reference
  addColumnIfMissing(database, 'library_items', 'track', `TEXT`);             // ai | real_world | null
  addColumnIfMissing(database, 'library_items', 'platforms', `TEXT`);         // JSON string[]: tiktok|youtube|instagram|x
  addColumnIfMissing(database, 'library_items', 'content_score', `INTEGER`);  // 0-100 strength as a content opportunity
  addColumnIfMissing(database, 'library_items', 'content_angle', `TEXT`);     // one-line hook/angle seed

  // Fact-checking on content drafts: per-claim verdicts from the research team.
  addColumnIfMissing(database, 'content_drafts', 'verification', `TEXT`);        // JSON {claims:[{claim,verdict,sources,...}],summary}
  addColumnIfMissing(database, 'content_drafts', 'verification_status', `TEXT`); // none|running|done|failed
  // Record Mode: per-platform upload metadata generated alongside the script.
  addColumnIfMissing(database, 'content_drafts', 'publish_kit', `TEXT`);         // JSON {title,caption,hashtags[],thumbnail_text}
  // Clustering: saves/sweeps about the SAME story share a cluster_id (the
  // anchor item's id); null = singleton.
  addColumnIfMissing(database, 'library_items', 'cluster_id', `TEXT`);

  // AI agency: outreach tracking on clients (Gabe's personal outreach run).
  // Touch history lives in client_artifacts (kind='outreach'); these columns
  // hold the at-a-glance state the list view filters/sorts on.
  addColumnIfMissing(database, 'clients', 'contacted_at', `INTEGER`);   // epoch s, first outgoing touch
  addColumnIfMissing(database, 'clients', 'replied_at', `INTEGER`);     // epoch s, latest reply from them
  addColumnIfMissing(database, 'clients', 'last_touch_at', `INTEGER`);  // epoch s, latest touch either direction
  addColumnIfMissing(database, 'clients', 'next_touch_at', `INTEGER`);  // epoch s, follow-up due date

  // Multi-agent: migrate sessions table to composite primary key (chat_id, agent_id)
  // Check if PK is composite by looking at pk column count in pragma
  const sessionCols = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; pk: number }>;
  const pkCount = sessionCols.filter((c) => c.pk > 0).length;
  if (pkCount < 2) {
    // Need to recreate table with composite PK
    database.exec(`
      CREATE TABLE sessions_new (
        chat_id    TEXT NOT NULL,
        agent_id   TEXT NOT NULL DEFAULT 'main',
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, agent_id)
      );
      INSERT OR IGNORE INTO sessions_new (chat_id, agent_id, session_id, updated_at)
        SELECT chat_id, COALESCE(agent_id, 'main'), session_id, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  }

  const taskCols = database.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
  }

  const usageCols = database.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>;
  if (!usageCols.some((c) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE token_usage ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
  }

  const convoCols = database.prepare(`PRAGMA table_info(conversation_log)`).all() as Array<{ name: string }>;
  if (!convoCols.some((c) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE conversation_log ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
  }

  // Phase 3 (2026-05-21): recovery_log dedupes one-time orphan-message
  // recovery notices. Without it, every restart would re-notify the user
  // about the same orphan.
  database.exec(`
    CREATE TABLE IF NOT EXISTS recovery_log (
      audit_id      INTEGER PRIMARY KEY,
      recovered_at  INTEGER NOT NULL
    )
  `);

  // Task state machine: add started_at and last_status columns
  const taskColNames = taskCols.map((c) => c.name);
  if (!taskColNames.includes('started_at')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN started_at INTEGER`);
  }
  if (!taskColNames.includes('last_status')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_status TEXT`);
  }

  // ── Memory V2 migration ──────────────────────────────────────────────
  // Detect old schema (has 'sector' column but no 'importance') and migrate.
  const memCols = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  const memColNames = memCols.map((c) => c.name);
  const isOldSchema = memColNames.includes('sector') && !memColNames.includes('importance');

  if (isOldSchema) {
    database.exec(`
      -- Drop old FTS triggers first
      DROP TRIGGER IF EXISTS memories_fts_insert;
      DROP TRIGGER IF EXISTS memories_fts_delete;
      DROP TRIGGER IF EXISTS memories_fts_update;

      -- Drop old FTS table
      DROP TABLE IF EXISTS memories_fts;

      -- Drop old indexes (they'll conflict with new table's indexes)
      DROP INDEX IF EXISTS idx_memories_chat;
      DROP INDEX IF EXISTS idx_memories_sector;

      -- Backup old memories table
      ALTER TABLE memories RENAME TO memories_v1_backup;

      -- Create new memories table
      CREATE TABLE memories (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'conversation',
        raw_text      TEXT NOT NULL,
        summary       TEXT NOT NULL,
        entities      TEXT NOT NULL DEFAULT '[]',
        topics        TEXT NOT NULL DEFAULT '[]',
        connections   TEXT NOT NULL DEFAULT '[]',
        importance    REAL NOT NULL DEFAULT 0.5,
        salience      REAL NOT NULL DEFAULT 1.0,
        consolidated  INTEGER NOT NULL DEFAULT 0,
        embedding     TEXT,
        created_at    INTEGER NOT NULL,
        accessed_at   INTEGER NOT NULL
      );

      CREATE INDEX idx_memories_chat ON memories(chat_id, created_at DESC);
      CREATE INDEX idx_memories_importance ON memories(chat_id, importance DESC);
      CREATE INDEX idx_memories_unconsolidated ON memories(chat_id, consolidated);

      -- Create consolidations table
      CREATE TABLE IF NOT EXISTS consolidations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       TEXT NOT NULL,
        source_ids    TEXT NOT NULL,
        summary       TEXT NOT NULL,
        insight       TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at DESC);

      -- Create new FTS table
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        summary,
        raw_text,
        entities,
        topics,
        content=memories,
        content_rowid=id
      );

      -- Create new triggers
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;

      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      END;

      CREATE TRIGGER memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    logger.info('Memory V2 migration: backed up old memories, created new schema');
  }

  // Ensure memory V2 indexes exist (covers both migrated and fresh installs)
  const memColsPost = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  if (memColsPost.some((c) => c.name === 'importance')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(chat_id, importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated ON memories(chat_id, consolidated);
    `);
  }

  // Add embedding column if missing (V2 tables created before embedding support)
  if (memColsPost.some((c) => c.name === 'importance') && !memColsPost.some((c) => c.name === 'embedding')) {
    database.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT`);
    logger.info('Migration: added embedding column to memories table');
  }

  // Hive Mind V2: Add agent_id to memories for attribution
  if (!memColsPost.some((c: { name: string }) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
    logger.info('Migration: added agent_id column to memories table');
  }

  // Hive Mind V2: Add embedding + model tracking to consolidations
  const consolCols = database.prepare('PRAGMA table_info(consolidations)').all() as Array<{ name: string }>;
  if (!consolCols.some((c) => c.name === 'embedding')) {
    database.exec(`ALTER TABLE consolidations ADD COLUMN embedding TEXT`);
    logger.info('Migration: added embedding column to consolidations table');
  }
  if (!consolCols.some((c) => c.name === 'embedding_model')) {
    database.exec(`ALTER TABLE consolidations ADD COLUMN embedding_model TEXT DEFAULT 'embedding-001'`);
  }

  // Add embedding_model to memories too (future-proofing)
  if (!memColsPost.some((c: { name: string }) => c.name === 'embedding_model')) {
    database.exec(`ALTER TABLE memories ADD COLUMN embedding_model TEXT DEFAULT 'embedding-001'`);
  }

  // Hive Mind V2: Fix FTS5 update trigger to only fire on content column changes.
  // The old trigger fires on every UPDATE (including salience/importance-only changes),
  // causing massive write amplification during decay sweeps.
  const triggerCheck = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_fts_update'`,
  ).get() as { sql: string } | undefined;
  if (triggerCheck?.sql && !triggerCheck.sql.includes('UPDATE OF')) {
    database.exec(`
      DROP TRIGGER IF EXISTS memories_fts_update;
      CREATE TRIGGER memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    logger.info('Migration: restricted FTS5 update trigger to content columns only');
  }

  // Hive Mind V2: Add superseded_by for contradiction resolution
  if (!memColsPost.some((c: { name: string }) => c.name === 'superseded_by')) {
    database.exec(`ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id)`);
    logger.info('Migration: added superseded_by column to memories table');
  }

  // Hive Mind V2: Add pinned flag for permanent memories that never decay.
  // Memories are only pinned explicitly by the user ("remember this permanently")
  // or via /pin command. No auto-pinning: the user controls what's permanent.
  if (!memColsPost.some((c: { name: string }) => c.name === 'pinned')) {
    database.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    logger.info('Migration: added pinned column to memories table');
  }

  // Mission Control: migrate assigned_agent from NOT NULL to nullable (allow unassigned tasks)
  const missionCols = database.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string; notnull: number }>;
  const assignedCol = missionCols.find((c) => c.name === 'assigned_agent');
  if (assignedCol && assignedCol.notnull === 1) {
    database.exec(`
      CREATE TABLE mission_tasks_new (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        assigned_agent TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, created_by TEXT NOT NULL DEFAULT 'dashboard',
        priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER
      );
      INSERT INTO mission_tasks_new SELECT * FROM mission_tasks;
      DROP TABLE mission_tasks;
      ALTER TABLE mission_tasks_new RENAME TO mission_tasks;
      CREATE INDEX IF NOT EXISTS idx_mission_status
        ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);
    `);
    logger.info('Migration: made mission_tasks.assigned_agent nullable');
  }

  // Live Meetings: add provider column so we can track which platform
  // each session used (pika avatar vs recall voice-only). Default 'pika'
  // for existing rows so historical data keeps the right label.
  const meetCols = database.prepare(`PRAGMA table_info(meet_sessions)`).all() as Array<{ name: string }>;
  if (meetCols.length > 0 && !meetCols.some((c) => c.name === 'provider')) {
    database.exec(`ALTER TABLE meet_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'pika'`);
    logger.info('Migration: added provider column to meet_sessions');
  }

  // Text War Room: tag each meeting as voice or text so existing voice rows
  // stay untouched and the dashboard can filter. The existing `mode` column
  // on warroom_meetings is voice-only semantics (direct|auto) and can't
  // double as meeting-type.
  addColumnIfMissing(database, 'warroom_meetings', 'meeting_type', `TEXT NOT NULL DEFAULT 'voice'`);

  // Text War Room hive-mind: chat_id on warroom_meetings so a text meeting
  // knows which Telegram chat owns it, separately from the synthetic
  // SDK session key (`warroom-text:${meetingId}`). Memory/missions/conv-log
  // calls inside runAgentTurn use this real chat_id; legacy rows default
  // to '' and the bridge no-ops for them.
  addColumnIfMissing(database, 'warroom_meetings', 'chat_id', `TEXT NOT NULL DEFAULT ''`);

  // Text War Room hive-mind: tag conversation_log rows that originated from
  // the war room so they can be deduped on retry and so memory ingestion
  // can scope by source if needed. Existing Telegram rows default to
  // 'telegram'. source_meeting_id + source_turn_id back the partial unique
  // indexes below, which guard against double-persistence on retries.
  addColumnIfMissing(database, 'conversation_log', 'source', `TEXT NOT NULL DEFAULT 'telegram'`);
  addColumnIfMissing(database, 'conversation_log', 'source_meeting_id', `TEXT`);
  addColumnIfMissing(database, 'conversation_log', 'source_turn_id', `TEXT`);

  // Two partial unique indexes so a multi-agent slash turn (which produces
  // ONE user prompt + N assistant rows under one source_turn_id) doesn't
  // collide on retry. User row keyed without agent_id (singleton per turn);
  // assistant rows keyed WITH agent_id (one per speaking agent).
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_convlog_warroom_user
      ON conversation_log(source, source_meeting_id, source_turn_id)
      WHERE source != 'telegram' AND role = 'user';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_convlog_warroom_assistant
      ON conversation_log(source, source_meeting_id, source_turn_id, agent_id)
      WHERE source != 'telegram' AND role = 'assistant';
  `);
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  // Use a test encryption key for field-level encryption
  encryptionKey = crypto.randomBytes(32);
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  createSchema(db);
  runMigrations(db);
}

/**
 * Test-only: backdate a war-room meeting's `ended_at` so retention sweep
 * tests don't have to wait real wall-clock time. Marked with the `_test`
 * prefix consistent with other test-only exports.
 */
export function _testBackdateMeetingEnd(meetingId: string, endedAtSec: number): void {
  db.prepare('UPDATE warroom_meetings SET ended_at = ? WHERE id = ?')
    .run(endedAtSec, meetingId);
}

export function getSession(chatId: string, agentId = 'main'): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ? AND agent_id = ?')
    .get(chatId, agentId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(chatId: string, sessionId: string, agentId = 'main'): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, agent_id, session_id, updated_at) VALUES (?, ?, ?, ?)',
  ).run(chatId, agentId, sessionId, new Date().toISOString());
}

export function clearSession(chatId: string, agentId = 'main'): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ? AND agent_id = ?').run(chatId, agentId);
}

// ── Memory (V2: structured with LLM extraction) ────────────────────

export interface Memory {
  id: number;
  chat_id: string;
  source: string;
  agent_id: string;
  raw_text: string;
  summary: string;
  entities: string;    // JSON array
  topics: string;      // JSON array
  connections: string; // JSON array
  importance: number;
  salience: number;
  consolidated: number;
  pinned: number;      // 1 = permanent, never decays
  embedding: string | null; // JSON array of floats
  created_at: number;
  accessed_at: number;
}

export interface Consolidation {
  id: number;
  chat_id: string;
  source_ids: string;  // JSON array of memory IDs
  summary: string;
  insight: string;
  created_at: number;
  embedding?: string;
  embedding_model?: string;
}

export function saveStructuredMemory(
  chatId: string,
  rawText: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  source = 'conversation',
  agentId = 'main',
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO memories (chat_id, source, raw_text, summary, entities, topics, importance, agent_id, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    source,
    rawText,
    summary,
    JSON.stringify(entities),
    JSON.stringify(topics),
    importance,
    agentId,
    now,
    now,
  );
  return result.lastInsertRowid as number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'it', 'its', 'my', 'me', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'they', 'them', 'their', 'i', 'up',
  'down', 'get', 'got', 'like', 'make', 'know', 'think', 'take',
  'come', 'go', 'see', 'look', 'find', 'give', 'tell', 'say',
  'much', 'many', 'well', 'also', 'back', 'use', 'way',
  'feel', 'mark', 'marks', 'does', 'how',
]);

/**
 * Extract meaningful keywords from a query, stripping stop words and short tokens.
 */
function extractKeywords(query: string): string[] {
  return query
    .replace(/[""]/g, '"')
    .replace(/[^\w\s]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Search memories using embedding similarity (primary) with FTS5/LIKE fallback.
 * The queryEmbedding parameter is optional; if provided, vector search is used first.
 * If not provided (or no embeddings in DB), falls back to keyword search.
 * When `agentId` is supplied, results are strictly scoped to that agent so
 * one agent never sees another agent's private memories.
 */
export function searchMemories(
  chatId: string,
  query: string,
  limit = 5,
  queryEmbedding?: number[],
  agentId?: string,
): Memory[] {
  // Strategy 1: Vector similarity search (if embedding provided)
  if (queryEmbedding && queryEmbedding.length > 0) {
    const candidates = getMemoriesWithEmbeddings(chatId, agentId);
    if (candidates.length > 0) {
      const scored = candidates
        .map((c) => ({ id: c.id, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .filter((s) => s.score > 0.3) // minimum similarity threshold
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length > 0) {
        const ids = scored.map((s) => s.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND superseded_by IS NULL`)
          .all(...ids) as Memory[];
        // Preserve similarity-score ordering (SQL IN doesn't guarantee order)
        const rowMap = new Map(rows.map((r) => [r.id, r]));
        return ids.map((id) => rowMap.get(id)).filter(Boolean) as Memory[];
      }
    }
  }

  // Strategy 2: FTS5 keyword search with OR
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Strip double-quotes from each keyword before wrapping it as an FTS5
  // phrase. Without this, a keyword like `"foo` would produce the
  // malformed fragment `""foo"*` and FTS5 would either error out or, in
  // the worst case, interpret attacker-controlled characters as query
  // operators. Belt-and-braces on top of extractKeywords' own filtering.
  const ftsQuery = keywords.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  const ftsAgentClause = agentId ? ' AND memories.agent_id = ?' : '';
  const ftsParams: unknown[] = [ftsQuery, chatId];
  if (agentId) ftsParams.push(agentId);
  ftsParams.push(limit);
  let results = db
    .prepare(
      `SELECT memories.* FROM memories
       JOIN memories_fts ON memories.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND memories.chat_id = ? AND memories.superseded_by IS NULL${ftsAgentClause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...ftsParams) as Memory[];

  if (results.length > 0) return results;

  // Strategy 3: LIKE fallback on summary + entities + topics
  const likeConditions = keywords.map(() =>
    `(summary LIKE ? OR entities LIKE ? OR topics LIKE ? OR raw_text LIKE ?)`,
  ).join(' OR ');
  const likeParams: string[] = [];
  for (const kw of keywords) {
    const pattern = `%${kw}%`;
    likeParams.push(pattern, pattern, pattern, pattern);
  }

  const likeAgentClause = agentId ? ' AND agent_id = ?' : '';
  const likeAllParams: unknown[] = [chatId, ...likeParams];
  if (agentId) likeAllParams.push(agentId);
  likeAllParams.push(limit);
  results = db
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ? AND superseded_by IS NULL AND (${likeConditions})${likeAgentClause}
       ORDER BY importance DESC, accessed_at DESC
       LIMIT ?`,
    )
    .all(...likeAllParams) as Memory[];

  return results;
}

export function saveMemoryEmbedding(memoryId: number, embedding: number[]): void {
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), memoryId);
}

/**
 * Atomically save a structured memory and its embedding in a single transaction.
 * If either step fails, both are rolled back.
 */
export function saveStructuredMemoryAtomic(
  chatId: string,
  rawText: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  embedding: number[],
  source = 'conversation',
  agentId = 'main',
): number {
  const txn = db.transaction(() => {
    const memoryId = saveStructuredMemory(chatId, rawText, summary, entities, topics, importance, source, agentId);
    if (embedding.length > 0) {
      saveMemoryEmbedding(memoryId, embedding);
    }
    return memoryId;
  });
  return txn();
}

export function getMemoriesWithEmbeddings(
  chatId: string,
  agentId?: string,
): Array<{ id: number; embedding: number[]; summary: string; importance: number }> {
  const sql = agentId
    ? 'SELECT id, embedding, summary, importance FROM memories WHERE chat_id = ? AND agent_id = ? AND embedding IS NOT NULL AND superseded_by IS NULL'
    : 'SELECT id, embedding, summary, importance FROM memories WHERE chat_id = ? AND embedding IS NOT NULL AND superseded_by IS NULL';
  const params = agentId ? [chatId, agentId] : [chatId];
  const rows = db
    .prepare(sql)
    .all(...params) as Array<{ id: number; embedding: string; summary: string; importance: number }>;
  return rows.map((r) => ({
    id: r.id,
    embedding: JSON.parse(r.embedding) as number[],
    summary: r.summary,
    importance: r.importance,
  }));
}

export function getRecentHighImportanceMemories(
  chatId: string,
  limit = 5,
  agentId?: string,
): Memory[] {
  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM memories WHERE chat_id = ? AND agent_id = ? AND importance >= 0.5
         ORDER BY accessed_at DESC LIMIT ?`,
      )
      .all(chatId, agentId, limit) as Memory[];
  }
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND importance >= 0.5
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getRecentMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      'SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?',
    )
    .all(chatId, limit) as Memory[];
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?',
  ).run(now, id);
}

export function penalizeMemory(memoryId: number): void {
  db.prepare(
    `UPDATE memories SET salience = MAX(0.05, salience - 0.05) WHERE id = ?`,
  ).run(memoryId);
}

/**
 * Batch-update salience for multiple memories in a single transaction.
 * Reduces SQLite lock contention when multiple agents finish concurrently.
 */
export function batchUpdateMemoryRelevance(
  allIds: number[],
  usefulIds: Set<number>,
): void {
  const txn = db.transaction(() => {
    for (const id of allIds) {
      if (usefulIds.has(id)) {
        touchMemory(id);
      } else {
        penalizeMemory(id);
      }
    }
  });
  txn();
}

/**
 * Importance-weighted decay. High-importance memories decay slower.
 * Pinned memories are exempt from decay entirely.
 * - pinned:             no decay (permanent)
 * - importance >= 0.8:  1% per day (retains ~460 days)
 * - importance >= 0.5:  2% per day (retains ~230 days)
 * - importance < 0.5:   5% per day (retains ~90 days)
 */
export function decayMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  db.prepare(`
    UPDATE memories SET salience = salience * CASE
      WHEN importance >= 0.8 THEN 0.99
      WHEN importance >= 0.5 THEN 0.98
      ELSE 0.95
    END
    WHERE created_at < ? AND pinned = 0
  `).run(oneDayAgo);
  // Clear superseded_by references pointing to memories we're about to delete,
  // otherwise the FOREIGN KEY constraint on superseded_by -> memories(id) fails.
  db.prepare(`
    UPDATE memories SET superseded_by = NULL
    WHERE superseded_by IN (SELECT id FROM memories WHERE salience < 0.05 AND pinned = 0)
  `).run();
  db.prepare('DELETE FROM memories WHERE salience < 0.05 AND pinned = 0').run();
}

export function pinMemory(memoryId: number): void {
  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(memoryId);
}

export function unpinMemory(memoryId: number): void {
  db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(memoryId);
}

// ── Consolidation CRUD ──────────────────────────────────────────────

export function getUnconsolidatedMemories(chatId: string, limit = 20): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND consolidated = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function saveConsolidation(
  chatId: string,
  sourceIds: number[],
  summary: string,
  insight: string,
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO consolidations (chat_id, source_ids, summary, insight, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, JSON.stringify(sourceIds), summary, insight, now);
  return result.lastInsertRowid as number;
}

export function saveConsolidationEmbedding(consolidationId: number, embedding: number[]): void {
  db.prepare('UPDATE consolidations SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(JSON.stringify(embedding), 'embedding-001', consolidationId);
}

export function getConsolidationsWithEmbeddings(chatId: string): Array<{ id: number; embedding: number[]; summary: string; insight: string }> {
  const rows = db
    .prepare('SELECT id, embedding, summary, insight FROM consolidations WHERE chat_id = ? AND embedding IS NOT NULL AND embedding_model = ?')
    .all(chatId, 'embedding-001') as Array<{ id: number; embedding: string; summary: string; insight: string }>;
  return rows.map((r) => ({ ...r, embedding: JSON.parse(r.embedding) as number[] }));
}

export function supersedeMemory(oldId: number, newId: number): void {
  db.prepare(
    `UPDATE memories SET superseded_by = ?, importance = importance * 0.3, salience = salience * 0.5 WHERE id = ?`,
  ).run(newId, oldId);
}

export function updateMemoryConnections(memoryId: number, connections: Array<{ linked_to: number; relationship: string }>): void {
  const row = db.prepare('SELECT connections FROM memories WHERE id = ?').get(memoryId) as { connections: string } | undefined;
  if (!row) return;
  const existing: Array<{ linked_to: number; relationship: string }> = JSON.parse(row.connections);
  const merged = [...existing, ...connections];
  // Deduplicate by linked_to to prevent unbounded growth on re-consolidation
  const seen = new Set<number>();
  const deduped = merged.filter((c) => {
    if (seen.has(c.linked_to)) return false;
    seen.add(c.linked_to);
    return true;
  });
  db.prepare('UPDATE memories SET connections = ? WHERE id = ?').run(JSON.stringify(deduped), memoryId);
}

export function markMemoriesConsolidated(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE memories SET consolidated = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Atomically save a consolidation, wire connections, handle contradictions,
 * and mark source memories as consolidated. If any step fails, all roll back.
 */
export function saveConsolidationAtomic(
  chatId: string,
  sourceIds: number[],
  summary: string,
  insight: string,
  connections: Array<{ from_id: number; to_id: number; relationship: string }>,
  contradictions: Array<{ stale_id: number; superseded_by: number }>,
): number {
  const txn = db.transaction(() => {
    const consolidationId = saveConsolidation(chatId, sourceIds, summary, insight);

    for (const conn of connections) {
      updateMemoryConnections(conn.from_id, [
        { linked_to: conn.to_id, relationship: conn.relationship },
      ]);
      updateMemoryConnections(conn.to_id, [
        { linked_to: conn.from_id, relationship: conn.relationship },
      ]);
    }

    for (const contra of contradictions) {
      supersedeMemory(contra.stale_id, contra.superseded_by);
    }

    markMemoriesConsolidated(sourceIds);
    return consolidationId;
  });
  return txn();
}

export function getRecentConsolidations(chatId: string, limit = 5): Consolidation[] {
  return db
    .prepare(
      `SELECT * FROM consolidations WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Consolidation[];
}

export function searchConsolidations(chatId: string, query: string, limit = 3): Consolidation[] {
  // Simple LIKE search on consolidation summaries and insights
  const pattern = `%${query.replace(/[%_]/g, '')}%`;
  return db
    .prepare(
      `SELECT * FROM consolidations
       WHERE chat_id = ? AND (summary LIKE ? OR insight LIKE ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, pattern, pattern, limit) as Consolidation[];
}

// ── Scheduled Tasks ──────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent_id: string;
  started_at: number | null;
  last_status: 'success' | 'failed' | 'timeout' | null;
}

export function createScheduledTask(
  id: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  agentId = 'main',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, prompt, schedule, nextRun, now, agentId);
}

export function getDueTasks(agentId = 'main'): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ? AND agent_id = ? ORDER BY next_run`,
    )
    .all(now, agentId) as ScheduledTask[];
}

export function getAllScheduledTasks(agentId?: string): ScheduledTask[] {
  if (agentId) {
    return db
      .prepare('SELECT * FROM scheduled_tasks WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId) as ScheduledTask[];
  }
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

/**
 * Mark a task as running and optionally advance its next_run to the next
 * scheduled occurrence. Advancing next_run immediately prevents the scheduler
 * from re-firing the same task on subsequent ticks while it is still executing
 * (double-fire bug), and survives process restarts since the value is persisted.
 */
export function markTaskRunning(id: string, tentativeNextRun?: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (tentativeNextRun !== undefined) {
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'running', started_at = ?, next_run = ? WHERE id = ?`,
    ).run(now, tentativeNextRun, id);
  } else {
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(now, id);
  }
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
  lastStatus: 'success' | 'failed' | 'timeout' = 'success',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE scheduled_tasks SET status = 'active', last_run = ?, next_run = ?, last_result = ?, last_status = ?, started_at = NULL WHERE id = ?`,
  ).run(now, nextRun, result.slice(0, 4000), lastStatus, id);
}

export function resetStuckTasks(agentId: string): number {
  const result = db.prepare(
    `UPDATE scheduled_tasks SET status = 'active', started_at = NULL WHERE status = 'running' AND agent_id = ?`,
  ).run(agentId);
  return result.changes;
}

export function deleteScheduledTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Patch the editable fields of a scheduled task. Caller is responsible
 * for recomputing next_run when schedule changes. Pass `undefined` to
 * skip a field; pass a value to update it.
 */
export function updateScheduledTask(
  id: string,
  patch: { prompt?: string; schedule?: string; nextRun?: number; agentId?: string },
): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.prompt !== undefined) { sets.push('prompt = ?'); vals.push(patch.prompt); }
  if (patch.schedule !== undefined) { sets.push('schedule = ?'); vals.push(patch.schedule); }
  if (patch.nextRun !== undefined) { sets.push('next_run = ?'); vals.push(patch.nextRun); }
  if (patch.agentId !== undefined) { sets.push('agent_id = ?'); vals.push(patch.agentId); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function pauseScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?`).run(id);
}

export function resumeScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'active' WHERE id = ?`).run(id);
}

/**
 * Get recent scheduled task outputs for a given agent.
 * Used to inject context into the next user message so Claude knows
 * what was just shown to the user via a scheduled task.
 *
 * Returns tasks that ran in the last `withinMinutes` (default 30).
 */
export function getRecentTaskOutputs(
  agentId: string,
  withinMinutes = 30,
): Array<{ prompt: string; last_result: string; last_run: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
  return db
    .prepare(
      `SELECT prompt, last_result, last_run FROM scheduled_tasks
       WHERE agent_id = ? AND last_status = 'success' AND last_run > ?
       ORDER BY last_run DESC LIMIT 3`,
    )
    .all(agentId, cutoff) as Array<{ prompt: string; last_result: string; last_run: number }>;
}

// ── WhatsApp message map ──────────────────────────────────────────────

export function saveWaMessageMap(telegramMsgId: number, waChatId: string, contactName: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO wa_message_map (telegram_msg_id, wa_chat_id, contact_name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(telegramMsgId, waChatId, contactName, now);
}

export function lookupWaChatId(telegramMsgId: number): { waChatId: string; contactName: string } | null {
  const row = db
    .prepare('SELECT wa_chat_id, contact_name FROM wa_message_map WHERE telegram_msg_id = ?')
    .get(telegramMsgId) as { wa_chat_id: string; contact_name: string } | undefined;
  if (!row) return null;
  return { waChatId: row.wa_chat_id, contactName: row.contact_name };
}

export function getRecentWaContacts(limit = 20): Array<{ waChatId: string; contactName: string; lastSeen: number }> {
  const rows = db.prepare(
    `SELECT wa_chat_id, contact_name, MAX(created_at) as lastSeen
     FROM wa_message_map
     GROUP BY wa_chat_id
     ORDER BY lastSeen DESC
     LIMIT ?`,
  ).all(limit) as Array<{ wa_chat_id: string; contact_name: string; lastSeen: number }>;
  return rows.map((r) => ({ waChatId: r.wa_chat_id, contactName: r.contact_name, lastSeen: r.lastSeen }));
}

// ── WhatsApp outbox ──────────────────────────────────────────────────

export interface WaOutboxItem {
  id: number;
  to_chat_id: string;
  body: string;
  created_at: number;
}

export function enqueueWaMessage(toChatId: string, body: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO wa_outbox (to_chat_id, body, created_at) VALUES (?, ?, ?)`,
  ).run(toChatId, encryptField(body), now);
  return result.lastInsertRowid as number;
}

export function getPendingWaMessages(): WaOutboxItem[] {
  const rows = db.prepare(
    `SELECT id, to_chat_id, body, created_at FROM wa_outbox WHERE sent_at IS NULL ORDER BY created_at`,
  ).all() as WaOutboxItem[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

export function markWaMessageSent(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE wa_outbox SET sent_at = ? WHERE id = ?`).run(now, id);
}

// ── WhatsApp messages ────────────────────────────────────────────────

/**
 * Prune WhatsApp messages older than the given number of days.
 * Covers wa_messages, wa_outbox (sent only), and wa_message_map.
 */
export function pruneWaMessages(retentionDays = 3): { messages: number; outbox: number; map: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;

  const msgResult = db.prepare(
    'DELETE FROM wa_messages WHERE created_at < ?',
  ).run(cutoff);

  const outboxResult = db.prepare(
    'DELETE FROM wa_outbox WHERE sent_at IS NOT NULL AND created_at < ?',
  ).run(cutoff);

  const mapResult = db.prepare(
    'DELETE FROM wa_message_map WHERE created_at < ?',
  ).run(cutoff);

  return {
    messages: msgResult.changes,
    outbox: outboxResult.changes,
    map: mapResult.changes,
  };
}

/**
 * Prune Slack messages older than the given number of days.
 */
export function pruneSlackMessages(retentionDays = 3): number {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const result = db.prepare(
    'DELETE FROM slack_messages WHERE created_at < ?',
  ).run(cutoff);
  return result.changes;
}

// ── Conversation Log ──────────────────────────────────────────────────

export interface ConversationTurn {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

export function logConversationTurn(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  sessionId?: string,
  agentId = 'main',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO conversation_log (chat_id, session_id, role, content, created_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, role, content, now, agentId);
}

export function getRecentConversation(
  chatId: string,
  limit = 20,
  agentId?: string,
): ConversationTurn[] {
  // IMPORTANT: filter by agent_id too. Without this, /respin in the main
  // agent bleeds in turns from research/comms/content/ops that share the
  // same chat_id, producing respins contaminated with other agents'
  // conversations. Reported by Benjamin Elkrieff in April 2026.
  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND agent_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(chatId, agentId, limit) as ConversationTurn[];
  }
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Search conversation_log by keywords. Used when the user asks about
 * past conversations ("remember when we...", "what did we talk about").
 * Returns recent turns that match any keyword, grouped chronologically.
 */
export function searchConversationHistory(
  chatId: string,
  query: string,
  agentId?: string,
  daysBack = 7,
  limit = 20,
): ConversationTurn[] {
  const cutoff = Math.floor(Date.now() / 1000) - (daysBack * 86400);
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 8);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
  const params: (string | number)[] = [chatId, cutoff];
  for (const kw of keywords) {
    params.push(`%${kw}%`);
  }

  const agentFilter = agentId ? ' AND agent_id = ?' : '';
  if (agentId) params.push(agentId);

  return db
    .prepare(
      `SELECT * FROM conversation_log
       WHERE chat_id = ? AND created_at > ? AND (${conditions})${agentFilter}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as ConversationTurn[];
}

/**
 * Get a page of conversation turns for the dashboard chat overlay.
 * Returns turns in reverse chronological order (newest first).
 * Use `beforeId` for cursor-based pagination (load older messages).
 */
export function getConversationPage(
  chatId: string,
  limit = 40,
  beforeId?: number,
): ConversationTurn[] {
  // Exclude specialist:* turns from the user-facing chat view. Specialists
  // log their own (full prompt, full response) under agent_id =
  // 'specialist:<callsign>' for memory + history bookkeeping, but the
  // logged prompt is the bloated memory-context preamble we built
  // upstream and is NOT meant to render as a chat bubble. The /chat tab
  // should only show the conversation between the user and the main agent.
  if (beforeId) {
    return db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND id < ?
           AND (agent_id IS NULL OR agent_id NOT LIKE 'specialist:%')
         ORDER BY id DESC LIMIT ?`,
      )
      .all(chatId, beforeId, limit) as ConversationTurn[];
  }
  return db
    .prepare(
      `SELECT * FROM conversation_log
       WHERE chat_id = ?
         AND (agent_id IS NULL OR agent_id NOT LIKE 'specialist:%')
       ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Prune old conversation_log entries, keeping only the most recent N rows
 * per (chat_id, agent_id) pair. Scoping by agent matters because all five
 * agents share the same chat_id in a typical install, and a chatty agent
 * could otherwise evict a quieter agent's history under the shared cap.
 * Wrapped in a transaction so a mid-loop crash can't leave the table in a
 * half-pruned state.
 */
export function pruneConversationLog(keepPerChat = 500): void {
  const pairs = db
    .prepare('SELECT DISTINCT chat_id, agent_id FROM conversation_log')
    .all() as Array<{ chat_id: string; agent_id: string }>;

  const deleteStmt = db.prepare(`
    DELETE FROM conversation_log
    WHERE chat_id = ? AND agent_id = ? AND id NOT IN (
      SELECT id FROM conversation_log
      WHERE chat_id = ? AND agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `);

  const runAll = db.transaction((rows: typeof pairs) => {
    for (const row of rows) {
      deleteStmt.run(row.chat_id, row.agent_id, row.chat_id, row.agent_id, keepPerChat);
    }
  });
  runAll(pairs);
}

/**
 * Retention sweep for ended war-room meetings + their transcripts.
 *
 * Why this exists: warroom_meetings + warroom_transcript were not touched
 * by the original decay sweep. Long-running installs accumulate every
 * meeting indefinitely; transcripts can be hundreds of rows each. Cap at
 * `retentionDays` since `ended_at` (default 90). Active meetings (no
 * `ended_at`) are never pruned.
 *
 * Cascading: deleting a `warroom_meetings` row removes its
 * `warroom_transcript` rows via the FK ON DELETE CASCADE. We also clear
 * matching `conversation_log` rows tagged with the meeting's ID so the
 * "delete a meeting actually deletes its content" promise holds.
 */
export function pruneWarRoomMeetings(retentionDays = 90): { meetings: number; convLog: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  return db.transaction(() => {
    const expired = db
      .prepare(`SELECT id FROM warroom_meetings WHERE ended_at IS NOT NULL AND ended_at < ?`)
      .all(cutoff) as Array<{ id: string }>;
    if (expired.length === 0) return { meetings: 0, convLog: 0 };
    const ids = expired.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    const convDel = db
      .prepare(`DELETE FROM conversation_log WHERE source_meeting_id IN (${placeholders})`)
      .run(...ids);
    // warroom_transcript rows go via the FK cascade on warroom_meetings.
    const meetDel = db
      .prepare(`DELETE FROM warroom_meetings WHERE id IN (${placeholders})`)
      .run(...ids);

    return {
      meetings: Number(meetDel.changes),
      convLog: Number(convDel.changes),
    };
  })();
}

// ── WhatsApp messages ────────────────────────────────────────────────

export function saveWaMessage(
  chatId: string,
  contactName: string,
  body: string,
  timestamp: number,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO wa_messages (chat_id, contact_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, contactName, encryptField(body), timestamp, isFromMe ? 1 : 0, now);
}

export interface WaMessageRow {
  id: number;
  chat_id: string;
  contact_name: string;
  body: string;
  timestamp: number;
  is_from_me: number;
  created_at: number;
}

export function getRecentWaMessages(chatId: string, limit = 20): WaMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM wa_messages WHERE chat_id = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatId, limit) as WaMessageRow[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

// ── Slack messages ────────────────────────────────────────────────

export function saveSlackMessage(
  channelId: string,
  channelName: string,
  userName: string,
  body: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO slack_messages (channel_id, channel_name, user_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(channelId, channelName, userName, encryptField(body), timestamp, isFromMe ? 1 : 0, now);
}

export interface SlackMessageRow {
  id: number;
  channel_id: string;
  channel_name: string;
  user_name: string;
  body: string;
  timestamp: string;
  is_from_me: number;
  created_at: number;
}

export function getRecentSlackMessages(channelId: string, limit = 20): SlackMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM slack_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as SlackMessageRow[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

// ── Token Usage ──────────────────────────────────────────────────────

export function saveTokenUsage(
  chatId: string,
  sessionId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  contextTokens: number,
  costUsd: number,
  didCompact: boolean,
  agentId = 'main',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO token_usage (chat_id, session_id, input_tokens, output_tokens, cache_read, context_tokens, cost_usd, did_compact, created_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, inputTokens, outputTokens, cacheRead, contextTokens, costUsd, didCompact ? 1 : 0, now, agentId);
}

export interface SessionTokenSummary {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastCacheRead: number;
  lastContextTokens: number;
  totalCostUsd: number;
  compactions: number;
  firstTurnAt: number;
  lastTurnAt: number;
}

// ── Dashboard Queries ──────────────────────────────────────────────────

export interface DashboardMemoryStats {
  total: number;
  pinned: number;
  consolidations: number;
  avgImportance: number;
  avgSalience: number;
  importanceDistribution: { bucket: string; count: number }[];
}

export function getDashboardMemoryStats(chatId: string): DashboardMemoryStats {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         AVG(importance) as avgImportance,
         AVG(salience) as avgSalience
       FROM memories WHERE chat_id = ?`,
    )
    .get(chatId) as { total: number; avgImportance: number | null; avgSalience: number | null };

  const consolidationCount = db
    .prepare('SELECT COUNT(*) as cnt FROM consolidations WHERE chat_id = ?')
    .get(chatId) as { cnt: number };

  const pinnedCount = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ? AND pinned = 1')
    .get(chatId) as { cnt: number };

  const buckets = db
    .prepare(
      `SELECT
         CASE
           WHEN importance < 0.2 THEN '0-0.2'
           WHEN importance < 0.4 THEN '0.2-0.4'
           WHEN importance < 0.6 THEN '0.4-0.6'
           WHEN importance < 0.8 THEN '0.6-0.8'
           ELSE '0.8-1.0'
         END as bucket,
         COUNT(*) as count
       FROM memories WHERE chat_id = ?
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all(chatId) as { bucket: string; count: number }[];

  return {
    total: counts.total,
    pinned: pinnedCount.cnt,
    consolidations: consolidationCount.cnt,
    avgImportance: counts.avgImportance ?? 0,
    avgSalience: counts.avgSalience ?? 0,
    importanceDistribution: buckets,
  };
}

export function getDashboardPinnedMemories(chatId: string): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? AND pinned = 1 ORDER BY importance DESC')
    .all(chatId) as Memory[];
}

export function getDashboardLowSalienceMemories(chatId: string, limit = 10): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND salience < 0.5
       ORDER BY salience ASC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardTopAccessedMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND importance >= 0.5
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardMemoryTimeline(chatId: string, days = 30): { date: string; count: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         COUNT(*) as count
       FROM memories
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; count: number }[];
}

export function getDashboardConsolidations(chatId: string, limit = 5): Consolidation[] {
  return getRecentConsolidations(chatId, limit);
}

export interface DashboardTokenStats {
  todayInput: number;
  todayOutput: number;
  todayCost: number;
  todayTurns: number;
  allTimeCost: number;
  allTimeTurns: number;
}

export function getDashboardTokenStats(chatId: string): DashboardTokenStats {
  const today = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as todayInput,
         COALESCE(SUM(output_tokens), 0) as todayOutput,
         COALESCE(SUM(cost_usd), 0) as todayCost,
         COUNT(*) as todayTurns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', 'start of day')`,
    )
    .get(chatId) as { todayInput: number; todayOutput: number; todayCost: number; todayTurns: number };

  const allTime = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as allTimeInput,
         COALESCE(SUM(output_tokens), 0) as allTimeOutput,
         COALESCE(SUM(cost_usd), 0) as allTimeCost,
         COUNT(*) as allTimeTurns
       FROM token_usage WHERE chat_id = ?`,
    )
    .get(chatId) as { allTimeInput: number; allTimeOutput: number; allTimeCost: number; allTimeTurns: number };

  return { ...today, ...allTime };
}

export function getDashboardCostTimeline(chatId: string, days = 30): { date: string; cost: number; turns: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         SUM(cost_usd) as cost,
         COUNT(*) as turns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; cost: number; turns: number }[];
}

export interface RecentTokenUsageRow {
  id: number;
  chat_id: string;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  context_tokens: number;
  cost_usd: number;
  did_compact: number;
  created_at: number;
}

export function getDashboardRecentTokenUsage(chatId: string, limit = 20): RecentTokenUsageRow[] {
  return db
    .prepare(
      `SELECT * FROM token_usage WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as RecentTokenUsageRow[];
}

export function getDashboardMemoriesList(chatId: string, limit = 50, offset = 0, sortBy: 'importance' | 'salience' | 'recent' = 'importance'): { memories: Memory[]; total: number } {
  const total = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ?')
    .get(chatId) as { cnt: number };

  let orderClause: string;
  switch (sortBy) {
    case 'salience':
      orderClause = 'ORDER BY salience DESC, created_at DESC';
      break;
    case 'recent':
      orderClause = 'ORDER BY created_at DESC';
      break;
    default:
      orderClause = 'ORDER BY importance DESC, created_at DESC';
  }

  const memories = db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(chatId, limit, offset) as Memory[];
  return { memories, total: total.cnt };
}

// ── Hive Mind ──────────────────────────────────────────────────────

export interface HiveMindEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  summary: string;
  artifacts: string | null;
  created_at: number;
}

export function logToHiveMind(
  agentId: string,
  chatId: string,
  action: string,
  summary: string,
  artifacts?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, chatId, action, summary, artifacts ?? null, now);
}

export function getHiveMindEntries(limit = 20, agentId?: string): HiveMindEntry[] {
  if (agentId) {
    return db
      .prepare('SELECT * FROM hive_mind WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit) as HiveMindEntry[];
  }
  return db
    .prepare('SELECT * FROM hive_mind ORDER BY created_at DESC LIMIT ?')
    .all(limit) as HiveMindEntry[];
}

/**
 * Get recent hive_mind entries from agents OTHER than the given one.
 * Used to give each agent awareness of what teammates have been doing.
 */
export function getOtherAgentActivity(
  excludeAgentId: string,
  hoursBack = 24,
  limit = 10,
): HiveMindEntry[] {
  const cutoff = Math.floor(Date.now() / 1000) - (hoursBack * 3600);
  return db
    .prepare(
      `SELECT * FROM hive_mind
       WHERE agent_id != ? AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(excludeAgentId, cutoff, limit) as HiveMindEntry[];
}

// ── Per-specialist usage stats (for the Specialists health dashboard) ─
// Aggregates every `specialist-delegate-*` row in hive_mind for a given
// callsign over a window, mining the JSON `artifacts` blob for per-call
// metadata (durationMs, model, toolCalls, taskPreview). Returns one
// SpecialistStats per callsign — the API endpoint maps these onto the
// roster so even unused specialists appear with zero counts.

export interface SpecialistStats {
  callsign: string;
  invocations: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalToolCalls: number;
  lastInvokedAt: number | null;  // unix seconds, null if never invoked
  lastModel: string | null;
  recentTasks: Array<{ when: number; preview: string; durationMs: number; tier: string }>;
}

interface SpecialistArtifacts {
  callsign?: string;
  model?: string;
  tier?: string;
  toolCalls?: number;
  evalCount?: number;
  durationMs?: number;
  taskPreview?: string;
  fellBackFrom?: string;
}

export function getSpecialistStats(callsign: string, hoursBack = 24): SpecialistStats {
  const cutoff = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const agentNs = `specialist:${callsign}`;
  const rows = db
    .prepare(
      `SELECT created_at, action, summary, artifacts
       FROM hive_mind
       WHERE agent_id = ? AND created_at > ? AND action LIKE 'specialist-delegate%'
       ORDER BY created_at DESC LIMIT 200`,
    )
    .all(agentNs, cutoff) as Array<{
      created_at: number;
      action: string;
      summary: string;
      artifacts: string | null;
    }>;

  let totalDurationMs = 0;
  let totalToolCalls = 0;
  let lastModel: string | null = null;
  const recentTasks: SpecialistStats['recentTasks'] = [];

  for (const row of rows) {
    let art: SpecialistArtifacts = {};
    if (row.artifacts) {
      try { art = JSON.parse(row.artifacts) as SpecialistArtifacts; } catch { /* skip */ }
    }
    const dur = typeof art.durationMs === 'number' ? art.durationMs : 0;
    totalDurationMs += dur;
    totalToolCalls += typeof art.toolCalls === 'number' ? art.toolCalls : 0;
    if (lastModel === null && art.model) lastModel = art.model;
    if (recentTasks.length < 5) {
      recentTasks.push({
        when: row.created_at,
        preview: art.taskPreview || row.summary.slice(0, 120),
        durationMs: dur,
        tier: art.tier || (row.action.endsWith('-claw') ? 'claw' : row.action.endsWith('-cloud') ? 'cloud' : 'local'),
      });
    }
  }

  return {
    callsign,
    invocations: rows.length,
    totalDurationMs,
    avgDurationMs: rows.length > 0 ? Math.round(totalDurationMs / rows.length) : 0,
    totalToolCalls,
    lastInvokedAt: rows.length > 0 ? rows[0].created_at : null,
    lastModel,
    recentTasks,
  };
}

/**
 * Get conversation turns for a specific session, ordered chronologically.
 * Used for hive-mind auto-commit on session end.
 */
export function getSessionConversation(sessionId: string, limit = 40): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE session_id = ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(sessionId, limit) as ConversationTurn[];
}

export function getAgentTokenStats(agentId: string): { todayCost: number; todayTurns: number; allTimeCost: number } {
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as todayCost, COUNT(*) as todayTurns
       FROM token_usage
       WHERE agent_id = ? AND created_at >= unixepoch('now', 'start of day')`,
    )
    .get(agentId) as { todayCost: number; todayTurns: number };

  const allTime = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) as allTimeCost FROM token_usage WHERE agent_id = ?')
    .get(agentId) as { allTimeCost: number };

  return { ...today, allTimeCost: allTime.allTimeCost };
}

export function getAgentRecentConversation(agentId: string, chatId: string, limit = 4): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE agent_id = ? AND chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, chatId, limit) as ConversationTurn[];
}

export function getSessionTokenUsage(sessionId: string): SessionTokenSummary | null {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)           as turns,
         SUM(input_tokens)  as totalInputTokens,
         SUM(output_tokens) as totalOutputTokens,
         SUM(cost_usd)      as totalCostUsd,
         SUM(did_compact)   as compactions,
         MIN(created_at)    as firstTurnAt,
         MAX(created_at)    as lastTurnAt
       FROM token_usage WHERE session_id = ?`,
    )
    .get(sessionId) as {
      turns: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      compactions: number;
      firstTurnAt: number;
      lastTurnAt: number;
    } | undefined;

  if (!row || row.turns === 0) return null;

  // Get the most recent turn's context_tokens (actual context window size from last API call)
  // Falls back to cache_read for backward compat with rows before the migration
  const lastRow = db
    .prepare(
      `SELECT cache_read, context_tokens FROM token_usage
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { cache_read: number; context_tokens: number } | undefined;

  return {
    turns: row.turns,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    lastCacheRead: lastRow?.cache_read ?? 0,
    lastContextTokens: lastRow?.context_tokens ?? lastRow?.cache_read ?? 0,
    totalCostUsd: row.totalCostUsd,
    compactions: row.compactions,
    firstTurnAt: row.firstTurnAt,
    lastTurnAt: row.lastTurnAt,
  };
}

// ── Inter-Agent Tasks ──────────────────────────────────────────────────

export interface InterAgentTask {
  id: string;
  from_agent: string;
  to_agent: string;
  chat_id: string;
  prompt: string;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createInterAgentTask(
  id: string,
  fromAgent: string,
  toAgent: string,
  chatId: string,
  prompt: string,
): void {
  db.prepare(
    `INSERT INTO inter_agent_tasks (id, from_agent, to_agent, chat_id, prompt, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).run(id, fromAgent, toAgent, chatId, prompt);
}

export function completeInterAgentTask(
  id: string,
  status: 'completed' | 'failed',
  result: string | null,
): void {
  db.prepare(
    `UPDATE inter_agent_tasks SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`,
  ).run(status, result?.slice(0, 2000) ?? null, id);
}

export function getInterAgentTasks(
  limit = 20,
  status?: string,
): InterAgentTask[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM inter_agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(status, limit) as InterAgentTask[];
  }
  return db
    .prepare(
      'SELECT * FROM inter_agent_tasks ORDER BY created_at DESC LIMIT ?',
    )
    .all(limit) as InterAgentTask[];
}

// ── Mission Tasks (one-shot async tasks for Mission Control) ─────────

export interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result: string | null;
  error: string | null;
  created_by: string;
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  // Workspace linkage: when a mission task is a project research run, these
  // point back at the project and the project_item the result fills in.
  project_id: string | null;
  project_item_id: string | null;
}

export function createMissionTask(
  id: string,
  title: string,
  prompt: string,
  assignedAgent: string | null = null,
  createdBy = 'dashboard',
  priority = 0,
  projectId: string | null = null,
  projectItemId: string | null = null,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at, project_id, project_item_id)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, title, prompt, assignedAgent, createdBy, priority, now, projectId, projectItemId);
}

export function getUnassignedMissionTasks(): MissionTask[] {
  return db
    .prepare(
      `SELECT * FROM mission_tasks WHERE assigned_agent IS NULL AND status = 'queued'
       ORDER BY priority DESC, created_at ASC`,
    )
    .all() as MissionTask[];
}

export function getMissionTasks(agentId?: string, status?: string): MissionTask[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (agentId) {
    conditions.push('assigned_agent = ?');
    params.push(agentId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  return db
    .prepare(
      `SELECT * FROM mission_tasks${where}
       ORDER BY
         CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
         priority DESC, created_at DESC`,
    )
    .all(...params) as MissionTask[];
}

export function getMissionTask(id: string): MissionTask | null {
  return (db.prepare('SELECT * FROM mission_tasks WHERE id = ?').get(id) as MissionTask) ?? null;
}

export function claimNextMissionTask(agentId: string): MissionTask | null {
  const txn = db.transaction(() => {
    const task = db
      .prepare(
        `SELECT * FROM mission_tasks
         WHERE assigned_agent = ? AND status = 'queued'
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get(agentId) as MissionTask | undefined;
    if (!task) return null;
    db.prepare(
      `UPDATE mission_tasks SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(Math.floor(Date.now() / 1000), task.id);
    return { ...task, status: 'running' as const, started_at: Math.floor(Date.now() / 1000) };
  });
  return txn();
}

export function completeMissionTask(
  id: string,
  result: string | null,
  status: 'completed' | 'failed',
  error?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE mission_tasks SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?`,
  ).run(status, result, error ?? null, now, id);
}

export function cancelMissionTask(id: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
  ).run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}

export function deleteMissionTask(id: string): boolean {
  const result = db.prepare(
    `DELETE FROM mission_tasks WHERE id = ? AND status IN ('completed', 'cancelled', 'failed')`,
  ).run(id);
  return result.changes > 0;
}

export function cleanupOldMissionTasks(olderThanDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = db.prepare(
    `DELETE FROM mission_tasks WHERE status IN ('completed', 'cancelled', 'failed') AND completed_at < ?`,
  ).run(cutoff);
  return result.changes;
}

// ── Workspace: projects + project_items ─────────────────────────────────────
// A project is a Claude-Projects-style container. project_items is a single
// flexible table holding goals, tasks, and the research library (papers,
// sources, notes, video ideas, key points, transcripts, research videos,
// video links, analysis), discriminated by `kind` (+ `category` for research).

export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: string; // 'active' | 'archived'
  color: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_worked_at: number | null;
}

export interface ProjectSummary extends Project {
  goal_count: number;
  task_count: number;
  task_done_count: number;
  research_count: number;
}

export interface ProjectItem {
  id: string;
  project_id: string;
  kind: string; // 'goal' | 'task' | 'research'
  category: string | null;
  title: string;
  content: string;
  url: string | null;
  source: string | null;
  status: string | null; // goal/task: open|doing|done ; research: null|running|done|failed
  assigned_agent: string | null;
  metadata: string | null;
  pinned: number; // 0 | 1
  sort_order: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export function createProject(
  id: string,
  name: string,
  description = '',
  instructions = '',
  color = 'cyan',
  createdBy = 'dashboard',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO projects (id, name, description, instructions, status, color, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(id, name, description, instructions, color, createdBy, now, now);
}

export function getProject(id: string): Project | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project) ?? null;
}

export function listProjects(includeArchived = false): ProjectSummary[] {
  const where = includeArchived ? '' : `WHERE p.status = 'active'`;
  return db
    .prepare(
      `SELECT p.*,
         COALESCE(SUM(CASE WHEN i.kind = 'goal' THEN 1 ELSE 0 END), 0) AS goal_count,
         COALESCE(SUM(CASE WHEN i.kind = 'task' THEN 1 ELSE 0 END), 0) AS task_count,
         COALESCE(SUM(CASE WHEN i.kind = 'task' AND i.status = 'done' THEN 1 ELSE 0 END), 0) AS task_done_count,
         COALESCE(SUM(CASE WHEN i.kind = 'research' THEN 1 ELSE 0 END), 0) AS research_count
       FROM projects p
       LEFT JOIN project_items i ON i.project_id = p.id
       ${where}
       GROUP BY p.id
       ORDER BY (p.status = 'active') DESC, p.updated_at DESC`,
    )
    .all() as ProjectSummary[];
}

export function updateProject(
  id: string,
  patch: { name?: string; description?: string; instructions?: string; status?: string; color?: string },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of ['name', 'description', 'instructions', 'status', 'color'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  const res = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return res.changes > 0;
}

/** Bump updated_at + last_worked_at, e.g. when a research run starts. */
export function touchProject(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE projects SET updated_at = ?, last_worked_at = ? WHERE id = ?').run(now, now, id);
}

export function deleteProject(id: string): boolean {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM project_items WHERE project_id = ?').run(id);
    return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  });
  return txn();
}

export function createProjectItem(
  id: string,
  projectId: string,
  kind: string,
  opts: {
    category?: string | null;
    title: string;
    content?: string;
    url?: string | null;
    source?: string | null;
    status?: string | null;
    assignedAgent?: string | null;
    metadata?: string | null;
    sortOrder?: number;
    createdBy?: string;
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO project_items
       (id, project_id, kind, category, title, content, url, source, status, assigned_agent, metadata, pinned, sort_order, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    kind,
    opts.category ?? null,
    opts.title,
    opts.content ?? '',
    opts.url ?? null,
    opts.source ?? null,
    opts.status ?? null,
    opts.assignedAgent ?? null,
    opts.metadata ?? null,
    opts.sortOrder ?? 0,
    opts.createdBy ?? 'dashboard',
    now,
    now,
  );
}

export function getProjectItems(projectId: string, kind?: string): ProjectItem[] {
  if (kind) {
    return db
      .prepare(
        `SELECT * FROM project_items WHERE project_id = ? AND kind = ?
         ORDER BY pinned DESC, sort_order ASC, created_at DESC`,
      )
      .all(projectId, kind) as ProjectItem[];
  }
  return db
    .prepare(
      `SELECT * FROM project_items WHERE project_id = ?
       ORDER BY pinned DESC, sort_order ASC, created_at DESC`,
    )
    .all(projectId) as ProjectItem[];
}

export function getProjectItem(id: string): ProjectItem | null {
  return (db.prepare('SELECT * FROM project_items WHERE id = ?').get(id) as ProjectItem) ?? null;
}

export function updateProjectItem(
  id: string,
  patch: {
    title?: string;
    content?: string;
    category?: string | null;
    url?: string | null;
    source?: string | null;
    status?: string | null;
    assigned_agent?: string | null;
    metadata?: string | null;
    pinned?: number;
    sort_order?: number;
  },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of ['title', 'content', 'category', 'url', 'source', 'status', 'assigned_agent', 'metadata', 'pinned', 'sort_order'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  const res = db.prepare(`UPDATE project_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return res.changes > 0;
}

export function deleteProjectItem(id: string): boolean {
  return db.prepare('DELETE FROM project_items WHERE id = ?').run(id).changes > 0;
}

// ── Content Library (X / Instagram saved posts) ─────────────────────

export interface LibraryItem {
  id: string;
  url: string;
  platform: string; // 'x' | 'instagram'
  source: string; // telegram|dashboard|bookmark_sync|dyi_export
  author_name: string | null;
  author_handle: string | null;
  caption: string | null;
  posted_at: number | null;
  duration_s: number | null;
  media_type: string | null; // video|photo|carousel|text
  media_dir: string | null;
  media_file: string | null;
  thumbnail_path: string | null;
  oembed_html: string | null;
  like_count: number | null;
  repost_count: number | null;
  comment_count: number | null;
  transcript: string | null;
  transcript_segments: string | null;
  tags: string | null;
  notes: string | null;
  analysis: string | null;
  project_id: string | null;
  status: string;
  error: string | null;
  retry_count: number;
  raw_metadata: string | null;
  intent: string | null;        // content | build | reference
  track: string | null;         // ai | real_world
  platforms: string | null;     // JSON string[]
  content_score: number | null; // 0-100
  content_angle: string | null;
  cluster_id: string | null;    // same story -> same anchor id; null = singleton
  created_at: number;
  updated_at: number;
}

export const LIBRARY_TERMINAL_FAILURES = new Set(['failed_gone']);
export const LIBRARY_ACTIVE_STATUSES = ['queued', 'fetching_meta', 'downloading', 'transcribing', 'tagging'];

export function createLibraryItem(
  id: string,
  url: string,
  platform: string,
  opts: { source?: string; notes?: string | null; projectId?: string | null } = {},
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO library_items (id, url, platform, source, notes, project_id, status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, url, platform, opts.source ?? 'telegram', opts.notes ?? null, opts.projectId ?? null, now, now);
}

/**
 * Insert a live-event sweep opportunity directly as a READY text item.
 * Bypasses the ingestion worker on purpose: there is no media to download
 * for a news URL, and the content gate fields arrive pre-judged.
 */
export function createSweepLibraryItem(
  id: string,
  url: string,
  fields: {
    caption: string;
    authorName?: string | null;
    track: string;
    platforms: string[];
    contentScore: number;
    contentAngle: string | null;
    analysis?: Record<string, unknown>;
    tags?: string[];
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO library_items (
       id, url, platform, source, author_name, caption, media_type,
       tags, analysis, intent, track, platforms, content_score, content_angle,
       status, retry_count, created_at, updated_at
     ) VALUES (?, ?, 'web', 'sweep', ?, ?, 'text', ?, ?, 'content', ?, ?, ?, ?, 'ready', 0, ?, ?)`,
  ).run(
    id, url, fields.authorName ?? null, fields.caption,
    fields.tags?.length ? JSON.stringify(fields.tags) : null,
    fields.analysis ? JSON.stringify(fields.analysis) : null,
    fields.track, JSON.stringify(fields.platforms),
    fields.contentScore, fields.contentAngle, now, now,
  );
}

export function getLibraryItem(id: string): LibraryItem | null {
  return (db.prepare('SELECT * FROM library_items WHERE id = ?').get(id) as LibraryItem) ?? null;
}

export function getLibraryItemByUrl(url: string): LibraryItem | null {
  return (db.prepare('SELECT * FROM library_items WHERE url = ?').get(url) as LibraryItem) ?? null;
}

export function listLibraryItems(opts: {
  platform?: string;
  status?: string;
  tag?: string;
  q?: string;
  categoryId?: string;
  uncategorized?: boolean;
  intent?: string;
  track?: string;
  contentPlatform?: string;
  minScore?: number;
  sort?: string;
  limit?: number;
  offset?: number;
} = {}): { items: LibraryItem[]; total: number } {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.intent) { where.push('intent = ?'); vals.push(opts.intent); }
  if (opts.track) { where.push('track = ?'); vals.push(opts.track); }
  if (opts.contentPlatform) { where.push('platforms LIKE ?'); vals.push(`%"${opts.contentPlatform}"%`); }
  if (typeof opts.minScore === 'number') { where.push('COALESCE(content_score, 0) >= ?'); vals.push(opts.minScore); }
  if (opts.categoryId) {
    // Match the subcategory directly, OR (if an umbrella was passed) any of its subcategories.
    where.push(`id IN (SELECT item_id FROM library_item_categories WHERE category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))`);
    vals.push(opts.categoryId, opts.categoryId);
  }
  if (opts.uncategorized) {
    where.push(`id NOT IN (SELECT item_id FROM library_item_categories)`);
  }
  if (opts.platform) { where.push('platform = ?'); vals.push(opts.platform); }
  if (opts.status === 'failed') {
    where.push(`status LIKE 'failed%'`);
  } else if (opts.status === 'processing') {
    where.push(`status IN ('queued', 'fetching_meta', 'downloading', 'transcribing', 'tagging')`);
  } else if (opts.status) { where.push('status = ?'); vals.push(opts.status); }
  if (opts.tag) { where.push('tags LIKE ?'); vals.push(`%"${opts.tag}"%`); }
  if (opts.q) {
    where.push('(caption LIKE ? OR transcript LIKE ? OR author_handle LIKE ? OR notes LIKE ?)');
    const like = `%${opts.q}%`;
    vals.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM library_items ${whereSql}`).get(...vals) as { c: number }).c;
  const orderBy = opts.sort === 'score'
    ? 'COALESCE(content_score, 0) DESC, created_at DESC'
    : 'created_at DESC';
  const items = db
    .prepare(`SELECT * FROM library_items ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...vals, opts.limit ?? 50, opts.offset ?? 0) as LibraryItem[];
  return { items, total };
}

export function updateLibraryItem(
  id: string,
  patch: Partial<Omit<LibraryItem, 'id' | 'created_at' | 'updated_at'>>,
): boolean {
  const cols = [
    'url', 'platform', 'source', 'author_name', 'author_handle', 'caption', 'posted_at', 'duration_s',
    'media_type', 'media_dir', 'media_file', 'thumbnail_path', 'oembed_html', 'like_count', 'repost_count',
    'comment_count', 'transcript', 'transcript_segments', 'tags', 'notes', 'analysis', 'project_id',
    'status', 'error', 'retry_count', 'raw_metadata',
    'intent', 'track', 'platforms', 'content_score', 'content_angle', 'cluster_id',
  ] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of cols) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  const res = db.prepare(`UPDATE library_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return res.changes > 0;
}

export function deleteLibraryItem(id: string): boolean {
  return db.prepare('DELETE FROM library_items WHERE id = ?').run(id).changes > 0;
}

// ── Content drafts (staged: brief -> greenlight -> script) ──────────

export interface ContentDraft {
  id: string;
  item_id: string;
  track: string;
  platform: string;
  status: string; // brief|greenlit|scripted|rejected|failed
  brief: string | null;
  script: string | null;
  model_used: string | null;
  error: string | null;
  verification: string | null;
  verification_status: string | null; // none|running|done|failed
  publish_kit: string | null;
  created_at: number;
  updated_at: number;
}

export function createContentDraft(
  id: string,
  itemId: string,
  track: string,
  platform: string,
  opts: { brief?: string | null; status?: string; modelUsed?: string | null; error?: string | null } = {},
): ContentDraft {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO content_drafts (id, item_id, track, platform, status, brief, script, model_used, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(id, itemId, track, platform, opts.status ?? 'brief', opts.brief ?? null, opts.modelUsed ?? null, opts.error ?? null, now, now);
  return getContentDraft(id)!;
}

export function getContentDraft(id: string): ContentDraft | undefined {
  return db.prepare('SELECT * FROM content_drafts WHERE id = ?').get(id) as ContentDraft | undefined;
}

export function updateContentDraft(
  id: string,
  patch: Partial<Omit<ContentDraft, 'id' | 'item_id' | 'created_at' | 'updated_at'>>,
): boolean {
  const cols = ['track', 'platform', 'status', 'brief', 'script', 'model_used', 'error', 'verification', 'verification_status', 'publish_kit'] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of cols) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  return db.prepare(`UPDATE content_drafts SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

export function listContentDrafts(itemId: string): ContentDraft[] {
  return db.prepare('SELECT * FROM content_drafts WHERE item_id = ? ORDER BY created_at DESC').all(itemId) as ContentDraft[];
}

export function deleteContentDraft(id: string): boolean {
  return db.prepare('DELETE FROM content_drafts WHERE id = ?').run(id).changes > 0;
}

// ── Edit Bay render jobs ─────────────────────────────────────────────

export interface RenderJob {
  id: string;
  item_id: string | null;
  kind: string;
  status: string; // queued|preparing|rendering|ready|failed
  spec: string | null;
  output_file: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function createRenderJob(id: string, itemId: string | null, kind: string, spec: Record<string, unknown>): RenderJob {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO render_jobs (id, item_id, kind, status, spec, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(id, itemId, kind, JSON.stringify(spec), now, now);
  return getRenderJob(id)!;
}

export function getRenderJob(id: string): RenderJob | undefined {
  return db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id) as RenderJob | undefined;
}

export function updateRenderJob(
  id: string,
  patch: Partial<Omit<RenderJob, 'id' | 'created_at' | 'updated_at'>>,
): boolean {
  const cols = ['item_id', 'kind', 'status', 'spec', 'output_file', 'error'] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of cols) {
    if (patch[key] !== undefined) { sets.push(`${key} = ?`); vals.push(patch[key]); }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  return db.prepare(`UPDATE render_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

export function listRenderJobs(limit = 50): RenderJob[] {
  return db.prepare('SELECT * FROM render_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as RenderJob[];
}

export function nextQueuedRenderJob(): RenderJob | undefined {
  return db.prepare(`SELECT * FROM render_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as RenderJob | undefined;
}

export function deleteRenderJob(id: string): boolean {
  return db.prepare('DELETE FROM render_jobs WHERE id = ?').run(id).changes > 0;
}

// ── Edit Projects (faceless workbench) ───────────────────────────────

export interface EditProject {
  id: string;
  title: string;
  status: string; // idea|approved|rendering|done|archived
  item_ids: string | null;
  idea_notes: string | null;
  script: string | null;
  script_labels: string | null;
  brief: string | null;
  aspect: string;
  voiceover_file: string | null;
  render_job_id: string | null;
  created_at: number;
  updated_at: number;
}

export function createEditProject(id: string, title: string): EditProject {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO edit_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, title, now, now);
  return getEditProject(id)!;
}

export function getEditProject(id: string): EditProject | undefined {
  return db.prepare('SELECT * FROM edit_projects WHERE id = ?').get(id) as EditProject | undefined;
}

export function updateEditProject(
  id: string,
  patch: Partial<Omit<EditProject, 'id' | 'created_at' | 'updated_at'>>,
): boolean {
  const cols = ['title', 'status', 'item_ids', 'idea_notes', 'script', 'script_labels', 'brief', 'aspect', 'voiceover_file', 'render_job_id'] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of cols) {
    if (patch[key] !== undefined) { sets.push(`${key} = ?`); vals.push(patch[key]); }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  return db.prepare(`UPDATE edit_projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

/** The project (if any) whose latest render is this job — for status sync on completion. */
export function getEditProjectByRenderJobId(jobId: string): EditProject | undefined {
  return db.prepare('SELECT * FROM edit_projects WHERE render_job_id = ?').get(jobId) as EditProject | undefined;
}

export function listEditProjects(includeArchived = false): EditProject[] {
  return db.prepare(
    includeArchived
      ? 'SELECT * FROM edit_projects ORDER BY updated_at DESC LIMIT 100'
      : `SELECT * FROM edit_projects WHERE status != 'archived' ORDER BY updated_at DESC LIMIT 100`,
  ).all() as EditProject[];
}

export function deleteEditProject(id: string): boolean {
  return db.prepare('DELETE FROM edit_projects WHERE id = ?').run(id).changes > 0;
}

/** Renders are idempotent: anything mid-flight when the service died re-queues at boot. */
export function requeueStuckRenderJobs(): number {
  return db.prepare(
    `UPDATE render_jobs SET status = 'queued', updated_at = ?
     WHERE status IN ('preparing', 'rendering')`,
  ).run(Math.floor(Date.now() / 1000)).changes;
}

/** A restart mid-fact-check would strand 'running' forever; call at boot. */
export function recoverStuckVerifications(): number {
  return db.prepare(
    `UPDATE content_drafts SET verification_status = 'failed', updated_at = ?
     WHERE verification_status = 'running'`,
  ).run(Math.floor(Date.now() / 1000)).changes;
}

// ── Social accounts (OAuth tokens, field-encrypted) ─────────────────

export interface SocialAccount {
  platform: string;
  user_id: string | null;
  handle: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scopes: string | null;
  updated_at: number;
}

export function saveSocialAccount(acc: {
  platform: string;
  userId?: string | null;
  handle?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO social_accounts (platform, user_id, handle, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET
       user_id = excluded.user_id, handle = excluded.handle,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, scopes = excluded.scopes, updated_at = excluded.updated_at`,
  ).run(
    acc.platform,
    acc.userId ?? null,
    acc.handle ?? null,
    encryptField(acc.accessToken),
    acc.refreshToken ? encryptField(acc.refreshToken) : null,
    acc.expiresAt ?? null,
    acc.scopes ?? null,
    now,
  );
}

/** Returns the account with tokens DECRYPTED. Treat the result as secret. */
export function getSocialAccount(platform: string): SocialAccount | null {
  const row = db.prepare('SELECT * FROM social_accounts WHERE platform = ?').get(platform) as SocialAccount | undefined;
  if (!row) return null;
  return {
    ...row,
    access_token: decryptField(row.access_token),
    refresh_token: row.refresh_token ? decryptField(row.refresh_token) : null,
  };
}

export function deleteSocialAccount(platform: string): boolean {
  return db.prepare('DELETE FROM social_accounts WHERE platform = ?').run(platform).changes > 0;
}

// ── Content Library taxonomy (umbrellas + subcategories) ────────────

export interface Category {
  id: string;
  kind: string; // 'umbrella' | 'subcategory'
  parent_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  created_by: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CategoryNode extends Category {
  item_count: number;
  subcategories?: CategoryNode[];
}

export function slugifyCategory(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

/**
 * Create a category if one with the same slug doesn't already exist in the
 * same scope (umbrella slugs are global; subcategory slugs are unique under
 * their umbrella). Returns the id of the new OR existing category, plus
 * whether it was freshly created (so the worker can notify on new folders).
 */
export function ensureCategory(
  kind: 'umbrella' | 'subcategory',
  parentId: string | null,
  name: string,
  opts: { description?: string | null; createdBy?: string } = {},
): { id: string; created: boolean } {
  const slug = slugifyCategory(name);
  const existing = db
    .prepare(`SELECT id FROM categories WHERE COALESCE(parent_id, '') = ? AND slug = ?`)
    .get(parentId ?? '', slug) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const id = crypto.randomBytes(4).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const maxOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE COALESCE(parent_id,'') = ?`).get(parentId ?? '') as { m: number }).m;
  db.prepare(
    `INSERT INTO categories (id, kind, parent_id, name, slug, description, created_by, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, parentId, name, slug, opts.description ?? null, opts.createdBy ?? 'jarvis', maxOrder + 1, now, now);
  return { id, created: true };
}

export function getCategory(id: string): Category | null {
  return (db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category) ?? null;
}

export function findUmbrellaByName(name: string): Category | null {
  return (db.prepare(`SELECT * FROM categories WHERE kind='umbrella' AND slug = ?`).get(slugifyCategory(name)) as Category) ?? null;
}

export function findSubcategoryByName(umbrellaId: string, name: string): Category | null {
  return (db.prepare(`SELECT * FROM categories WHERE kind='subcategory' AND parent_id = ? AND slug = ?`).get(umbrellaId, slugifyCategory(name)) as Category) ?? null;
}

export function renameCategory(id: string, name: string): boolean {
  const cat = getCategory(id);
  if (!cat) return false;
  const slug = slugifyCategory(name);
  const clash = db.prepare(`SELECT id FROM categories WHERE COALESCE(parent_id,'') = ? AND slug = ? AND id != ?`).get(cat.parent_id ?? '', slug, id);
  if (clash) return false; // would collide with a sibling
  return db.prepare('UPDATE categories SET name = ?, slug = ?, updated_at = ? WHERE id = ?')
    .run(name, slug, Math.floor(Date.now() / 1000), id).changes > 0;
}

/** Move all item links from `fromId` into `toId`, then delete `fromId`. */
export function mergeCategories(fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const from = getCategory(fromId), to = getCategory(toId);
  if (!from || !to || from.kind !== to.kind) return false;
  const txn = db.transaction(() => {
    const links = db.prepare('SELECT item_id, is_primary FROM library_item_categories WHERE category_id = ?').all(fromId) as Array<{ item_id: string; is_primary: number }>;
    const now = Math.floor(Date.now() / 1000);
    for (const l of links) {
      db.prepare('INSERT OR IGNORE INTO library_item_categories (item_id, category_id, is_primary, created_at) VALUES (?, ?, ?, ?)')
        .run(l.item_id, toId, l.is_primary, now);
    }
    db.prepare('DELETE FROM library_item_categories WHERE category_id = ?').run(fromId);
    // Re-home orphaned subcategories if merging umbrellas.
    if (from.kind === 'umbrella') db.prepare('UPDATE categories SET parent_id = ? WHERE parent_id = ?').run(toId, fromId);
    db.prepare('DELETE FROM categories WHERE id = ?').run(fromId);
  });
  txn();
  return true;
}

export function deleteCategory(id: string): boolean {
  const cat = getCategory(id);
  if (!cat) return false;
  const txn = db.transaction(() => {
    if (cat.kind === 'umbrella') {
      const subs = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(id) as Array<{ id: string }>;
      for (const s of subs) db.prepare('DELETE FROM library_item_categories WHERE category_id = ?').run(s.id);
      db.prepare('DELETE FROM categories WHERE parent_id = ?').run(id);
    }
    db.prepare('DELETE FROM library_item_categories WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });
  txn();
  return true;
}

export function assignItemCategory(itemId: string, categoryId: string, isPrimary = false): void {
  const now = Math.floor(Date.now() / 1000);
  if (isPrimary) db.prepare('UPDATE library_item_categories SET is_primary = 0 WHERE item_id = ?').run(itemId);
  db.prepare(
    `INSERT INTO library_item_categories (item_id, category_id, is_primary, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id, category_id) DO UPDATE SET is_primary = excluded.is_primary`,
  ).run(itemId, categoryId, isPrimary ? 1 : 0, now);
}

export function unassignItemCategory(itemId: string, categoryId: string): boolean {
  return db.prepare('DELETE FROM library_item_categories WHERE item_id = ? AND category_id = ?').run(itemId, categoryId).changes > 0;
}

export function setPrimaryCategory(itemId: string, categoryId: string): void {
  db.prepare('UPDATE library_item_categories SET is_primary = 0 WHERE item_id = ?').run(itemId);
  db.prepare('UPDATE library_item_categories SET is_primary = 1 WHERE item_id = ? AND category_id = ?').run(itemId, categoryId);
}

/** Folders an item lives in, with umbrella + subcategory names. */
export function getItemCategories(itemId: string): Array<{ category_id: string; is_primary: number; subcategory: string; umbrella: string; umbrella_id: string | null }> {
  return db.prepare(
    `SELECT lic.category_id, lic.is_primary,
            s.name AS subcategory, COALESCE(u.name, '') AS umbrella, u.id AS umbrella_id
     FROM library_item_categories lic
     JOIN categories s ON s.id = lic.category_id
     LEFT JOIN categories u ON u.id = s.parent_id
     WHERE lic.item_id = ?
     ORDER BY lic.is_primary DESC`,
  ).all(itemId) as Array<{ category_id: string; is_primary: number; subcategory: string; umbrella: string; umbrella_id: string | null }>;
}

/** Full umbrella -> subcategory tree with item counts (distinct per umbrella). */
export function listCategoryTree(): CategoryNode[] {
  const all = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all() as Category[];
  const subCounts = new Map<string, number>();
  for (const r of db.prepare('SELECT category_id, COUNT(*) AS c FROM library_item_categories GROUP BY category_id').all() as Array<{ category_id: string; c: number }>) {
    subCounts.set(r.category_id, r.c);
  }
  const umbrellaCounts = new Map<string, number>();
  for (const r of db.prepare(
    `SELECT p.id AS uid, COUNT(DISTINCT lic.item_id) AS c
     FROM categories p JOIN categories s ON s.parent_id = p.id
     LEFT JOIN library_item_categories lic ON lic.category_id = s.id
     WHERE p.kind = 'umbrella' GROUP BY p.id`,
  ).all() as Array<{ uid: string; c: number }>) {
    umbrellaCounts.set(r.uid, r.c);
  }
  const umbrellas = all.filter((c) => c.kind === 'umbrella').map((u) => ({
    ...u,
    item_count: umbrellaCounts.get(u.id) ?? 0,
    subcategories: all.filter((s) => s.parent_id === u.id).map((s) => ({ ...s, item_count: subCounts.get(s.id) ?? 0 })),
  }));
  return umbrellas;
}

const CATEGORY_SEED: Array<{ umbrella: string; description: string; subs: string[] }> = [
  { umbrella: 'Finance & Markets', description: 'Money, markets, trading, and wealth building of any kind.', subs: ['Stocks & Investing', 'Trading', 'Copytrading', 'Quant & Algo Trading', 'Crypto', 'Prediction Markets', 'Gambling', 'Money-Making & Business'] },
  { umbrella: 'Power & Geopolitics', description: 'Government, deep state, foreign influence, war, and global power.', subs: ['US Deep State', 'Foreign Influence on US', 'War & Conflict', 'Globalist Institutions', 'Nation Files'] },
  { umbrella: 'History & Hidden History', description: 'The past, including suppressed or alternative history. File by era or subject, not by who is mentioned.', subs: ['WWII', 'Ancient Civilizations', 'Peoples & Eras', 'Suppressed & Alt History'] },
  { umbrella: 'Spirituality & Consciousness', description: 'Religion, the esoteric, metaphysics, and consciousness.', subs: ['Religion', 'Esoteric & Occult', 'Metaphysics', 'Consciousness'] },
  { umbrella: 'AI & Tech', description: 'AI, agents, software builds and setups, automation, and tech news.', subs: ['Builds & Setups', 'AI Tools', 'Automation', 'AI News'] },
  { umbrella: 'Health & Human Performance', description: 'Body and mind: nutrition, fitness, longevity, performance.', subs: ['Nutrition', 'Fitness', 'Longevity', 'Mind'] },
  { umbrella: 'Creator Craft', description: 'The craft of making content: hooks, editing, and audience growth.', subs: ['Hooks & Angles', 'Editing', 'Growth Tactics'] },
  { umbrella: 'Science & Frontier', description: 'Hard and frontier science, including fringe or suppressed science.', subs: ['Physics', 'Space', 'Fringe & Suppressed Science'] },
];

/** Idempotent: seeds the starting umbrellas + subcategories if missing. */
export function seedCategories(): void {
  for (const u of CATEGORY_SEED) {
    const { id } = ensureCategory('umbrella', null, u.umbrella, { description: u.description, createdBy: 'seed' });
    for (const sub of u.subs) ensureCategory('subcategory', id, sub, { createdBy: 'seed' });
  }
}

/** Next queued item to ingest (FIFO). Worker claims by flipping status. */
export function nextQueuedLibraryItem(): LibraryItem | null {
  return (db.prepare(`SELECT * FROM library_items WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as LibraryItem) ?? null;
}

/** On boot: anything stuck mid-pipeline goes back to queued (steps are idempotent). */
export function requeueStuckLibraryItems(): number {
  return db.prepare(
    `UPDATE library_items SET status = 'queued'
     WHERE status IN ('fetching_meta', 'downloading', 'transcribing', 'tagging')`,
  ).run().changes;
}

export function libraryStats(): { by_status: Record<string, number>; by_platform: Record<string, number>; total: number } {
  const rows = db.prepare('SELECT status, platform, COUNT(*) AS c FROM library_items GROUP BY status, platform').all() as Array<{ status: string; platform: string; c: number }>;
  const by_status: Record<string, number> = {};
  const by_platform: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    by_status[r.status] = (by_status[r.status] ?? 0) + r.c;
    by_platform[r.platform] = (by_platform[r.platform] ?? 0) + r.c;
    total += r.c;
  }
  return { by_status, by_platform, total };
}

export function reassignMissionTask(id: string, newAgent: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET assigned_agent = ? WHERE id = ? AND status = 'queued'`,
  ).run(newAgent, id);
  return result.changes > 0;
}

export function assignMissionTask(id: string, agent: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET assigned_agent = ? WHERE id = ? AND assigned_agent IS NULL AND status = 'queued'`,
  ).run(agent, id);
  return result.changes > 0;
}

export function getMissionTaskHistory(limit = 30, offset = 0): { tasks: MissionTask[]; total: number } {
  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM mission_tasks WHERE status IN ('completed', 'failed', 'cancelled')`,
  ).get() as { c: number }).c;
  const tasks = db.prepare(
    `SELECT * FROM mission_tasks WHERE status IN ('completed', 'failed', 'cancelled')
     ORDER BY completed_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset) as MissionTask[];
  return { tasks, total };
}

export function resetStuckMissionTasks(agentId: string): number {
  const result = db.prepare(
    `UPDATE mission_tasks SET status = 'queued', started_at = NULL WHERE status = 'running' AND assigned_agent = ?`,
  ).run(agentId);
  return result.changes;
}

// ── Meet Sessions (Pika video meeting skill) ────────────────────────

export type MeetProvider = 'pika' | 'recall' | 'daily';

export interface MeetSession {
  id: string;
  agent_id: string;
  meet_url: string;
  bot_name: string;
  platform: string;
  provider: MeetProvider;
  status: 'joining' | 'live' | 'left' | 'failed';
  voice_id: string | null;
  image_path: string | null;
  brief_path: string | null;
  created_at: number;
  joined_at: number | null;
  left_at: number | null;
  post_notes: string | null;
  error: string | null;
}

export function createMeetSession(session: {
  id: string;
  agentId: string;
  meetUrl: string;
  botName: string;
  platform?: string;
  provider?: MeetProvider;
  voiceId?: string | null;
  imagePath?: string | null;
  briefPath?: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO meet_sessions (id, agent_id, meet_url, bot_name, platform, provider, status, voice_id, image_path, brief_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'joining', ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.agentId,
    session.meetUrl,
    session.botName,
    session.platform ?? 'google_meet',
    session.provider ?? 'pika',
    session.voiceId ?? null,
    session.imagePath ?? null,
    session.briefPath ?? null,
    now,
  );
}

export function markMeetSessionLive(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'live', joined_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function markMeetSessionLeft(id: string, postNotes?: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'left', left_at = ?, post_notes = ? WHERE id = ?`,
  ).run(now, postNotes ?? null, id);
}

export function markMeetSessionFailed(id: string, error: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'failed', left_at = ?, error = ? WHERE id = ?`,
  ).run(now, error.slice(0, 2000), id);
}

export function getMeetSession(id: string): MeetSession | null {
  return (db.prepare('SELECT * FROM meet_sessions WHERE id = ?').get(id) as MeetSession) ?? null;
}

export function listActiveMeetSessions(): MeetSession[] {
  return db.prepare(
    `SELECT * FROM meet_sessions WHERE status IN ('joining', 'live') ORDER BY created_at DESC`,
  ).all() as MeetSession[];
}

export function listRecentMeetSessions(limit = 20): MeetSession[] {
  return db.prepare(
    `SELECT * FROM meet_sessions ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as MeetSession[];
}

// ── Audit Log ────────────────────────────────────────────────────────

export function insertAuditLog(
  agentId: string,
  chatId: string,
  action: string,
  detail: string,
  blocked: boolean,
): void {
  db.prepare(
    `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`,
  ).run(agentId, chatId, action, detail.slice(0, 2000), blocked ? 1 : 0);
}

export interface AuditLogEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  detail: string;
  blocked: number;
  created_at: number;
}

export function getAuditLog(limit = 50, offset = 0, agentId?: string): AuditLogEntry[] {
  if (agentId) {
    return db.prepare(
      `SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(agentId, limit, offset) as AuditLogEntry[];
  }
  return db.prepare(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset) as AuditLogEntry[];
}

export function getAuditLogCount(agentId?: string): number {
  if (agentId) {
    return (db.prepare('SELECT COUNT(*) as c FROM audit_log WHERE agent_id = ?').get(agentId) as { c: number }).c;
  }
  return (db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as { c: number }).c;
}

export function getRecentBlockedActions(limit = 10): AuditLogEntry[] {
  return db.prepare(
    `SELECT * FROM audit_log WHERE blocked = 1 ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as AuditLogEntry[];
}

// ── Phase 2: Compaction events ────────────────────────────────────────

export function saveCompactionEvent(
  sessionId: string,
  preTokens: number,
  postTokens: number,
  turnCount: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO compaction_events (session_id, pre_tokens, post_tokens, turn_count, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, preTokens, postTokens, turnCount, now);
}

export function getCompactionCount(sessionId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) as c FROM compaction_events WHERE session_id = ?',
  ).get(sessionId) as { c: number }).c;
}

export function getCompactionHistory(sessionId: string): Array<{
  id: number; session_id: string; pre_tokens: number; post_tokens: number;
  turn_count: number; created_at: number;
}> {
  return db.prepare(
    'SELECT * FROM compaction_events WHERE session_id = ? ORDER BY created_at DESC',
  ).all(sessionId) as Array<{
    id: number; session_id: string; pre_tokens: number; post_tokens: number;
    turn_count: number; created_at: number;
  }>;
}

// ── Phase 2: Session stats for /convolife ──────────────────────────────

export function getSessionStats(sessionId: string): {
  turnCount: number;
  totalCost: number;
  compactionCount: number;
  maxContextTokens: number;
} {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as turnCount,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(did_compact), 0) as compactionCount,
      COALESCE(MAX(context_tokens), 0) as maxContextTokens
    FROM token_usage WHERE session_id = ?
  `).get(sessionId) as {
    turnCount: number; totalCost: number;
    compactionCount: number; maxContextTokens: number;
  } | undefined;

  return stats ?? { turnCount: 0, totalCost: 0, compactionCount: 0, maxContextTokens: 0 };
}

// ── Phase 2: Memory nudge support ──────────────────────────────────────

export function getLastMemorySaveTime(chatId: string, agentId = 'main'): number | null {
  const row = db.prepare(
    'SELECT created_at FROM memories WHERE chat_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(chatId, agentId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

export function getTurnCountSinceTimestamp(chatId: string, sinceTimestamp: number, agentId = 'main'): number {
  const row = db.prepare(
    'SELECT COUNT(*) as c FROM conversation_log WHERE chat_id = ? AND agent_id = ? AND role = ? AND created_at > ?',
  ).get(chatId, agentId, 'user', sinceTimestamp) as { c: number };
  return row.c;
}

// ── Phase 4: Skill health & usage ────────────────────────────────────

export function upsertSkillHealth(
  skillId: string,
  status: string,
  errorMsg = '',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO skill_health (skill_id, status, error_msg, last_check, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET status = ?, error_msg = ?, last_check = ?
  `).run(skillId, status, errorMsg, now, now, status, errorMsg, now);
}

export function getSkillHealth(skillId: string): { status: string; error_msg: string; last_check: number } | undefined {
  return db.prepare('SELECT status, error_msg, last_check FROM skill_health WHERE skill_id = ?')
    .get(skillId) as { status: string; error_msg: string; last_check: number } | undefined;
}

export function getAllSkillHealth(): Array<{ skill_id: string; status: string; error_msg: string; last_check: number }> {
  return db.prepare('SELECT * FROM skill_health ORDER BY skill_id').all() as Array<{
    skill_id: string; status: string; error_msg: string; last_check: number;
  }>;
}

export function logSkillUsage(
  skillId: string,
  chatId: string,
  agentId: string,
  tokensUsed: number,
  succeeded: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO skill_usage (skill_id, chat_id, agent_id, triggered_at, tokens_used, succeeded)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(skillId, chatId, agentId, now, tokensUsed, succeeded ? 1 : 0);
}

export function getSkillUsageStats(): Array<{
  skill_id: string; count: number; last_used: number; total_tokens: number;
}> {
  return db.prepare(`
    SELECT skill_id,
           COUNT(*) as count,
           MAX(triggered_at) as last_used,
           SUM(tokens_used) as total_tokens
    FROM skill_usage
    GROUP BY skill_id
    ORDER BY count DESC
  `).all() as Array<{
    skill_id: string; count: number; last_used: number; total_tokens: number;
  }>;
}

// ── Phase 6: Session summaries ────────────────────────────────────────

export function saveSessionSummary(
  sessionId: string,
  summary: string,
  keyDecisions: string[],
  turnCount: number,
  totalCost: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO session_summaries (session_id, summary, key_decisions, turn_count, total_cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET summary = ?, key_decisions = ?, turn_count = ?, total_cost = ?, created_at = ?
  `).run(sessionId, summary, JSON.stringify(keyDecisions), turnCount, totalCost, now,
    summary, JSON.stringify(keyDecisions), turnCount, totalCost, now);
}

export function getSessionSummary(sessionId: string): {
  summary: string; key_decisions: string; turn_count: number; total_cost: number;
} | undefined {
  return db.prepare('SELECT summary, key_decisions, turn_count, total_cost FROM session_summaries WHERE session_id = ?')
    .get(sessionId) as { summary: string; key_decisions: string; turn_count: number; total_cost: number } | undefined;
}

// ── War Room meeting history ─────────────────────────────────────────────

export function createWarRoomMeeting(id: string, mode: string, pinnedAgent: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO warroom_meetings (id, started_at, mode, pinned_agent) VALUES (?, ?, ?, ?)',
  ).run(id, Math.floor(Date.now() / 1000), mode, pinnedAgent);
}

export function endWarRoomMeeting(id: string, entryCount: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE warroom_meetings SET ended_at = ?, duration_s = ? - started_at, entry_count = ? WHERE id = ?',
  ).run(now, now, entryCount, id);
}

export function addWarRoomTranscript(
  meetingId: string,
  speaker: string,
  text: string,
): { id: number; created_at: number } {
  const created_at = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    'INSERT INTO warroom_transcript (meeting_id, speaker, text, created_at) VALUES (?, ?, ?, ?)',
  ).run(meetingId, speaker, text, created_at);
  return { id: Number(info.lastInsertRowid), created_at };
}

// Voice-only history. Text meetings live in the same table (with
// meeting_type = 'text') and have their own /warroom/text picker — they
// must not leak into the voice meeting list.
export function getWarRoomMeetings(limit = 20): Array<{
  id: string; started_at: number; ended_at: number | null; duration_s: number | null;
  mode: string; pinned_agent: string; entry_count: number;
}> {
  return db.prepare(
    `SELECT * FROM warroom_meetings
      WHERE meeting_type IS NULL OR meeting_type = 'voice'
      ORDER BY started_at DESC LIMIT ?`,
  ).all(limit) as any[];
}

export function getWarRoomTranscript(
  meetingId: string,
  opts: { limit?: number; beforeTs?: number; beforeId?: number } = {},
): Array<{
  id: number; speaker: string; text: string; created_at: number;
}> {
  const { limit, beforeTs, beforeId } = opts;
  // When limit is omitted, preserve the legacy "return everything ASC"
  // behavior for the voice War Room caller in dashboard.ts.
  if (limit === undefined && beforeTs === undefined && beforeId === undefined) {
    return db.prepare(
      'SELECT id, speaker, text, created_at FROM warroom_transcript WHERE meeting_id = ? ORDER BY created_at, id',
    ).all(meetingId) as any[];
  }
  // Paginated path: composite cursor on (created_at, id) so multiple rows
  // with the same created_at second don't get skipped. Callers pass
  // beforeTs+beforeId (the oldest already-loaded row's values); we return
  // rows strictly older than that cursor, newest-first, and the caller
  // reverses for display order.
  const cap = Math.max(1, Math.min(1000, limit ?? 200));
  if (beforeTs !== undefined) {
    const bId = beforeId ?? Number.MAX_SAFE_INTEGER;
    return db.prepare(
      `SELECT id, speaker, text, created_at
         FROM warroom_transcript
        WHERE meeting_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(meetingId, beforeTs, beforeTs, bId, cap) as any[];
  }
  return db.prepare(
    'SELECT id, speaker, text, created_at FROM warroom_transcript WHERE meeting_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(meetingId, cap) as any[];
}

// ── War Room hive-mind bridges ───────────────────────────────────────

/** Persist a war-room turn to conversation_log atomically and idempotently.
 *  - User row written ONCE per turn (singleton via partial unique index).
 *  - One assistant row per agent (per-agent unique via index).
 *  - On retry, INSERT OR IGNORE detects existing rows; only fresh inserts
 *    are reported back, so the caller can gate memory ingestion on the
 *    assistant row being NEW (not a no-op replay).
 *  - chatId === '' (legacy meetings) → caller should skip this entirely.
 */
export function saveWarRoomConversationTurn(args: {
  chatId: string;
  agentId: string;
  originalUserText: string;
  agentReply: string;
  meetingId: string;
  turnId: string;
}): { userInserted: boolean; assistantInserted: boolean } {
  const { chatId, agentId, originalUserText, agentReply, meetingId, turnId } = args;
  if (!meetingId || !turnId) {
    throw new Error('saveWarRoomConversationTurn: meetingId and turnId required');
  }
  const now = Math.floor(Date.now() / 1000);
  const userStmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_log
       (chat_id, session_id, role, content, created_at, agent_id, source, source_meeting_id, source_turn_id)
     VALUES (?, NULL, 'user', ?, ?, ?, 'warroom-text', ?, ?)`,
  );
  const asstStmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_log
       (chat_id, session_id, role, content, created_at, agent_id, source, source_meeting_id, source_turn_id)
     VALUES (?, NULL, 'assistant', ?, ?, ?, 'warroom-text', ?, ?)`,
  );
  const txn = db.transaction(() => {
    const u = userStmt.run(chatId, originalUserText, now, agentId, meetingId, turnId);
    const a = asstStmt.run(chatId, agentReply, now, agentId, meetingId, turnId);
    return {
      userInserted: u.changes > 0,
      assistantInserted: a.changes > 0,
    };
  });
  return txn();
}

/** Bounded mission lookup. Existing getMissionTasks is unbounded; this
 *  variant takes a sinceTs cutoff and a hard limit so /standup never
 *  pulls a runaway result set. */
export function getRecentMissionTasks(
  agentId: string,
  status: string | undefined,
  sinceTs: number,
  limit = 10,
): MissionTask[] {
  const conds: string[] = ['assigned_agent = ?', 'created_at >= ?'];
  const params: unknown[] = [agentId, sinceTs];
  if (status) { conds.push('status = ?'); params.push(status); }
  params.push(limit);
  return db
    .prepare(
      `SELECT * FROM mission_tasks WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as MissionTask[];
}

/** Last N war-room transcript rows for a chat across all its meetings,
 *  optionally excluding the meeting that's currently building context.
 *  Used by buildMemoryContext to bridge war room → Telegram so a Telegram
 *  follow-up can cite what was said earlier in a war room. */
export function getRecentWarRoomTranscriptForChat(
  chatId: string,
  opts: { limit?: number; sinceTs?: number; excludeMeetingId?: string } = {},
): Array<{ id: number; meeting_id: string; speaker: string; text: string; created_at: number }> {
  const { limit = 10, sinceTs, excludeMeetingId } = opts;
  const conds: string[] = ['m.meeting_type = ?', 'm.chat_id = ?'];
  const params: unknown[] = ['text', chatId];
  if (sinceTs !== undefined) { conds.push('t.created_at >= ?'); params.push(sinceTs); }
  if (excludeMeetingId) { conds.push('t.meeting_id != ?'); params.push(excludeMeetingId); }
  params.push(limit);
  return db
    .prepare(
      `SELECT t.id, t.meeting_id, t.speaker, t.text, t.created_at
         FROM warroom_transcript t
         JOIN warroom_meetings m ON m.id = t.meeting_id
        WHERE ${conds.join(' AND ')}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`,
    )
    .all(...params) as Array<{ id: number; meeting_id: string; speaker: string; text: string; created_at: number }>;
}

// ── Text War Room helpers ────────────────────────────────────────────
// Kept separate from createWarRoomMeeting so the text path can't accidentally
// inherit the voice default of pinned_agent='main'. A text meeting starts
// with NO pinned agent so the router is allowed to pick primary.

export function createTextMeeting(id: string, chatId = ''): void {
  db.prepare(
    `INSERT OR IGNORE INTO warroom_meetings
       (id, started_at, mode, pinned_agent, meeting_type, chat_id)
     VALUES (?, ?, 'direct', NULL, 'text', ?)`,
  ).run(id, Math.floor(Date.now() / 1000), chatId);
}

export function getTextMeeting(id: string): {
  id: string; started_at: number; ended_at: number | null; duration_s: number | null;
  mode: string; pinned_agent: string | null; entry_count: number; meeting_type: string;
  chat_id: string;
} | null {
  const row = db.prepare(
    `SELECT id, started_at, ended_at, duration_s, mode, pinned_agent, entry_count, meeting_type, chat_id
       FROM warroom_meetings WHERE id = ? AND meeting_type = 'text'`,
  ).get(id) as any;
  return row ?? null;
}

export function setMeetingPin(meetingId: string, agentId: string | null): void {
  db.prepare(
    `UPDATE warroom_meetings SET pinned_agent = ? WHERE id = ? AND meeting_type = 'text'`,
  ).run(agentId, meetingId);
}

/** Returns ids of every still-open text meeting except the optional
 *  exclusion. Optionally scope by chat_id so creating a new meeting in
 *  chat A does not auto-end open meetings belonging to chat B. The
 *  dashboard uses this to force-end stale meetings when the user creates
 *  a new one (refresh = clean slate within the same chat). */
export function getOpenTextMeetingIds(exceptId?: string, chatId?: string): string[] {
  const conds: string[] = [`meeting_type = 'text'`, `ended_at IS NULL`];
  const params: unknown[] = [];
  if (exceptId) { conds.push('id != ?'); params.push(exceptId); }
  if (chatId !== undefined) { conds.push('chat_id = ?'); params.push(chatId); }
  const rows = db.prepare(
    `SELECT id FROM warroom_meetings WHERE ${conds.join(' AND ')}`,
  ).all(...params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Recent text meetings, newest first. Includes a short preview of the
 *  first user message so the picker can show a recognizable label.
 *  Optionally scope by chat_id so the picker only shows meetings for the
 *  current chat. Pass chatId='' to see legacy/unscoped meetings; omit
 *  to include everything (admin/debug). */
export function getTextMeetings(limit = 20, chatId?: string): Array<{
  id: string;
  started_at: number;
  ended_at: number | null;
  entry_count: number;
  preview: string;
}> {
  const params: unknown[] = [];
  let where = `meeting_type = 'text'`;
  if (chatId !== undefined) { where += ` AND chat_id = ?`; params.push(chatId); }
  params.push(limit);
  const rows = db.prepare(
    `SELECT id, started_at, ended_at, entry_count
       FROM warroom_meetings
      WHERE ${where}
      ORDER BY started_at DESC
      LIMIT ?`,
  ).all(...params) as Array<{ id: string; started_at: number; ended_at: number | null; entry_count: number }>;
  if (rows.length === 0) return [];
  const previewStmt = db.prepare(
    `SELECT text FROM warroom_transcript
      WHERE meeting_id = ? AND speaker = 'user'
      ORDER BY created_at, id LIMIT 1`,
  );
  return rows.map((r) => {
    const p = previewStmt.get(r.id) as { text: string } | undefined;
    const preview = (p?.text ?? '').slice(0, 140);
    return { ...r, preview };
  });
}

export function clearMeetingSessions(meetingId: string, agentIds: string[]): number {
  if (agentIds.length === 0) return 0;
  const chatId = `warroom-text:${meetingId}`;
  const placeholders = agentIds.map(() => '?').join(',');
  const info = db.prepare(
    `DELETE FROM sessions WHERE chat_id = ? AND agent_id IN (${placeholders})`,
  ).run(chatId, ...agentIds);
  return info.changes;
}

// ── Client message dedup (in-memory LRU) ─────────────────────────────
// Sized for 10k concurrent conversations with rapid resends. 24h TTL means
// a user that retries a message a day later gets re-processed (acceptable).
// Not persisted across bot restarts — worst case a retry after restart
// double-processes; acceptable tradeoff vs a DB table for something this
// ephemeral.

const CLIENT_MSG_TTL_MS = 24 * 60 * 60 * 1000;
const CLIENT_MSG_MAX_ENTRIES = 10_000;
const _clientMsgSeen = new Map<string, number>(); // id -> expires_at

export function rememberClientMsgId(id: string, ttlMs = CLIENT_MSG_TTL_MS): boolean {
  const now = Date.now();
  // Reject anything that isn't a v4 UUID. Malformed IDs would otherwise
  // cache unbounded and become a DoS vector.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return false;
  }
  const existing = _clientMsgSeen.get(id);
  if (existing !== undefined && existing > now) return false; // duplicate
  _clientMsgSeen.set(id, now + ttlMs);
  // Opportunistic eviction: evict expired entries whenever we cross the cap.
  if (_clientMsgSeen.size > CLIENT_MSG_MAX_ENTRIES) {
    for (const [k, exp] of _clientMsgSeen) {
      if (exp <= now) _clientMsgSeen.delete(k);
      if (_clientMsgSeen.size <= CLIENT_MSG_MAX_ENTRIES) break;
    }
    // If still over cap after evicting expired entries, drop oldest-inserted
    // (Map iteration order is insertion order in ES2015+).
    while (_clientMsgSeen.size > CLIENT_MSG_MAX_ENTRIES) {
      const oldest = _clientMsgSeen.keys().next().value;
      if (oldest === undefined) break;
      _clientMsgSeen.delete(oldest);
    }
  }
  return true;
}

/** @internal for tests — clear the dedup cache. */
export function _resetClientMsgCache(): void {
  _clientMsgSeen.clear();
}

// ── Dashboard settings (personalization KV) ─────────────────────────

export function getDashboardSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM dashboard_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setDashboardSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function getAllDashboardSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM dashboard_settings`).all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function deleteDashboardSetting(key: string): void {
  db.prepare(`DELETE FROM dashboard_settings WHERE key = ?`).run(key);
}

// ── Specialist tier overrides ───────────────────────────────────────
// Stored in the dashboard_settings kv with a `specialist.<callsign>.tier`
// key prefix so the user can flip individual specialists between local
// (claw / direct-ollama) and cloud (paid Anthropic) without editing
// specialists.ts. Returning null means "no override; use the static
// default tier from SPECIALISTS[callsign].tier".
const SPECIALIST_TIER_KEY = (callsign: string) => `specialist.${callsign}.tier`;

export function getSpecialistTierOverride(callsign: string): string | null {
  return getDashboardSetting(SPECIALIST_TIER_KEY(callsign));
}

export function setSpecialistTierOverride(callsign: string, tier: string | null): void {
  const key = SPECIALIST_TIER_KEY(callsign);
  if (tier == null) {
    deleteDashboardSetting(key);
  } else {
    setDashboardSetting(key, tier);
  }
}

export function getAllSpecialistTierOverrides(): Record<string, string> {
  const rows = db.prepare(
    `SELECT key, value FROM dashboard_settings WHERE key LIKE 'specialist.%.tier'`,
  ).all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) {
    // key shape: specialist.<callsign>.tier
    const m = row.key.match(/^specialist\.([^.]+)\.tier$/);
    if (m) out[m[1]] = row.value;
  }
  return out;
}

// ── Agent file history (versioned backups in SQLite) ────────────────

export type AgentFileKind = 'claudemd' | 'agent-yaml';

export interface AgentFileHistoryRow {
  id: number;
  agent_id: string;
  file_kind: AgentFileKind;
  content: string;
  byte_size: number;
  sha256: string;
  author: string;
  created_at: number;
}

export function appendAgentFileHistory(
  agentId: string,
  fileKind: AgentFileKind,
  content: string,
  sha256: string,
  author = 'dashboard',
): number {
  const result = db.prepare(
    `INSERT INTO agent_file_history (agent_id, file_kind, content, byte_size, sha256, author)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, fileKind, content, Buffer.byteLength(content, 'utf8'), sha256, author);
  return Number(result.lastInsertRowid);
}

/** List versions newest-first. Excludes content by default to keep the
 *  payload small; callers fetch full content via getAgentFileHistory(id). */
export function listAgentFileHistory(
  agentId: string,
  fileKind: AgentFileKind,
  limit = 50,
): Array<Omit<AgentFileHistoryRow, 'content'>> {
  return db.prepare(
    `SELECT id, agent_id, file_kind, byte_size, sha256, author, created_at
     FROM agent_file_history
     WHERE agent_id = ? AND file_kind = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(agentId, fileKind, limit) as Array<Omit<AgentFileHistoryRow, 'content'>>;
}

export function getAgentFileHistory(id: number): AgentFileHistoryRow | null {
  const row = db.prepare(
    `SELECT * FROM agent_file_history WHERE id = ?`,
  ).get(id) as AgentFileHistoryRow | undefined;
  return row ?? null;
}

// ── Agent suggestions ──────────────────────────────────────────────

export interface AgentSuggestion {
  id: number;
  from_agent: string;
  suggested_id: string;
  suggested_name: string;
  suggested_description: string;
  reasoning: string;
  activity_share_pct: number | null;
  created_at: number;
  dismissed_at: number | null;
  acted_at: number | null;
}

export function insertAgentSuggestion(s: Omit<AgentSuggestion, 'id' | 'created_at' | 'dismissed_at' | 'acted_at'>): number {
  const r = db.prepare(
    `INSERT INTO agent_suggestions
       (from_agent, suggested_id, suggested_name, suggested_description, reasoning, activity_share_pct)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(s.from_agent, s.suggested_id, s.suggested_name, s.suggested_description, s.reasoning, s.activity_share_pct);
  return Number(r.lastInsertRowid);
}

export function listActiveAgentSuggestions(): AgentSuggestion[] {
  return db.prepare(
    `SELECT * FROM agent_suggestions
     WHERE dismissed_at IS NULL AND acted_at IS NULL
     ORDER BY created_at DESC`,
  ).all() as AgentSuggestion[];
}

export function dismissAgentSuggestion(id: number): boolean {
  const r = db.prepare(
    `UPDATE agent_suggestions SET dismissed_at = strftime('%s','now')
     WHERE id = ? AND dismissed_at IS NULL AND acted_at IS NULL`,
  ).run(id);
  return r.changes > 0;
}

export function markAgentSuggestionActed(id: number): boolean {
  const r = db.prepare(
    `UPDATE agent_suggestions SET acted_at = strftime('%s','now')
     WHERE id = ? AND acted_at IS NULL`,
  ).run(id);
  return r.changes > 0;
}

/** Used by the analyzer to skip re-suggesting splits the user already
 *  rejected or acted on. Returns the set of (from_agent, suggested_id)
 *  pairs that have any historical suggestion (active or not). */
export function getRecentlySuggestedSplits(daysBack = 30): Array<{ from_agent: string; suggested_id: string }> {
  return db.prepare(
    `SELECT from_agent, suggested_id FROM agent_suggestions
     WHERE created_at > strftime('%s','now') - (? * 86400)`,
  ).all(daysBack) as Array<{ from_agent: string; suggested_id: string }>;
}

/** Hard cap on retained versions per (agent, kind) so the table doesn't
 *  grow unboundedly. Called after each insert. */
export function pruneAgentFileHistory(
  agentId: string,
  fileKind: AgentFileKind,
  keep = 100,
): number {
  const result = db.prepare(
    `DELETE FROM agent_file_history
     WHERE id IN (
       SELECT id FROM agent_file_history
       WHERE agent_id = ? AND file_kind = ?
       ORDER BY created_at DESC, id DESC
       LIMIT -1 OFFSET ?
     )`,
  ).run(agentId, fileKind, keep);
  return result.changes;
}

// ── Edge Scanner ────────────────────────────────────────────────────────────

export interface EdgePair {
  id: string;
  kalshi_ticker: string;
  kalshi_title: string | null;
  poly_condition_id: string;
  poly_question: string | null;
  poly_event_slug: string | null;
  category: string | null;
  end_date: string | null;
  match_score: number | null;
  llm_confidence: number | null;
  status: 'candidate' | 'confirmed' | 'rejected';
  invert: number;
  created_at: number;
  updated_at: number;
}

export interface EdgeOpportunity {
  id: string;
  kind: string;
  ref: string;
  title: string | null;
  venue: string | null;
  category: string | null;
  detail: string | null;
  gross_edge: number | null;
  net_edge: number | null;
  depth_usd: number | null;
  first_seen: number;
  last_seen: number;
  max_net_edge: number | null;
  status: 'open' | 'closed';
  closed_at: number | null;
  alerted_at: number | null;
}

/** Insert a candidate pair if it doesn't exist yet. Returns the row. */
export function upsertEdgePair(p: {
  kalshiTicker: string;
  kalshiTitle: string | null;
  polyConditionId: string;
  polyQuestion: string | null;
  polyEventSlug: string | null;
  category: string | null;
  endDate: string | null;
  matchScore: number;
}): EdgePair {
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare(
    'SELECT * FROM edge_pairs WHERE kalshi_ticker = ? AND poly_condition_id = ?',
  ).get(p.kalshiTicker, p.polyConditionId) as EdgePair | undefined;
  if (existing) {
    db.prepare('UPDATE edge_pairs SET match_score = ?, updated_at = ? WHERE id = ?')
      .run(p.matchScore, now, existing.id);
    return { ...existing, match_score: p.matchScore, updated_at: now };
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO edge_pairs (id, kalshi_ticker, kalshi_title, poly_condition_id, poly_question,
       poly_event_slug, category, end_date, match_score, status, invert, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 0, ?, ?)`,
  ).run(id, p.kalshiTicker, p.kalshiTitle, p.polyConditionId, p.polyQuestion,
    p.polyEventSlug, p.category, p.endDate, p.matchScore, now, now);
  return db.prepare('SELECT * FROM edge_pairs WHERE id = ?').get(id) as EdgePair;
}

export function listEdgePairs(opts: { status?: string; limit?: number } = {}): EdgePair[] {
  const limit = Math.min(opts.limit ?? 200, 1000);
  if (opts.status) {
    return db.prepare('SELECT * FROM edge_pairs WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
      .all(opts.status, limit) as EdgePair[];
  }
  return db.prepare('SELECT * FROM edge_pairs ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as EdgePair[];
}

export function getEdgePair(id: string): EdgePair | null {
  return (db.prepare('SELECT * FROM edge_pairs WHERE id = ?').get(id) as EdgePair | undefined) ?? null;
}

export function updateEdgePair(
  id: string,
  patch: { status?: string; invert?: number; llm_confidence?: number | null },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
  if (patch.invert !== undefined) { sets.push('invert = ?'); vals.push(patch.invert); }
  if (patch.llm_confidence !== undefined) { sets.push('llm_confidence = ?'); vals.push(patch.llm_confidence); }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000), id);
  const res = db.prepare(`UPDATE edge_pairs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return res.changes > 0;
}

/** The open opportunity row for a (kind, ref), if any. */
export function getOpenEdgeOpportunity(kind: string, ref: string): EdgeOpportunity | null {
  return (db.prepare(
    "SELECT * FROM edge_opportunities WHERE kind = ? AND ref = ? AND status = 'open'",
  ).get(kind, ref) as EdgeOpportunity | undefined) ?? null;
}

export function createEdgeOpportunity(o: {
  kind: string;
  ref: string;
  title: string | null;
  venue: string;
  category: string | null;
  detail: string;
  grossEdge: number;
  netEdge: number;
  depthUsd: number | null;
}): EdgeOpportunity {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO edge_opportunities (id, kind, ref, title, venue, category, detail,
       gross_edge, net_edge, depth_usd, first_seen, last_seen, max_net_edge, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(id, o.kind, o.ref, o.title, o.venue, o.category, o.detail,
    o.grossEdge, o.netEdge, o.depthUsd, now, now, o.netEdge);
  return db.prepare('SELECT * FROM edge_opportunities WHERE id = ?').get(id) as EdgeOpportunity;
}

/** Refresh a persisting opportunity: last_seen, current edges, max watermark. */
export function touchEdgeOpportunity(
  id: string,
  grossEdge: number,
  netEdge: number,
  depthUsd: number | null,
  detail: string,
): void {
  db.prepare(
    `UPDATE edge_opportunities
     SET last_seen = ?, gross_edge = ?, net_edge = ?, depth_usd = ?, detail = ?,
         max_net_edge = MAX(COALESCE(max_net_edge, 0), ?)
     WHERE id = ?`,
  ).run(Math.floor(Date.now() / 1000), grossEdge, netEdge, depthUsd, detail, netEdge, id);
}

/** Close every open opportunity of the given kinds NOT in seenIds (it vanished this scan). */
export function closeVanishedEdgeOpportunities(kinds: string[], seenIds: Set<string>): number {
  if (!kinds.length) return 0;
  const open = db.prepare(
    `SELECT id FROM edge_opportunities WHERE status = 'open' AND kind IN (${kinds.map(() => '?').join(',')})`,
  ).all(...kinds) as Array<{ id: string }>;
  const now = Math.floor(Date.now() / 1000);
  const close = db.prepare("UPDATE edge_opportunities SET status = 'closed', closed_at = ? WHERE id = ?");
  let n = 0;
  for (const row of open) {
    if (!seenIds.has(row.id)) { close.run(now, row.id); n++; }
  }
  return n;
}

export function markEdgeOpportunityAlerted(id: string): void {
  db.prepare('UPDATE edge_opportunities SET alerted_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), id);
}

/** Most recent alert timestamp across ALL rows (open and closed) for a
 *  (kind, ref). Cooldown must survive an opportunity closing and reopening
 *  as a new row, otherwise a flapping market re-alerts every scan. */
export function lastEdgeAlertTs(kind: string, ref: string): number | null {
  const row = db.prepare(
    'SELECT MAX(alerted_at) AS ts FROM edge_opportunities WHERE kind = ? AND ref = ?',
  ).get(kind, ref) as { ts: number | null };
  return row.ts ?? null;
}

export function listEdgeOpportunities(opts: {
  status?: string;
  kind?: string;
  limit?: number;
  offset?: number;
} = {}): { rows: EdgeOpportunity[]; total: number } {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.status) { where.push('status = ?'); vals.push(opts.status); }
  if (opts.kind) { where.push('kind = ?'); vals.push(opts.kind); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM edge_opportunities ${w}`).get(...vals) as { n: number }).n;
  const rows = db.prepare(
    `SELECT * FROM edge_opportunities ${w} ORDER BY status = 'open' DESC, net_edge DESC, last_seen DESC LIMIT ? OFFSET ?`,
  ).all(...vals, Math.min(opts.limit ?? 100, 500), opts.offset ?? 0) as EdgeOpportunity[];
  return { rows, total };
}

export function upsertEdgeStats(row: {
  kalshiMarkets: number;
  polyEvents: number;
  pairsCandidate: number;
  pairsConfirmed: number;
  oppsOpen: number;
  oppsNew: number;
  bestNetEdge: number | null;
}): void {
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  db.prepare(
    `INSERT INTO edge_stats (ts, kalshi_markets, poly_events, pairs_candidate, pairs_confirmed, opps_open, opps_new, best_net_edge)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ts) DO UPDATE SET
       kalshi_markets = excluded.kalshi_markets,
       poly_events = excluded.poly_events,
       pairs_candidate = excluded.pairs_candidate,
       pairs_confirmed = excluded.pairs_confirmed,
       opps_open = excluded.opps_open,
       opps_new = MAX(edge_stats.opps_new, excluded.opps_new),
       best_net_edge = MAX(COALESCE(edge_stats.best_net_edge, 0), COALESCE(excluded.best_net_edge, 0))`,
  ).run(hour, row.kalshiMarkets, row.polyEvents, row.pairsCandidate, row.pairsConfirmed,
    row.oppsOpen, row.oppsNew, row.bestNetEdge);
}

export function listEdgeStats(hours = 72): Array<Record<string, number | null>> {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.prepare('SELECT * FROM edge_stats WHERE ts >= ? ORDER BY ts ASC')
    .all(cutoff) as Array<Record<string, number | null>>;
}

export function edgeSummaryCounts(): {
  pairs_candidate: number; pairs_confirmed: number; opps_open: number; opps_closed: number;
} {
  const pc = (db.prepare("SELECT COUNT(*) AS n FROM edge_pairs WHERE status = 'candidate'").get() as { n: number }).n;
  const pf = (db.prepare("SELECT COUNT(*) AS n FROM edge_pairs WHERE status = 'confirmed'").get() as { n: number }).n;
  const oo = (db.prepare("SELECT COUNT(*) AS n FROM edge_opportunities WHERE status = 'open'").get() as { n: number }).n;
  const oc = (db.prepare("SELECT COUNT(*) AS n FROM edge_opportunities WHERE status = 'closed'").get() as { n: number }).n;
  return { pairs_candidate: pc, pairs_confirmed: pf, opps_open: oo, opps_closed: oc };
}

// ── Edge paper trading ──────────────────────────────────────────────────────

export interface EdgePaperTrade {
  id: string;
  opportunity_id: string | null;
  kalshi_ticker: string;
  title: string | null;
  category: string | null;
  side: 'yes' | 'no' | 'arb';
  qty: number;
  entry_price: number;
  entry_fee: number;
  entry_poly_fair: number | null;
  edge_captured: number | null;
  opened_at: number;
  status: 'open' | 'closed' | 'settled';
  mark_price: number | null;
  marked_at: number | null;
  exit_price: number | null;
  exit_fee: number | null;
  exit_reason: string | null;
  result: string | null;
  realized_pnl: number | null;
  closed_at: number | null;
}

export function createPaperTrade(t: {
  opportunityId: string | null;
  kalshiTicker: string;
  title: string | null;
  category: string | null;
  side: 'yes' | 'no' | 'arb';
  qty: number;
  entryPrice: number;
  entryFee: number;
  entryPolyFair: number | null;
  edgeCaptured: number | null;
}): EdgePaperTrade {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO edge_paper_trades (id, opportunity_id, kalshi_ticker, title, category, side,
       qty, entry_price, entry_fee, entry_poly_fair, edge_captured, opened_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(id, t.opportunityId, t.kalshiTicker, t.title, t.category, t.side,
    t.qty, t.entryPrice, t.entryFee, t.entryPolyFair, t.edgeCaptured, Math.floor(Date.now() / 1000));
  return db.prepare('SELECT * FROM edge_paper_trades WHERE id = ?').get(id) as EdgePaperTrade;
}

export function openPaperTrades(): EdgePaperTrade[] {
  return db.prepare("SELECT * FROM edge_paper_trades WHERE status = 'open' ORDER BY opened_at ASC")
    .all() as EdgePaperTrade[];
}

export function hasOpenPaperTrade(kalshiTicker: string): boolean {
  return !!db.prepare("SELECT 1 FROM edge_paper_trades WHERE status = 'open' AND kalshi_ticker = ?")
    .get(kalshiTicker);
}

export function markPaperTrade(id: string, markPrice: number): void {
  db.prepare('UPDATE edge_paper_trades SET mark_price = ?, marked_at = ? WHERE id = ?')
    .run(markPrice, Math.floor(Date.now() / 1000), id);
}

export function closePaperTrade(
  id: string,
  patch: { status: 'closed' | 'settled'; exitPrice: number | null; exitFee: number; exitReason: string; result?: string | null; realizedPnl: number },
): EdgePaperTrade | null {
  db.prepare(
    `UPDATE edge_paper_trades
     SET status = ?, exit_price = ?, exit_fee = ?, exit_reason = ?, result = ?, realized_pnl = ?, closed_at = ?
     WHERE id = ? AND status = 'open'`,
  ).run(patch.status, patch.exitPrice, patch.exitFee, patch.exitReason, patch.result ?? null,
    patch.realizedPnl, Math.floor(Date.now() / 1000), id);
  return (db.prepare('SELECT * FROM edge_paper_trades WHERE id = ?').get(id) as EdgePaperTrade | undefined) ?? null;
}

export function listPaperTrades(opts: { status?: string; limit?: number } = {}): EdgePaperTrade[] {
  const limit = Math.min(opts.limit ?? 200, 1000);
  if (opts.status) {
    return db.prepare('SELECT * FROM edge_paper_trades WHERE status = ? ORDER BY opened_at DESC LIMIT ?')
      .all(opts.status, limit) as EdgePaperTrade[];
  }
  return db.prepare("SELECT * FROM edge_paper_trades ORDER BY status = 'open' DESC, opened_at DESC LIMIT ?")
    .all(limit) as EdgePaperTrade[];
}

/** Book summary computed straight from the trades table (no separate balance state to drift). */
export function paperBookSummary(startBalance: number): {
  start_balance: number;
  cash: number;
  open_cost: number;
  open_count: number;
  realized_pnl: number;
  closed_count: number;
  edge_captured_total: number;
  directional_residual_total: number;
} {
  const open = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(entry_price * qty + entry_fee), 0) AS cost FROM edge_paper_trades WHERE status = 'open'",
  ).get() as { n: number; cost: number };
  const closed = db.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(realized_pnl), 0) AS pnl,
            COALESCE(SUM(edge_captured), 0) AS edge
     FROM edge_paper_trades WHERE status != 'open'`,
  ).get() as { n: number; pnl: number; edge: number };
  // Cash accounting: only OPEN trades hold cash hostage (their entry cost);
  // a closed trade's cost came back as proceeds, so its net cash effect is
  // exactly its realized pnl.
  return {
    start_balance: startBalance,
    cash: startBalance - open.cost + closed.pnl,
    open_cost: open.cost,
    open_count: open.n,
    realized_pnl: closed.pnl,
    closed_count: closed.n,
    edge_captured_total: closed.edge,
    directional_residual_total: closed.pnl - closed.edge,
  };
}

// ── AI agency: client pipeline ──────────────────────────────────────────────

export interface Client {
  id: string;
  company: string;
  contact_name: string | null;
  contact_role: string | null;
  contact_info: string | null;
  industry: string | null;
  location: string | null;
  stage: string;
  pain_points: string | null;
  notes: string | null;
  next_action: string | null;
  next_action_due: number | null;
  monthly_value: number | null;
  contacted_at: number | null;
  replied_at: number | null;
  last_touch_at: number | null;
  next_touch_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClientArtifact {
  id: string;
  client_id: string;
  kind: string;
  title: string | null;
  content: string | null;
  created_at: number;
}

export const CLIENT_STAGES = ['lead', 'contacted', 'pitched', 'pilot', 'active', 'closed_won', 'closed_lost'] as const;

export function createClient(c: {
  company: string;
  contactName?: string | null;
  contactRole?: string | null;
  contactInfo?: string | null;
  industry?: string | null;
  location?: string | null;
  stage?: string;
  painPoints?: string | null;
  notes?: string | null;
}): Client {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO clients (id, company, contact_name, contact_role, contact_info, industry, location,
       stage, pain_points, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, c.company, c.contactName ?? null, c.contactRole ?? null, c.contactInfo ?? null,
    c.industry ?? null, c.location ?? null, c.stage ?? 'lead', c.painPoints ?? null, c.notes ?? null, now, now);
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as Client;
}

export function getClient(id: string): Client | null {
  return (db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as Client | undefined) ?? null;
}

export function listClients(stage?: string): Client[] {
  if (stage) {
    return db.prepare('SELECT * FROM clients WHERE stage = ? ORDER BY updated_at DESC').all(stage) as Client[];
  }
  return db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all() as Client[];
}

export function updateClient(id: string, patch: Partial<Omit<Client, 'id' | 'created_at' | 'updated_at'>>): boolean {
  const allowed = ['company', 'contact_name', 'contact_role', 'contact_info', 'industry', 'location',
    'stage', 'pain_points', 'notes', 'next_action', 'next_action_due', 'monthly_value',
    'contacted_at', 'replied_at', 'last_touch_at', 'next_touch_at'] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (k in patch) { sets.push(`${k} = ?`); vals.push((patch as Record<string, unknown>)[k] ?? null); }
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000), id);
  return db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

export function deleteClient(id: string): boolean {
  db.prepare('DELETE FROM client_artifacts WHERE client_id = ?').run(id);
  return db.prepare('DELETE FROM clients WHERE id = ?').run(id).changes > 0;
}

export function createClientArtifact(clientId: string, kind: string, title: string | null, content: string | null): ClientArtifact {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO client_artifacts (id, client_id, kind, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, clientId, kind, title, content, Math.floor(Date.now() / 1000));
  db.prepare('UPDATE clients SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), clientId);
  return db.prepare('SELECT * FROM client_artifacts WHERE id = ?').get(id) as ClientArtifact;
}

export function listClientArtifacts(clientId: string): ClientArtifact[] {
  return db.prepare('SELECT * FROM client_artifacts WHERE client_id = ? ORDER BY created_at DESC')
    .all(clientId) as ClientArtifact[];
}

export function getClientArtifact(id: string): ClientArtifact | null {
  return (db.prepare('SELECT * FROM client_artifacts WHERE id = ?').get(id) as ClientArtifact | undefined) ?? null;
}

export function updateClientArtifact(id: string, patch: { title?: string | null; content?: string | null }): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('title' in patch) { sets.push('title = ?'); vals.push(patch.title ?? null); }
  if ('content' in patch) { sets.push('content = ?'); vals.push(patch.content ?? null); }
  if (!sets.length) return false;
  vals.push(id);
  return db.prepare(`UPDATE client_artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

// ── usage_ledger: measured cloud-token burn, one row per model call ──

export interface UsageLedgerRow {
  id: number;
  ts: number;
  scope: string;
  ref_id: string | null;
  leg: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_weight: number | null;
  duration_ms: number | null;
  retries: number;
  meta: string | null;
}

export function insertUsageLedger(row: {
  scope: string;
  refId?: string | null;
  leg?: string | null;
  model?: string | null;
  tokensIn: number;
  tokensOut: number;
  costWeight?: number | null;
  durationMs?: number | null;
  retries?: number;
  meta?: string | null;
}): void {
  db.prepare(
    `INSERT INTO usage_ledger (ts, scope, ref_id, leg, model, tokens_in, tokens_out, cost_weight, duration_ms, retries, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(Math.floor(Date.now() / 1000), row.scope, row.refId ?? null, row.leg ?? null, row.model ?? null,
    row.tokensIn, row.tokensOut, row.costWeight ?? null, row.durationMs ?? null, row.retries ?? 0, row.meta ?? null);
}

export function listUsageLedger(refId: string): UsageLedgerRow[] {
  return db.prepare('SELECT * FROM usage_ledger WHERE ref_id = ? ORDER BY ts ASC').all(refId) as UsageLedgerRow[];
}

// ── psyop_scores: NCI Engineered Reality Scoring System runs ──────────

export interface PsyopScore {
  id: string;
  subject: string;
  input_text: string | null;
  source_url: string | null;
  status: string;            // scoring | ready | failed
  total: number | null;
  band: string | null;
  local_json: string | null;
  final_json: string | null;
  model_local: string | null;
  model_verify: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function createPsyopScore(row: { id: string; subject: string; inputText?: string | null; sourceUrl?: string | null }): PsyopScore {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO psyop_scores (id, subject, input_text, source_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'scoring', ?, ?)`,
  ).run(row.id, row.subject, row.inputText ?? null, row.sourceUrl ?? null, now, now);
  return getPsyopScore(row.id)!;
}

export function getPsyopScore(id: string): PsyopScore | undefined {
  return db.prepare('SELECT * FROM psyop_scores WHERE id = ?').get(id) as PsyopScore | undefined;
}

export function updatePsyopScore(
  id: string,
  patch: Partial<Omit<PsyopScore, 'id' | 'created_at' | 'updated_at'>>,
): boolean {
  const cols = ['subject', 'input_text', 'source_url', 'status', 'total', 'band', 'local_json', 'final_json', 'model_local', 'model_verify', 'error'] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of cols) {
    if (patch[key] !== undefined) { sets.push(`${key} = ?`); vals.push(patch[key]); }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(id);
  return db.prepare(`UPDATE psyop_scores SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

export function listPsyopScores(limit = 50): PsyopScore[] {
  return db.prepare('SELECT * FROM psyop_scores ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 200)) as PsyopScore[];
}

export function deletePsyopScore(id: string): boolean {
  return db.prepare('DELETE FROM psyop_scores WHERE id = ?').run(id).changes > 0;
}

/** Totals since a timestamp (epoch s), optionally per scope. weighted_out =
 *  sum(tokens_out * cost_weight) — comparable "fable-equivalent" output burn. */
export function sumUsageSince(sinceTs: number, scope?: string): {
  jobs: number; legs: number; tokens_in: number; tokens_out: number; weighted_out: number;
} {
  const where = scope ? 'WHERE ts >= ? AND scope = ?' : 'WHERE ts >= ?';
  const args = scope ? [sinceTs, scope] : [sinceTs];
  return db.prepare(
    `SELECT COUNT(DISTINCT ref_id) AS jobs, COUNT(*) AS legs,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(tokens_out * COALESCE(cost_weight, 1.0)), 0) AS weighted_out
     FROM usage_ledger ${where}`,
  ).get(...args) as { jobs: number; legs: number; tokens_in: number; tokens_out: number; weighted_out: number };
}

/** Research jobs are artifacts whose content JSON carries a status field;
 *  the worker scans for queued/running ones (running = crashed mid-run). */
export function pendingResearchArtifacts(): ClientArtifact[] {
  return db.prepare(
    `SELECT * FROM client_artifacts
     WHERE kind IN ('deep_dive', 'full_pitch', 'demo_site')
       AND (content LIKE '%"status":"queued"%' OR content LIKE '%"status":"running"%')
     ORDER BY created_at ASC`,
  ).all() as ClientArtifact[];
}

export function deleteClientArtifact(id: string): boolean {
  return db.prepare('DELETE FROM client_artifacts WHERE id = ?').run(id).changes > 0;
}
