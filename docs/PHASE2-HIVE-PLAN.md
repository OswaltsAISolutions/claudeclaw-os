# PHASE 2 — Live Cross-PC Hive Link (Implementation Plan)

Status: ready to build. Owner: Gabe. Implementation host: Main PC (WSL). Last updated: 2026-06-17.

This plan is the single source of truth for Phase 2. It folds in every adversarial verdict and corrects the factual errors found in the component designs (zod IS in the repo; the vite `/api` proxy already covers `/api/hive/*`; `test-env-setup.ts` does NOT set `HIVE_TOKEN`; `SESSION-REGISTRY.md` is a structured table, not a free-form log; the existing `/api/` auth gate reads the query param ONLY and never the `Authorization` header).

---

## 0. Source Sync (verified against current HEAD — READ FIRST)

This plan was drafted against the repo snapshot at the clone point (commit `90a4ba6`). Immediately afterward the Main PC pushed `1be8946` ("commit live application source so the repo matches the running service"), which added the fuller running-service code: `src/db.ts` +1,577 lines, `src/dashboard.ts` +1,083, `src/config.ts` +34, `src/index.ts` +35. The design was then re-verified against that current HEAD.

**No conflicts. The design is fully valid as written.** Confirmed against current HEAD: no `hive_sessions`/`hive_notes` table exists yet; no `/api/hive/` route, `HIVE_TOKEN`, or `HIVE_ENABLED` exists yet; the auth model is UNCHANGED (the `/api/` gate still checks `safeTokenEqual(token, DASHBOARD_TOKEN)` via `?token=` only, no Authorization header); and `createSchema()`, `_initTestDatabase()`, the mutation kill-switch, `DASHBOARD_BIND`/non-loopback guard, `checkPendingMigrations` order, and `ALL_SWITCHES` all still exist with the same semantics.

**Only line numbers shifted.** Prefer this remap (current HEAD) over the inline numbers in sections 4-5. Better still, re-locate each anchor by SYMBOL at implementation time, since the Main PC may push again before the build.

| Anchor | Inline ref (old snapshot) | Current HEAD |
|---|---|---|
| `safeTokenEqual` definition | dashboard.ts:210-214 | dashboard.ts:270 |
| `/api/` auth gate (insert the `/api/hive/` exemption at its top) | dashboard.ts:343-355 | dashboard.ts ~405-415 (DASHBOARD_TOKEN check at 411) |
| `requireToken` helper (hive middleware goes just after) | dashboard.ts:~366 | dashboard.ts ~417-425 (check at 422) |
| `mutationReadonlyExempt` set + mutation gate | dashboard.ts:374-393 | dashboard.ts:434+ |
| `/api/hive-mind` block (insert new `/api/hive/*` routes AFTER it) | dashboard.ts:4001-4006 | dashboard.ts:5072+ |
| `DASHBOARD_BIND` + `serve()` + non-loopback warning | dashboard.ts:4277-4286 | dashboard.ts:5348-5357 |
| `createSchema()` (add the two tables inside it) | db.ts:~450 | db.ts:70 (fn start); `hive_mind` precedent at 192 |
| `_initTestDatabase()` | db.ts:793-800 | db.ts:1121 |
| `getOtherAgentActivity` (append hive DAL after it) | db.ts:2066 | db.ts:2381 |
| `readEnvFile([...])` array | config.ts:7-41 | config.ts:7 (`PROTECTED_ENV_VARS` key at 37) |
| `DASHBOARD_TOKEN` export | config.ts:177 | config.ts:211 |
| `PROTECTED_ENV_VARS` export | config.ts:261-264 | config.ts:295 |
| `KillSwitch` union / `ALL_SWITCHES` | kill-switches.ts:20-35 | kill-switches.ts:20 / 28 (unchanged) |
| `checkPendingMigrations` / `initDatabase` order | index.ts:116 / 134 | index.ts:116 / 134 (unchanged) |

---

## 1. Context + Goal

### Where we are (Phase 1, done, off-limits)
The ClaudeClaw service runs ONLY on the Main PC inside WSL (`/home/gcruise/repos/claudeclaw-os`) as the systemd `--user` unit `com.claudeclaw.main.service`. It is a Hono HTTP server (`hono` + `@hono/node-server`) plus a grammy Telegram bot plus a Preact dashboard at `http://127.0.0.1:3141`, with state in SQLite via `better-sqlite3` (`store/claudeclaw.db`). Other PCs coordinate today only asynchronously through this git repo's `docs/` folder — specifically `docs/SESSION-REGISTRY.md` (a table, one row per active session) and the notes convention in `SESSIONS.md`. That is Layer 1 and it stays.

### What Phase 2 adds
A LIVE cross-PC link. The Main PC service becomes a private hub, reachable by the other two PCs over Tailscale. Three new endpoints let off-PC Claude sessions post and read live coordination state:

- `POST /api/hive/register` — register a session and heartbeat it (idempotent upsert).
- `GET  /api/hive/status` — read the live session registry (self-expiring).
- `POST /api/hive/notes` / `GET /api/hive/notes` — post and read cross-PC notes addressed to a lane.

Plus: a heartbeat so the registry self-expires, a boot hook that auto-pulls the git docs and prints the live registry at session start, and an OPTIONAL cross-PC memory surface (clearly deferred, section 7).

### Hard rules this plan respects (non-negotiable)
1. Additive schema ONLY. New tables and columns. Never alter or drop existing tables or columns belonging to other lanes (finance / content / psyop).
2. Gate before build. `npx tsc --noEmit` + `npx tsc -p web/tsconfig.json` + `npx vitest run` must ALL pass before `npm run build`. A build compiles every lane.
3. Never break other lanes. Shared files (`dashboard.ts`, `db.ts`, `index.ts`, `App.tsx`, `routes.ts`, `config.ts`, `kill-switches.ts`) get ADDITIVE edits only.
4. NEVER expose the service to the public internet. Tailscale is a private overlay. Auth EVERY hive endpoint with a shared secret.
5. Must degrade gracefully. If the hub is unreachable, sessions fall back to Phase-1 git-doc coordination and never block.

### Honest effort + risk read
This is roughly a 1 to 2 day build for one focused session on the Main PC, plus 1 to 2 hours each to set up the two spokes. The schema and routes are low risk (purely additive, well-precedented in the codebase). The two genuinely risky areas are (a) WSL2 + Tailscale reachability, which depends on an environment fact we cannot confirm from the repo, and (b) the auth wiring, which has one load-bearing decision (see section 5). Everything else is mechanical.

---

## 2. Architecture Overview

One hub, two spokes. The hub is the only machine that runs the service, owns the SQLite DB, and produces embeddings. The spokes are HTTP-only clients that never touch the DB file. This split is forced by code, not preference: the existing off-PC CLIs (`mission-cli`, `schedule-cli`, `specialist-cli`) all call `initDatabase()` and open the shared SQLite file directly (`src/db.ts:455-460`), which also calls `getEncryptionKey()` and throws if `DB_ENCRYPTION_KEY` is missing (`src/db.ts:457-458`). No remote PC has that file or that key, so all cross-PC writes MUST funnel through the hub's HTTP handlers.

```
                       TAILSCALE PRIVATE OVERLAY (100.x.y.z, ACL-locked)
                       no public ingress, Funnel OFF

   ┌──────────────────────────────┐
   │  MAIN PC  (RTX 5080, 64GB)    │   tailscaled runs INSIDE WSL
   │  ┌────────────────────────┐  │   node hostname: claudeclaw-main (MagicDNS)
   │  │ WSL2 (Ubuntu)          │  │
   │  │  com.claudeclaw.main   │  │
   │  │   Hono :3141 (loopback)│◄─┼─── tailscale serve --https=443 -> 127.0.0.1:3141
   │  │   SQLite claudeclaw.db │  │        (reverse proxy, same netns, no NAT crossing)
   │  │   Ollama (bge-m3)      │  │
   │  │   /api/hive/* handlers │  │
   │  └────────────────────────┘  │
   └───────────▲──────────▲───────┘
               │ HTTPS     │ HTTPS          all hive calls auth with the shared
               │ ?token=   │ ?token=        secret in the QUERY param (the only
               │           │                auth path the server actually reads)
   ┌───────────┴────┐  ┌───┴──────────────┐
   │  DESKTOP 2     │  │  GAMING LAPTOP   │
   │  i5, 3050 4GB  │  │  R9, RX6700S     │   curl / PowerShell hive client
   │  always-on     │  │  no CUDA, mobile │   NO Node service, NO DB file
   │  host=desktop2 │  │  host=laptop     │   on hub-down -> Layer-1 git docs
   └────────────────┘  └──────────────────┘
            │                   │
            └─── git pull/push ─┴──────────► docs/SESSION-REGISTRY.md  (Layer 1 fallback)
```

Key properties:
- The Hono listener stays bound to `127.0.0.1` (its safe default at `dashboard.ts:4277`). `tailscale serve` runs in the SAME WSL network namespace and reverse-proxies the loopback service onto the tailnet. This means we do NOT set `DASHBOARD_BIND` to a non-loopback address, so we never trip the non-loopback security warning (`dashboard.ts:4278-4283`) and never widen the listen surface.
- Tailscale Funnel is never enabled. That is the line between "private overlay" and "public internet."
- Spokes are CLI-only (curl / PowerShell). They send no `Origin` header, so the CSRF middleware treats them as same-origin and allows their POSTs (`dashboard.ts` CSRF block).

---

## 3. Per-PC Setup (what to install where)

### Main PC (hub) — install / confirm
| Component | State | Action |
|---|---|---|
| ClaudeClaw service | already runs | Confirm the real systemd unit name on the box. The only in-repo reference (`scripts/status.ts:172`) checks `claudeclaw`, NOT `com.claudeclaw.main.service`. Verify with `systemctl --user status` before wiring any restart step. |
| Ollama + `bge-m3` | already present | Stays hub-only. Embeddings (`embeddings.ts:51`) and `buildMemoryContext` (`memory.ts:167`) remain hub-internal. |
| Tailscale (inside WSL) | install | `curl -fsSL https://tailscale.com/install.sh | sh`. Run the daemon INSIDE the WSL VM so the node gets its own stable MagicDNS name and there is no Windows-to-WSL NAT crossing to maintain. |
| `tailscale serve` | configure | Reverse-proxy loopback onto the tailnet (section 4, step 8). |

### Desktop 2 (always-on second lane) — install
1. Tailscale (join tailnet).
2. Node LTS + Claude Code (it has only git today). Node is for running Claude Code sessions and the thin hive client. It does NOT run the service and does NOT open the DB.
3. git — already present, keep for Layer-1 fallback.

Do NOT install Ollama or run a local LLM here. A 4GB RTX 3050 with 8GB system RAM cannot host a useful abliterated model; it would thrash. This box's value is uptime as a coordinator and a second session lane, not inference.

### Gaming laptop (mobile + CPU overflow) — install
1. Tailscale (roams fine; reaches the hub over the tailnet from anywhere).
2. Node + Claude Code.
3. git — most important here, since the laptop is the machine most likely to be off-tailnet on flaky wifi, so its Layer-1 fallback must be solid.

Do NOT treat AMD-no-CUDA inference as a pillar. ROCm on a mobile RX 6700S is fragile and nothing in this codebase targets it. Use the laptop's strong CPU for CPU-bound overflow work as a Claude Code worker; ignore its GPU for hive purposes.

### Spoke client install (Desktop 2 + laptop)
No Node-based DB tooling. The spoke is curl + bash (laptop / WSL) or curl + PowerShell (Desktop 2, no curl dependency via `Invoke-RestMethod`). The only HTTP-to-service precedent in the repo is `scripts/notify.sh` (`curl -s -m 5 -w '%{http_code}'`, shared secret in the request, success gated on `200`, with a graceful fallback). That is the template.

---

## 4. Build Steps IN ORDER

Each step names the exact files and the additive change. Do them in this sequence on the Main PC. Steps 1 to 6 are code (gate-before-build applies). Steps 7 to 9 are config and spoke setup.

### Step 1 — Config: register the new secrets and tunables
File: `src/config.ts`

(a) Add to the `readEnvFile([...])` key array (the array that currently ends near `STREAM_STRATEGY`, around `config.ts:7-41`). This is mandatory: under systemd, `process.env` is NOT populated from `.env`, so anything not in this array reads empty at runtime.
```
'HIVE_TOKEN',
'HIVE_TTL_MINUTES',
```
(b) Export the constants next to `DASHBOARD_TOKEN` (around `config.ts:177`):
```ts
export const HIVE_TOKEN =
  process.env.HIVE_TOKEN || envConfig.HIVE_TOKEN || '';
export const HIVE_TTL_MINUTES = parseInt(
  process.env.HIVE_TTL_MINUTES || envConfig.HIVE_TTL_MINUTES || '5',
  10,
);
```
(c) Harden: add `HIVE_TOKEN` to the `PROTECTED_ENV_VARS` default list (`config.ts:261-264`) so the exfiltration guard redacts it if a handler or agent ever echoes config. `HIVE_TOKEN` ends in `_TOKEN`, so it is already auto-scrubbed from `claude` SDK subprocess env by the `/_TOKEN$/` pattern in `security.ts` (good), but the outbound exfil scanner does not protect it by default. This is the one extra line that closes that gap.

### Step 2 — Kill switch: add a hot off-switch for the whole hive surface
File: `src/kill-switches.ts`

Add `HIVE_ENABLED` to BOTH the `KillSwitch` union (`:20-26`) and `ALL_SWITCHES` (`:28-35`). Kill-switches re-read `.env` every 1.5s (`TTL_MS=1500`), so flipping `HIVE_ENABLED=false` in `.env` disables the whole hive surface in under 2 seconds without a service restart. This matters because `HIVE_TOKEN` is a plain config constant read once at boot, so removing the token from `.env` does NOT take effect live. `HIVE_ENABLED` is the only hot per-spoke-disable lever. `isEnabled()` defaults unset switches to ENABLED, so existing behavior is unchanged.

### Step 3 — DB schema: two additive tables in `createSchema()`
File: `src/db.ts`

These MUST go in `createSchema()` (the template string, before its closing backtick at `db.ts:450`, e.g. right after the `session_summaries` block), NOT only in a versioned migration file. Reason: `createSchema()` runs on every startup via `initDatabase()` AND in the in-memory test DB via `_initTestDatabase()` (`db.ts:793-800`), which the vitest gate uses. A table that exists only in a versioned migration would be absent from fresh installs and from the test DB, failing the gate.

Use `read_flag` (not the SQL keyword `read`) to avoid a latent footgun. Timestamps are unix SECONDS (`Math.floor(Date.now()/1000)`), matching `hive_mind` / `token_usage`. These tables are DISTINCT from the existing append-only `hive_mind` table and the `/api/hive-mind` feed — do not overload either.

```sql
    -- Phase 2: live cross-PC session registry (upsert by pc+lane; heartbeat
    -- bumps last_seen). Self-expiry is computed at READ time, never deleted.
    CREATE TABLE IF NOT EXISTS hive_sessions (
      pc            TEXT NOT NULL,            -- 'main' | 'desktop2' | 'laptop'
      lane          TEXT NOT NULL,            -- 'finance' | 'content' | 'psyop' | ...
      status        TEXT NOT NULL DEFAULT 'online',
      working_on    TEXT,
      model         TEXT,
      session_id    TEXT,
      started_at    INTEGER NOT NULL,
      last_seen     INTEGER NOT NULL,
      PRIMARY KEY (pc, lane)
    );
    CREATE INDEX IF NOT EXISTS idx_hive_sessions_seen ON hive_sessions(last_seen DESC);

    -- Phase 2: cross-PC notes, addressed to a lane (NULL to_lane = broadcast).
    CREATE TABLE IF NOT EXISTS hive_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_pc     TEXT NOT NULL,
      from_lane   TEXT,
      to_lane     TEXT,
      body        TEXT NOT NULL,
      read_flag   INTEGER NOT NULL DEFAULT 0,
      tags        TEXT NOT NULL DEFAULT '[]',
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hive_notes_inbox ON hive_notes(to_lane, read_flag, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hive_notes_time ON hive_notes(created_at DESC);
```

The `PRIMARY KEY (pc, lane)` upsert model mirrors the existing `sessions(chat_id, agent_id)` precedent (`db.ts:526`) and matches the task's column list (no `session_id` in the registry key). See Open Decision D1 if a single PC must run multiple concurrent sessions in the same lane.

DO NOT bump `migrations/version.json`. It is currently empty (`{"migrations":{}}`). Adding a version key makes `checkPendingMigrations` (called in `index.ts:116`, before `initDatabase()` at `:134`) call `process.exit(1)` on every PC until `npm run migrate` runs there. A service that hard-exits cannot fall back to Layer-1 git docs, which would violate hard rule 5. `createSchema()` auto-applies the tables with zero ceremony. (An optional paper-trail migration via the `add-migration` skill is possible later but is explicitly NOT recommended for this rollout.)

### Step 4 — DB DAL helpers
File: `src/db.ts`

Append a new section after `getOtherAgentActivity` (around `db.ts:2066`). These are new exported functions only; no existing signature changes. They are invoked ONLY by the Main-PC hub process (the Hono `/api/hive/*` handlers), never by a remote SQLite connection. Add a one-line comment saying exactly that so nobody clones the local-`initDatabase()` CLI pattern off-box.

```ts
// ── Hive (Phase 2 live cross-PC link) ──────────────────────────────────
// Invoked ONLY by the Main-PC hub via the Hono /api/hive/* handlers.
// Never call these from a remote process — off-PC nodes have no DB file.

export interface HiveSession {
  pc: string; lane: string; status: string;
  working_on: string | null; model: string | null; session_id: string | null;
  started_at: number; last_seen: number;
}
export interface HiveSessionView extends HiveSession {
  active: boolean; seconds_ago: number;
}

/** Register OR heartbeat. Upsert on (pc, lane): first call sets started_at;
 *  later calls bump last_seen and refresh status/working_on/model. */
export function registerHiveSession(s: {
  pc: string; lane: string; status?: string;
  workingOn?: string | null; model?: string | null; sessionId?: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO hive_sessions
       (pc, lane, status, working_on, model, session_id, started_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pc, lane) DO UPDATE SET
       status     = excluded.status,
       working_on = excluded.working_on,
       model      = excluded.model,
       session_id = excluded.session_id,
       last_seen  = excluded.last_seen`,
  ).run(
    s.pc, s.lane, s.status ?? 'online',
    s.workingOn ?? null, s.model ?? null, s.sessionId ?? null, now, now,
  );
}

/** Read-time self-expiry: every row, flagged active iff last_seen within TTL. */
export function getHiveSessions(ttlMinutes: number): HiveSessionView[] {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - ttlMinutes * 60;
  const rows = db
    .prepare('SELECT * FROM hive_sessions ORDER BY last_seen DESC')
    .all() as HiveSession[];
  return rows.map((r) => ({
    ...r, active: r.last_seen >= cutoff, seconds_ago: now - r.last_seen,
  }));
}

export interface HiveNote {
  id: number; from_pc: string; from_lane: string | null; to_lane: string | null;
  body: string; read_flag: number; tags: string; created_at: number;
}

export function addHiveNote(n: {
  fromPc: string; fromLane?: string | null; toLane?: string | null;
  body: string; tags?: string;
}): HiveNote {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    `INSERT INTO hive_notes (from_pc, from_lane, to_lane, body, read_flag, tags, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(n.fromPc, n.fromLane ?? null, n.toLane ?? null, n.body, n.tags ?? '[]', now);
  return db.prepare('SELECT * FROM hive_notes WHERE id = ?')
    .get(info.lastInsertRowid) as HiveNote;
}

/** Notes for a lane (plus broadcasts: to_lane IS NULL), or all when omitted. */
export function getHiveNotes(opts: { lane?: string; limit?: number } = {}): HiveNote[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  if (opts.lane) {
    return db.prepare(
      `SELECT * FROM hive_notes
       WHERE to_lane = ? OR to_lane IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    ).all(opts.lane, limit) as HiveNote[];
  }
  return db.prepare('SELECT * FROM hive_notes ORDER BY created_at DESC LIMIT ?')
    .all(limit) as HiveNote[];
}

/** Test-only: backdate last_seen so TTL-expiry can be asserted in vitest.
 *  Mirrors the existing _testBackdateMeetingEnd helper (db.ts:807). */
export function _testBackdateHiveSession(pc: string, lane: string, lastSeen: number): void {
  db.prepare('UPDATE hive_sessions SET last_seen = ? WHERE pc = ? AND lane = ?')
    .run(lastSeen, pc, lane);
}
```

### Step 5 — Routes + auth middleware in the dashboard
File: `src/dashboard.ts`

(a) Imports: add `HIVE_TOKEN, HIVE_TTL_MINUTES` to the existing `from './config.js'` import (around `:9`), and add `registerHiveSession, getHiveSessions, addHiveNote, getHiveNotes, HiveSessionView, HiveNote` to the existing `from './db.js'` import block (`:11-81`).

(b) Exempt `/api/hive/*` from the dashboard-token gate. The existing global `/api/` gate (`dashboard.ts:343-355`) checks `DASHBOARD_TOKEN` from `c.req.query('token')`. To let the hive group authenticate with its OWN secret, add ONE line at the top of that middleware (additive, the rest of the block is untouched). The trailing slash means this does NOT match `/api/hive-mind`:
```ts
    if (path.startsWith('/api/hive/')) { await next(); return; }
```

(c) Add the hive auth middleware immediately after the `requireToken` helper (around `dashboard.ts:366`), before the route handlers. It accepts the secret in the query param (the only auth path the server actually reads today; the browser dashboard can only send `?token=`) and, for GET only, also accepts `DASHBOARD_TOKEN` so the dashboard panel works without distributing `HIVE_TOKEN` to the browser. The GET-only guard on `DASHBOARD_TOKEN` is load-bearing: it prevents a write-auth bypass.
```ts
  // Phase 2 hive auth. HIVE_ENABLED is a hot kill switch. Writes require
  // HIVE_TOKEN; GETs additionally accept the dashboard token so the SPA
  // panel works (browser can only send ?token=). Constant-time compare.
  app.use('/api/hive/*', async (c, next) => {
    if (!killSwitches.isEnabled('HIVE_ENABLED')) {
      return c.json({ error: 'hive disabled' }, 503);
    }
    if (!HIVE_TOKEN) {
      return c.json({ error: 'hive not configured' }, 503);
    }
    const provided = c.req.query('token');
    const isGet = c.req.method === 'GET';
    const ok =
      safeTokenEqual(provided, HIVE_TOKEN) ||
      (isGet && safeTokenEqual(provided, DASHBOARD_TOKEN));
    if (!ok) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
```

Note on the `Authorization: Bearer` header: the codebase does NOT read it anywhere (verified — zero matches for `authorization`/`bearer` in the auth path). Do NOT design clients around a Bearer header; it is dead weight against current code. If header auth is wanted later for log hygiene, it is a separate additive change to read `c.req.header('authorization')` in this middleware. For now, the query param is the only working auth path, on a private Tailscale overlay, which is acceptable.

(d) Register the four route handlers. Insertion point: immediately AFTER the existing `/api/hive-mind` block (ends at `dashboard.ts:4006`) and BEFORE the `// ── Chat endpoints ──` comment (`:4008`). This is well above the SPA catch-all `app.get('*')` at `:4236`; anything below that 404s. Validate with zod (it IS a dependency, `package.json:46`, already used in `src/team-tools.ts`) to match the codebase convention.
```ts
  // ── Phase 2 hive: live cross-PC link ──────────────────────────────────
  const HiveRegisterBody = z.object({
    pc:        z.string().min(1).max(64),
    lane:      z.string().min(1).max(64),
    status:    z.enum(['online', 'busy', 'idle', 'offline']).optional(),
    workingOn: z.string().max(2000).optional(),
    model:     z.string().max(128).optional(),
    sessionId: z.string().max(128).optional(),
  });
  app.post('/api/hive/register', async (c) => {
    const parsed = HiveRegisterBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    const b = parsed.data;
    registerHiveSession({
      pc: b.pc, lane: b.lane, status: b.status,
      workingOn: b.workingOn ?? null, model: b.model ?? null, sessionId: b.sessionId ?? null,
    });
    const session = getHiveSessions(HIVE_TTL_MINUTES).find(s => s.pc === b.pc && s.lane === b.lane);
    return c.json({ ok: true, session });
  });

  app.get('/api/hive/status', (c) => {
    const ttl = Math.min(Math.max(parseInt(c.req.query('ttl') || '', 10) || HIVE_TTL_MINUTES, 1), 1440);
    const lane = c.req.query('lane')?.trim();
    let sessions = getHiveSessions(ttl);
    if (lane) sessions = sessions.filter(s => s.lane === lane);
    return c.json({
      ttlMinutes: ttl,
      now: Math.floor(Date.now() / 1000),
      activeCount: sessions.filter(s => s.active).length,
      sessions,
    });
  });

  const HiveNoteBody = z.object({
    fromPc:   z.string().min(1).max(64),
    fromLane: z.string().max(64).optional(),
    toLane:   z.string().max(64).optional(),
    body:     z.string().min(1).max(8000),
    tags:     z.array(z.string().max(40)).max(20).optional(),
  });
  app.post('/api/hive/notes', async (c) => {
    const parsed = HiveNoteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    const b = parsed.data;
    const note = addHiveNote({
      fromPc: b.fromPc, fromLane: b.fromLane ?? null, toLane: b.toLane ?? null,
      body: b.body, tags: b.tags ? JSON.stringify(b.tags) : '[]',
    });
    return c.json({ ok: true, note });
  });

  app.get('/api/hive/notes', (c) => {
    const lane = c.req.query('lane')?.trim();
    const limit = parseInt(c.req.query('limit') || '50', 10);
    return c.json({ notes: getHiveNotes({ lane: lane || undefined, limit }) });
  });
```

Heartbeat = re-POST `/api/hive/register`. There is no separate verb. The upsert bumps `last_seen`.

Two global gates still apply to the POSTs for free, and you must account for both:
- CSRF Origin allowlist (`dashboard.ts` CSRF block): CLI clients send no `Origin`, which is allowed (treated as same-origin). Browser-over-Tailscale POSTs would be 403'd — but the spokes are CLI-only, so this does not bite. See section 5 for the browser caveat.
- `DASHBOARD_MUTATIONS_ENABLED` kill switch returns 503 on all non-GET when off (`dashboard.ts:377-393`), and `mutationReadonlyExempt` (`dashboard.ts:374`) is currently empty. See Open Decision D2 — the register/heartbeat POST is the one place this interacts badly with self-expiry.

### Step 6 — Tests (required to pass the gate)
Files: `src/test-env-setup.ts` and a test file (extend `src/db.test.ts` for the DAL and `src/dashboard.contract.test.ts` for the routes).

(a) `src/test-env-setup.ts` does NOT set `HIVE_TOKEN` today. Under the new middleware, every `/api/hive/*` request would 503 ("hive not configured") and the route tests could not assert 401/200. Add, alongside the existing lines:
```ts
process.env.HIVE_TOKEN = process.env.HIVE_TOKEN || 'test-hive-token';
process.env.HIVE_ENABLED = process.env.HIVE_ENABLED || 'true';
```
These must be set in this setup file because `config.ts` reads them at import time, exactly like `DASHBOARD_TOKEN`.

(b) DAL round-trip test in `src/db.test.ts` (it already calls `_initTestDatabase()` in `beforeEach`): register -> heartbeat (assert `last_seen` bumped, `started_at` preserved) -> `getHiveSessions` shows `active:true` -> `_testBackdateHiveSession` past TTL -> `getHiveSessions` shows `active:false` -> `addHiveNote` / `getHiveNotes` lane filter includes broadcasts.

(c) Contract tests in `src/dashboard.contract.test.ts` via `buildDashboardApp().request(...)` (no port bind): 401 with wrong token; 200 with `?token=test-hive-token`; GET `/api/hive/status` accepts the dashboard token; POST `/api/hive/notes` rejects an empty body with 400; `/api/hive/` does not collide with `/api/hive-mind`.

The tables exist in the test DB because they are in `createSchema()` (step 3).

### Step 7 — `.env` and `.env.example`
File: `.env.example` (add a section mirroring the `DASHBOARD_TOKEN` block at `.env.example:91-96`), and the real `.env` on the Main PC.
```
# ── Phase 2 hive (cross-PC link over Tailscale) ──
# Generate: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
HIVE_TOKEN=
HIVE_TTL_MINUTES=5
HIVE_ENABLED=true
# Spokes also set these (NOT needed on the hub):
#   HIVE_HUB_URL=https://claudeclaw-main.<tailnet>.ts.net
#   HIVE_HOST=desktop2        # or laptop
#   HIVE_HEARTBEAT_SECONDS=60
```
Never bake `HIVE_TOKEN` into git-tracked `docs/`. It would leak to every PC that clones the repo.

### Step 8 — Tailscale on the Main PC (inside WSL)
This is config, not code. Run inside WSL:
```bash
curl -fsSL https://tailscale.com/install.sh | sh

# Bring up tailscaled. Prefer systemd if WSL has it (matches how the main
# service already runs); fall back to userspace networking if /dev/net/tun
# is unavailable (this is INDEPENDENT of systemd — a box can have systemd
# yet still lack a usable TUN device):
if [ -e /dev/net/tun ] && systemctl list-unit-files | grep -q tailscaled; then
  sudo systemctl enable --now tailscaled
else
  sudo tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale &
fi

sudo tailscale up --hostname=claudeclaw-main

# VERIFY before declaring success:
tailscale ip -4        # must return a 100.x address
tailscale status       # node must show online

# Reverse-proxy the loopback service onto the tailnet (keep DASHBOARD_BIND
# at its loopback default — do NOT set it to a non-loopback address):
sudo tailscale serve --bg --https=443 http://127.0.0.1:3141
tailscale serve status

# Do NOT run `tailscale funnel` — that exposes to the public internet.
```
Lock the tailnet in the Tailscale admin console (account-level, not in this repo): tag the hub `tag:claudeclaw-hub`, tag the spokes `tag:claudeclaw-peer`, and write an ACL that permits `tag:claudeclaw-peer` to reach ONLY `tag:claudeclaw-hub:443`. The network-level privacy guarantee is Tailscale ACLs + Funnel-off + the shared secret; the HTTP layer itself only checks the token.

### Step 9 — Spoke client + boot hook (new files, additive)
New files under `scripts/hive/`:
- `hive-client.sh` (bash; laptop / WSL) and `hive-client.ps1` (PowerShell; Desktop 2, no curl dependency).
- `hive-boot.sh` / `hive-boot.ps1` (boot hook).
- `docs/HIVE-CLIENT.md` (per-PC setup notes + the CLAUDE.md snippet to paste).

Client contract (subcommands map to endpoints; `register` and `heartbeat` both hit `/api/hive/register`):
```bash
# scripts/hive/hive-client.sh register   (modeled on scripts/notify.sh)
# Reads HIVE_HUB_URL, HIVE_TOKEN, HIVE_HOST via notify.sh's read_env() helper.
# Auth is ?token= ONLY (the server does not read the Authorization header).
RESP=$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "${HIVE_HUB_URL}/api/hive/register?token=${HIVE_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg pc "$HIVE_HOST" --arg lane "$HIVE_LANE" \
        '{pc:$pc, lane:$lane, status:"online"}')")

if [ "$RESP" != "200" ]; then
  # GRACEFUL DEGRADATION -> Layer-1 git docs (see section 6 for the format).
  update_session_registry_row    # pull --ff-only, UPDATE this PC's table row, push
  echo "hive: hub unreachable, using git-doc coordination" >&2
fi
```
Rules the spoke client MUST follow:
- HTTP-only. Do NOT `import db.js` or call `initDatabase()` — it would throw on the missing DB / `DB_ENCRYPTION_KEY` off-box.
- `-m 5` timeout so a dead hub degrades fast.
- Any standalone heartbeat loop must wrap each tick so a transient Tailscale blip cannot become a process-killing `unhandledRejection` (the `oauth-health.ts:165-166` precedent). In bash that is `hive-client.sh heartbeat || true` inside the loop.
- Do NOT reuse `scripts/run-tunnel.sh`. It is a macOS-Homebrew-pathed cloudflared (public ingress) launcher (`run-tunnel.sh:4`), wrong for Tailscale-private Phase 2 and will not run in WSL/Linux. Leave it untouched.

Boot hook (`hive-boot.sh`): (1) `git pull --ff-only` the docs, (2) `GET /api/hive/status` and print the live registry (or the Layer-1 table on failure), (3) print recent notes, (4) register this session. Use the HTTP GET for liveness — do NOT reuse `scripts/status.ts`, which checks stale unit names (`com.claudeclaw.app` / `claudeclaw`, `status.ts:143/172/185`) and opens the DB read-only, neither of which works off-box.

CLAUDE.md snippet for each spoke (instruction-driven, matching the repo's existing convention of CLAUDE.md telling the session to run a command — there is no committed SessionStart settings hook to model on):
```markdown
## Hive (Phase 2) — RUN AT SESSION START
You are on an OFF-PC node. Before anything else:
    REPO=$(git rev-parse --show-toplevel)
    bash "$REPO/scripts/hive/hive-boot.sh"     # Desktop 2: pwsh hive-boot.ps1
This pulls docs/, prints the live registry + notes, and registers this session.
If the hub is unreachable it falls back to docs/SESSION-REGISTRY.md automatically;
a "hub offline" message is NOT an error. Heartbeat every few minutes on long tasks:
    bash "$REPO/scripts/hive/hive-client.sh" heartbeat
Before editing a shared file (dashboard.ts, db.ts, index.ts, App.tsx, routes.ts),
check `hive-client.sh status` to avoid colliding with another PC's lane.
```

### Step 10 (optional) — Dashboard sessions panel
File: `web/src/pages/HiveMind.tsx` (additive, lowest-risk path). Add a `'sessions'` view mode to the existing `/hive` page rather than a new route: extend the `ViewMode` union (`HiveMind.tsx:39`), accept it in `loadView()` (`:44`), add a `<ViewBtn>` to the switcher (`:192-201`), and render `{effectiveView === 'sessions' && <HiveSessionsPanel/>}`. Fetch with `useFetch<{sessions: HiveSessionView[]}>('/api/hive/status', 10_000)` (10s poll, tighter than the TTL). The browser sends `?token=<DASHBOARD_TOKEN>` via `withToken()`, which the GET-accepts-dashboard-token branch in step 5c handles. Label it "Live Sessions," NOT "Hive Mind," to avoid conflation with the local `/api/hive-mind` feed. Use `formatRelativeTime(last_seen)` (unix seconds, `format.ts:4-5`). No vite proxy change is needed: the dev proxy is a `/api` prefix match (`vite.config.ts:31`), which already covers `/api/hive/*`.

---

## 5. Auth + Security Model

- One shared secret, `HIVE_TOKEN`, distinct from `DASHBOARD_TOKEN`. Generated with `crypto.randomBytes(24)`. Read via `readEnvFile`/config (step 1) so it is present under systemd.
- Auth path is the QUERY param (`?token=`) compared in constant time with `safeTokenEqual` (`dashboard.ts:210-214`, the audit-fixed comparator). This is the ONLY auth path the server reads. The `Authorization: Bearer` header is NOT read anywhere in the codebase, so clients must not rely on it.
- `/api/hive/*` is additively exempted from the `DASHBOARD_TOKEN` gate (step 5b), so `HIVE_TOKEN` is the sole write authority. For GET endpoints only, the middleware also accepts `DASHBOARD_TOKEN`, so the browser dashboard panel works without ever holding `HIVE_TOKEN`. The GET-only guard prevents a write-auth bypass.
- Token-in-URL leaks into request logs (`dashboard.ts:298`). The repo already sets `Referrer-Policy: no-referrer` (`dashboard.ts:279`) to blunt this. On a private, ACL-locked Tailscale overlay this residual risk is acceptable. If it ever needs tightening, add header-reading to the hive middleware (a self-contained additive change).
- Network privacy = Tailscale ACLs (peers reach only the hub on 443) + Funnel-off + the shared secret. The HTTP listener stays on loopback; `tailscale serve` is the only thing that can reach it.
- `HIVE_TOKEN` is added to `PROTECTED_ENV_VARS` so the exfiltration guard redacts it, and it is auto-scrubbed from `claude` SDK subprocess env by the `/_TOKEN$/` rule in `security.ts`.
- `HIVE_ENABLED` kill switch (re-read every 1.5s) hot-disables the whole surface without a restart.
- Browser-over-Tailscale caveat (only relevant if you ever load the dashboard itself in a browser over the tailnet, which is NOT required by this plan): a browser POST would carry an `Origin` header that is not in the CSRF allowlist (`dashboard.ts` CSRF block) nor the CORS allowlist, and `Access-Control-Allow-Headers` is hardcoded to `Content-Type`. To enable browser use you would additively (a) set `DASHBOARD_URL` to the MagicDNS host (feeds the allowlist via `config.ts:18`), and (b) add the host to the CORS allowlist. The CLI spokes this plan uses send no `Origin`, so none of this is needed for the core build.

---

## 6. Heartbeat / TTL Self-Expiry + Graceful Fallback

### Self-expiry (server-side, the source of truth)
Expiry is computed at READ time, never by deletion. `getHiveSessions(ttlMinutes)` returns every row but flags `active` only when `last_seen >= now - ttl`. Default TTL is `HIVE_TTL_MINUTES=5`. Rows persist, so a session that was offline reappears as active the moment its heartbeat resumes. `GET /api/hive/status` is the authority; clients display the server's `active` flag, they do not compute liveness themselves.

### Heartbeat (client-side)
Each spoke re-POSTs `/api/hive/register` on an interval (`HIVE_HEARTBEAT_SECONDS`, default 60). TTL should be 2 to 3x the heartbeat interval, which the 5-minute default against 60s heartbeats satisfies. Every tick is wrapped so a failure never crashes the loop.

### Graceful fallback to Layer-1 git docs
When a hub call returns non-200 or times out (`-m 5`), the spoke falls back to `docs/SESSION-REGISTRY.md`. This file is a STRUCTURED TABLE with a one-row-per-session contract ("add or UPDATE your row," verified in the file header). The fallback MUST honor that format:
1. `git pull --ff-only` (retry once on a non-ff state rather than silently swallowing).
2. Find this PC's row in the table and UPDATE it in place (status, working_on, last update). Do NOT append free-form bullet lines into the table body — that corrupts the contract.
3. `git add` + `git commit` + `git push`. If the push fails on a non-ff race, pull-rebase and retry once, and SURFACE a failure to stderr rather than hiding it behind `|| true`.

The git-doc path is best-effort and lossy under heavy concurrency; it is a fallback, not a consistency guarantee. The hub is the source of truth whenever it is up. This satisfies hard rule 5: a hub-down session keeps coordinating via git and never blocks.

### The one interaction to get right (D2)
`register`/`heartbeat` are POSTs, so they are gated by `DASHBOARD_MUTATIONS_ENABLED` (503 when off; `mutationReadonlyExempt` is empty). If an operator flips the service read-only during an incident, every spoke heartbeat 503s and the live registry empties within one TTL. The query-time-expiry design softens this (rows reappear when heartbeats resume), but you should still pick one mitigation in step 5: either make heartbeat a GET-shaped call, or add the three hive POST paths to `mutationReadonlyExempt`. Recommended default: leave them gated (default-safe) and accept that during a mutations-off window the registry shows everyone as stale, which is the honest signal. Decide explicitly (D2 below).

---

## 7. Optional Cross-PC Memory (DEFERRED — later, not in the core build)

This is explicitly OPTIONAL and should NOT be built in the first pass. Notes for when it is picked up:

- Centralize in the hub service. Do NOT sync the SQLite file across PCs. SQLite + WAL is unsafe over a networked filesystem and will corrupt under concurrent writers, and it would clobber the finance/content/psyop lanes living in the same `claudeclaw.db`.
- Embeddings are bge-m3-specific (1024-dim) and only the Main PC has Ollama. The laptop has no CUDA and Desktop 2 has no Ollama, so clients cannot produce compatible vectors. A memory-write endpoint must accept TEXT only and embed hub-side via `embedText` (`embeddings.ts:51`).
- Route writes through the existing ingest path so the importance threshold and the 0.85 duplicate suppression (`memory-ingest.ts:206-233`) still apply; otherwise the shared memory fills with spam and dupes.
- Use a reserved hive `chat_id` and pass `strictAgentId`/`agentId` so cross-PC memory does not bleed into the user's private memory lane (`buildMemoryContext` returns any agent's memories for a given chat_id when no strict scope is set).
- Optional attribution: add `origin_pc TEXT` to `memories` via `addColumnIfMissing` (`db.ts:485-499`) inside `runMigrations` — purely additive, default NULL = legacy/local. All existing SELECTs ignore the unknown column.
- Gate it behind a kill switch (mirror `requireEnabled` in `memory-consolidate.ts`) so the off-PC link cannot accidentally write into private memory, and degrade to Layer-1 if the hub is down.

---

## 8. Verification + Test Plan

### Gate (must all pass, in this order, before `npm run build`)
```
npx tsc --noEmit
npx tsc -p web/tsconfig.json
npx vitest run
npm run build
```
The vitest run exercises the new DAL round-trip and the `/api/hive/*` contract tests (step 6). Those tests only pass once `HIVE_TOKEN` and `HIVE_ENABLED` are set in `src/test-env-setup.ts` — without that, the middleware 503s and the gate fails. A build compiles every lane, so a green build confirms no other lane broke.

### Local hub smoke test (Main PC, after build + restart)
```bash
T=$(grep -E '^HIVE_TOKEN=' .env | cut -d= -f2)
curl -s "http://127.0.0.1:3141/api/hive/register?token=$T" \
  -H 'Content-Type: application/json' \
  -d '{"pc":"main","lane":"system","status":"online","workingOn":"smoke test"}'
curl -s "http://127.0.0.1:3141/api/hive/status?token=$T"     # main shows active:true
curl -s "http://127.0.0.1:3141/api/hive/notes?token=$T&limit=5"
```

### End-to-end check from Desktop 2 over Tailscale
1. On Desktop 2, set `.env`: `HIVE_HUB_URL=https://claudeclaw-main.<tailnet>.ts.net`, `HIVE_TOKEN=<same secret>`, `HIVE_HOST=desktop2`.
2. `bash scripts/hive/hive-boot.sh` — confirm it prints the live registry (main should appear) and registers desktop2.
3. On the Main PC dashboard (or via curl), `GET /api/hive/status` now shows BOTH `main` and `desktop2` with `active:true`.
4. Wait past the TTL (5 min) without heartbeating from Desktop 2; confirm desktop2 flips to `active:false`.
5. Post a note from Desktop 2 (`hive-client.sh note "..."`); confirm it appears in `GET /api/hive/notes` from the Main PC.
6. Fallback test: stop `tailscale serve` (or block the hub), run `hive-client.sh register` on Desktop 2, confirm it falls back to UPDATING the desktop2 row in `docs/SESSION-REGISTRY.md` and pushes, and that no error crashes the session.

### Restart procedure on the Main PC (gated)
After a green gate + build, restart the service. Confirm the real unit name first (D3):
```bash
systemctl --user status com.claudeclaw.main.service   # confirm name
npx tsc --noEmit && npx tsc -p web/tsconfig.json && npx vitest run && npm run build
systemctl --user restart com.claudeclaw.main.service
```

---

## 9. Open Decisions That Need Gabe's Input

- D1 — Registry cardinality. The schema uses `PRIMARY KEY (pc, lane)`: one live session per PC per lane, heartbeat upserts in place. This matches the task's column list (no session_id in the key). If a single PC must run MULTIPLE concurrent sessions in the SAME lane, switch to `id INTEGER PRIMARY KEY AUTOINCREMENT` + `UNIQUE(pc, lane, session_id)` and make the DAL insert-not-upsert. This is the one load-bearing schema-shape choice; decide before step 3.
- D2 — Heartbeat vs the mutation kill switch. POST heartbeats 503 when `DASHBOARD_MUTATIONS_ENABLED` is off, which mass-stales the registry during a read-only incident. Options: (a) leave gated and accept everyone shows stale (recommended, default-safe); (b) add the hive POST paths to `mutationReadonlyExempt`; (c) make heartbeat a GET. Pick one.
- D3 — Real systemd unit name. The system facts say `com.claudeclaw.main.service`, but the only in-repo reference (`status.ts:172`) uses `claudeclaw`. Confirm the actual unit name on the box before any restart/boot-hook step references it.
- D4 — WSL2 + Tailscale reachability. This plan runs `tailscaled` INSIDE WSL specifically to avoid the Windows-to-WSL NAT crossing. Confirm the WSL distro can run `tailscaled` (systemd present AND `/dev/net/tun` available, or fall back to `--tun=userspace-networking`). This is the single most likely thing to break first; verify `tailscale ip -4` returns a 100.x address before depending on the hub being reachable. Do NOT "fix" a bind failure by setting `DASHBOARD_BIND=0.0.0.0` — that is the public-surface mistake the design forbids.
- D5 — Canonical lane vocabulary. `lane` is free-text `TEXT` (no CHECK constraint). Confirm the intended lane identifiers (e.g. `finance`, `content`, `psyop`, `system`) so the spokes register consistent values; the registry is only as useful as the agreement on these strings.
- D6 — Cross-PC memory: in or out for now. Section 7 is deferred by default. Confirm it stays out of the first pass.

---

## 10. Where Implementation Should Run

All code work happens on the MAIN PC, inside WSL, in `/home/gcruise/repos/claudeclaw-os`. Reasons:
- Desktop 2 has no Node yet and the laptop is portable; neither can run the gate (`tsc` x2 + `vitest`) or `npm run build`.
- The service that must be restarted to pick up the new routes runs only on the Main PC. The gate-before-build rule means the restart must follow a green gate + build on that same machine.
- The DB, Ollama, and the `.env` holding the real secrets all live on the Main PC.

Sequence on the Main PC: branch the repo, do steps 1 to 7 (code + tests + .env), run the full gate, `npm run build`, restart the service, then steps 8 (Tailscale) and 9 (spokes). The spokes are configured on their own machines but talk only over HTTP to the hub built here. Push the `docs/` and `scripts/` additions so Desktop 2 and the laptop can `git pull` them.
```
