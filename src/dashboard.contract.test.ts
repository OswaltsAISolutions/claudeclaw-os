// Contract test suite for the Mission Control HTTP API.
//
// Why this exists: a frontend rewrite is in progress (web/ Vite project,
// rolling out PR-by-PR). The new frontend is built against the documented
// shape of every endpoint. If the backend ever drifts from that shape —
// renames a field, changes nullability, swaps a type — the rewrite breaks
// silently. These tests pin the response shape of every endpoint family
// the new frontend depends on, so any drift fails CI before it ships.
//
// Tests use Hono's `app.request()` so no real port is opened. The DB is
// the in-memory test DB initialized via `_initTestDatabase()`.
//
// Env vars are set by `src/test-env-setup.ts` (vitest setupFiles) so they
// land BEFORE config.ts evaluates at import time.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import { setProcessing } from './state.js';
import { ALL_CALLSIGNS } from './specialists.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
});

async function get(path: string) {
  return app.request(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN);
}

async function getNoToken(path: string) {
  return app.request(path);
}

// Tests fetch JSON we only describe shape-wise — typing as `any` keeps the
// assertions readable without forcing the real interfaces into the test file.
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

describe('auth gate', () => {
  it('rejects unauthorized GET without token', async () => {
    const res = await getNoToken('/api/health');
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toMatchObject({ error: 'Unauthorized' });
  });

  it('rejects unauthorized GET with wrong token', async () => {
    const res = await app.request('/api/health?token=wrong');
    expect(res.status).toBe(401);
  });

  it('accepts GET with correct token', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
  });

  it('responds 204 to OPTIONS preflight without token check', async () => {
    const res = await app.request('/api/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  // Regression: the SPA shell (`<script src="/assets/...">`) has no
  // token in the URL. If the auth middleware ever gates /assets/* the
  // bundle 401s and the dashboard goes blank — the symptom Mark hit
  // when the dashboard "wouldn't load" after a previous refactor.
  // Static assets must always be reachable without a token.
  it('serves /assets/* without a token (SPA bundle would 401 otherwise)', async () => {
    // Hit a path we know won't exist on disk, just to prove the auth
    // middleware ALLOWS the request through. Whether the file exists is
    // a separate concern handled by the /assets/* handler.
    const res = await app.request('/assets/some-bundle-that-doesnt-exist.js');
    // Acceptable outcomes: 200/204 (file served), 404 (handler ran and
    // didn't find it). NOT acceptable: 401 (middleware blocked it).
    expect(res.status).not.toBe(401);
  });

  it('serves /favicon.svg without a token', async () => {
    const res = await app.request('/favicon.svg');
    expect(res.status).not.toBe(401);
  });

  // Regression: SPA shell paths must be reachable without a token so a
  // hard-refresh of a token-stripped URL still loads the frontend, which
  // can recover the token from sessionStorage. If these 401, the user
  // sees raw JSON {"error":"Unauthorized"} on every refresh — exactly
  // the bug Mark hit. The HTML these serve has no embedded secret; the
  // frontend reads token from query string then falls back to storage.
  // Every client-side wouter route must be in this list.
  for (const path of [
    '/', '/warroom', '/mission', '/scheduled', '/agents',
    '/agents/comms/files', '/chat', '/memories', '/hive', '/usage',
    '/audit', '/settings',
  ]) {
    it(`serves SPA shell at ${path} without a token`, async () => {
      const res = await app.request(path);
      expect(res.status).not.toBe(401);
    });
  }

  // Legacy mode HTML embeds DASHBOARD_TOKEN, so those variants MUST stay
  // gated even though the path is exempt at the middleware. The handler
  // does an inline check.
  it('blocks legacy /warroom?mode=picker without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom?mode=picker');
    expect(res.status).toBe(401);
  });

  it('blocks legacy /warroom?mode=voice without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom?mode=voice');
    expect(res.status).toBe(401);
  });

  it('blocks legacy /warroom/text without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom/text?meetingId=wr_test');
    expect(res.status).toBe(401);
  });

  // Regression: the CSRF middleware reads its allowed-origin host from
  // the DASHBOARD_URL env var. If it reads from process.env directly
  // (instead of the config helper that also consults the .env file),
  // the production daemon — which doesn't have process.env populated
  // from .env — 403s every cross-origin POST from the Cloudflare tunnel.
  // src/test-env-setup.ts sets DASHBOARD_URL=https://dash.test.example
  // so this test exercises the right code path.
  it('allows POSTs with Origin matching DASHBOARD_URL', async () => {
    const res = await app.request('/api/mission/tasks?token=' + TOKEN, {
      method: 'POST',
      headers: { 'origin': 'https://dash.test.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'csrf test', prompt: 'csrf test' }),
    });
    // 200 (created) or 400 (validation) — anything but 403 means the
    // CSRF middleware let it through, which is what we're testing.
    expect(res.status).not.toBe(403);
  });

  it('blocks POSTs from disallowed origin', async () => {
    const res = await app.request('/api/mission/tasks?token=' + TOKEN, {
      method: 'POST',
      headers: { 'origin': 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'csrf test', prompt: 'csrf test' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/health', () => {
  it('returns the documented shape', async () => {
    const res = await get('/api/health');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      contextPct: expect.any(Number),
      turns: expect.any(Number),
      compactions: expect.any(Number),
      sessionAge: expect.any(String),
      model: expect.any(String),
      telegramConnected: expect.any(Boolean),
      waConnected: expect.any(Boolean),
      slackConnected: expect.any(Boolean),
      killSwitches: expect.any(Object),
      killSwitchRefusals: expect.any(Object),
      warroom: expect.objectContaining({
        textOpenMeetings: expect.any(Number),
      }),
    });
  });

  it('killSwitches contains all 6 documented flags', async () => {
    const res = await get('/api/health');
    const body = await jsonOf(res);
    expect(body.killSwitches).toMatchObject({
      WARROOM_TEXT_ENABLED: expect.any(Boolean),
      WARROOM_VOICE_ENABLED: expect.any(Boolean),
      LLM_SPAWN_ENABLED: expect.any(Boolean),
      DASHBOARD_MUTATIONS_ENABLED: expect.any(Boolean),
      MISSION_AUTO_ASSIGN_ENABLED: expect.any(Boolean),
      SCHEDULER_ENABLED: expect.any(Boolean),
    });
  });
});

describe('GET /api/info', () => {
  it('returns botName, botUsername, pid, chatId', async () => {
    const res = await get('/api/info');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      botName: expect.any(String),
      botUsername: expect.any(String),
      pid: expect.any(Number),
    });
    expect('chatId' in body).toBe(true);
  });
});

describe('GET /api/agents', () => {
  it('returns { agents: [] } even when no agents configured', async () => {
    const res = await get('/api/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ agents: expect.any(Array) });
  });

  it('always includes main as first entry when present', async () => {
    const res = await get('/api/agents');
    const body = await jsonOf(res);
    if (body.agents.length > 0) {
      expect(body.agents[0]).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        running: expect.any(Boolean),
      });
    }
  });
});

describe('GET /api/tasks (scheduled)', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });
});

describe('GET /api/mission/tasks', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/mission/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });

  it('accepts ?agent and ?status filters', async () => {
    const res = await get('/api/mission/tasks?agent=main&status=queued');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.tasks).toBeInstanceOf(Array);
  });
});

describe('GET /api/mission/history', () => {
  it('returns paginated { tasks, total }', async () => {
    const res = await get('/api/mission/history?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      tasks: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('POST /api/mission/tasks', () => {
  it('rejects missing title with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing prompt with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates task with valid input and returns full task shape', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'contract test', prompt: 'do nothing', priority: 3 }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.task).toMatchObject({
      id: expect.any(String),
      title: 'contract test',
      prompt: 'do nothing',
      status: 'queued',
      priority: 3,
      created_by: 'dashboard',
      created_at: expect.any(Number),
    });
  });
});

describe('GET /api/mission/tasks/auto-assign-all route ordering', () => {
  // Regression test: this endpoint was shadowed by /:id/auto-assign for
  // months because route registration order was wrong. Lock it in.
  it('returns 200, not 404, when called as a static path', async () => {
    const res = await app.request('/api/mission/tasks/auto-assign-all' + Q, {
      method: 'POST',
    });
    // Must NOT be 404. May be 200 (assigned: 0) or 400 if no agents.
    expect(res.status).not.toBe(404);
  });
});

describe('GET /api/memories', () => {
  it('returns full memory dashboard payload', async () => {
    const res = await get('/api/memories?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.objectContaining({
        total: expect.any(Number),
        pinned: expect.any(Number),
        consolidations: expect.any(Number),
      }),
      fading: expect.any(Array),
      topAccessed: expect.any(Array),
      timeline: expect.any(Array),
      consolidations: expect.any(Array),
    });
  });
});

describe('GET /api/memories/list', () => {
  it('returns paginated memory list', async () => {
    const res = await get('/api/memories/list?chatId=test&limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      memories: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/tokens', () => {
  it('returns stats + costTimeline + recentUsage', async () => {
    const res = await get('/api/tokens?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.any(Object),
      costTimeline: expect.any(Array),
      recentUsage: expect.any(Array),
    });
    expect(body.stats).toMatchObject({
      todayInput: expect.any(Number),
      todayOutput: expect.any(Number),
      todayCost: expect.any(Number),
      todayTurns: expect.any(Number),
      allTimeCost: expect.any(Number),
      allTimeTurns: expect.any(Number),
    });
  });
});

describe('GET /api/hive-mind', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/hive-mind');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/audit', () => {
  it('returns { entries, total }', async () => {
    const res = await get('/api/audit?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      entries: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/audit/blocked', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/audit/blocked?limit=5');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/security/status', () => {
  it('returns 200 with an object', async () => {
    const res = await get('/api/security/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toBeInstanceOf(Object);
  });
});

describe('GET /api/chat/history', () => {
  it('defaults to the configured chat when chatId is missing (200, not 400)', async () => {
    const res = await get('/api/chat/history');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });

  it('returns { turns: [] } with chatId', async () => {
    const res = await get('/api/chat/history?chatId=test&limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });
});

describe('PATCH /api/agents/:id/model', () => {
  it('rejects missing model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    });
    expect(res.status).toBe(400);
  });

  it('main response includes restartRequired: false', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      agent: 'main',
      model: 'claude-sonnet-4-6',
      restartRequired: false,
    });
  });
});

describe('avatar endpoints share error shape and status semantics', () => {
  // Twelve-byte canonical PNG header — the avatar PUT handler magic-byte
  // sniffs the first four bytes, so this is enough.
  const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);

  it('GET, PUT, DELETE all return JSON {error} on an invalid id', async () => {
    const get = await app.request('/api/agents/has%20space/avatar' + Q);
    expect(get.status).toBe(400);
    const getBody = await jsonOf(get);
    expect(getBody).toMatchObject({ error: expect.any(String) });

    const put = await app.request('/api/agents/has%20space/avatar' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: PNG_HEADER,
    });
    expect(put.status).toBe(400);
    expect(await jsonOf(put)).toMatchObject({ error: expect.any(String) });

    const del = await app.request('/api/agents/has%20space/avatar' + Q, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(await jsonOf(del)).toMatchObject({ error: expect.any(String) });
  });

  it('GET on an unknown agent returns 404 (not 204)', async () => {
    const res = await app.request('/api/agents/totally_made_up_agent/avatar' + Q);
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toMatchObject({ error: 'agent not found' });
  });

  it('GET on main with no avatar resolved returns 204', async () => {
    // main always "exists" per agentExists; with no bundled or mutable
    // avatar in the test env, the resolver returns null → 204.
    const res = await app.request('/api/agents/main/avatar' + Q);
    expect([200, 204]).toContain(res.status);
    if (res.status === 204) {
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
    }
  });
});

describe('PATCH /api/dashboard/settings standup_config', () => {
  async function patchStandupConfig(value: string) {
    return app.request('/api/dashboard/settings' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'standup_config', value }),
    });
  }

  it('accepts a well-formed payload', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ id: 'main', enabled: true }, { id: 'comms', enabled: false }],
      maxSpeakers: 5,
    }));
    expect(res.status).toBe(200);
  });

  it('rejects non-JSON value with 400', async () => {
    const res = await patchStandupConfig('not json {');
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/standup_config/);
  });

  it('rejects agents-not-an-array with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({ agents: 'nope', maxSpeakers: 5 }));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/agents must be an array/);
  });

  it('rejects an agent entry without an id with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ enabled: true }],
      maxSpeakers: 5,
    }));
    expect(res.status).toBe(400);
  });

  it('rejects maxSpeakers out of [1, 8] with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ id: 'main', enabled: true }],
      maxSpeakers: 99,
    }));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/maxSpeakers/);
  });
});

describe('GET /api/warroom/agents', () => {
  it('returns { agents: [...] } with main present', async () => {
    const res = await get('/api/warroom/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.agents).toBeInstanceOf(Array);
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    expect(body.agents[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
    });
  });
});

describe('GET /api/warroom/pin', () => {
  it('returns { ok, agent, mode }', async () => {
    const res = await get('/api/warroom/pin');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      mode: expect.any(String),
    });
  });
});

describe('GET /api/meet/sessions', () => {
  it('returns { ok, active, recent }', async () => {
    const res = await get('/api/meet/sessions');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      active: expect.any(Array),
      recent: expect.any(Array),
    });
  });
});

describe('Cache-Control on /api/*', () => {
  it('every API response carries Cache-Control: no-store', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Security headers on /', () => {
  it('Referrer-Policy: no-referrer is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('X-Frame-Options: DENY is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('X-Content-Type-Options: nosniff is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// Phase 1 + Phase 8 (2026-05-21): the /api/agents/main/restart endpoint must
// refuse to restart while an agent task is in flight, unless the caller
// explicitly opts in via ?force=true. The success path (force=true) spawns
// `systemctl --user restart`, so we do NOT cover it here — that branch is
// exercised by the live verify script and would otherwise attempt a real
// restart in CI.
describe('POST /api/agents/main/restart busy guard', () => {
  afterEach(() => {
    // The processing flag is module-level state in state.ts; reset it so
    // unrelated tests don't see a stuck "busy" view of the bot.
    setProcessing('', false);
  });

  it('returns 409 with the documented body when an agent task is in flight', async () => {
    setProcessing('test-chat', true);

    const res = await app.request('/api/agents/main/restart' + Q, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      error: 'busy',
      reason: 'agent_in_flight',
      message: expect.stringContaining('agent task is in progress'),
    });
    expect(body.message).toContain('?force=true');
  });

  it('still returns 409 if ?force is present but not exactly "true"', async () => {
    setProcessing('test-chat', true);

    const res = await app.request('/api/agents/main/restart?force=1&token=' + TOKEN, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});

// ── Additional SPA-depended GET endpoints ────────────────────────────────
// These endpoint families weren't pinned above. Same rationale as the rest of
// this suite: the web rewrite consumes their documented shape, so backend
// drift (a renamed field, changed nullability, a wrong status code) should
// fail here rather than silently break the frontend. All are DB/config-only
// reads (no systemd, Ollama, or network), so they resolve deterministically
// against the in-memory test DB. Endpoints that shell out (/:id/details ->
// systemctl) or resolve models (/api/specialists -> Ollama) are deliberately
// excluded so this suite stays hermetic.

describe('GET /api/mission/tasks/:id', () => {
  it('returns 404 {error} for an unknown id', async () => {
    const res = await get('/api/mission/tasks/deadbeef');
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toMatchObject({ error: expect.any(String) });
  });

  it('returns { task } for a task that exists', async () => {
    const created = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'lookup', prompt: 'do nothing' }),
    });
    const { task } = await jsonOf(created);
    const res = await get('/api/mission/tasks/' + task.id);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.task).toMatchObject({ id: task.id, title: 'lookup', status: 'queued' });
  });
});

describe('GET /api/memories/pinned', () => {
  it('returns { memories: [] }', async () => {
    const res = await get('/api/memories/pinned?chatId=test');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ memories: expect.any(Array) });
  });
});

describe('GET /api/agents/:id/tasks (scheduled)', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/agents/main/tasks');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ tasks: expect.any(Array) });
  });
});

describe('GET /api/agents/:id/tokens', () => {
  it('returns todayCost / todayTurns / allTimeCost as numbers', async () => {
    const res = await get('/api/agents/main/tokens');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      todayCost: expect.any(Number),
      todayTurns: expect.any(Number),
      allTimeCost: expect.any(Number),
    });
  });
});

describe('GET /api/agents/:id/status', () => {
  it('returns { running: boolean }', async () => {
    const res = await get('/api/agents/main/status');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ running: expect.any(Boolean) });
  });
});

describe('GET /api/agents/suggestions', () => {
  it('returns { suggestions: [] }', async () => {
    const res = await get('/api/agents/suggestions');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ suggestions: expect.any(Array) });
  });
});

describe('GET /api/agents/templates', () => {
  it('returns { templates: [...] }', async () => {
    const res = await get('/api/agents/templates');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ templates: expect.any(Array) });
  });
});

describe('GET /api/agents/validate-id', () => {
  it('flags a format-valid, non-existent id as { ok: true } with { displayName, username } suggestions', async () => {
    const res = await get('/api/agents/validate-id?id=contractprobe');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.suggestions).toMatchObject({
      displayName: expect.any(String),
      username: expect.any(String),
    });
  });

  it('flags "main" as reserved { ok: false, error }', async () => {
    const res = await get('/api/agents/validate-id?id=main');
    const body = await jsonOf(res);
    expect(body.ok).toBe(false);
    expect(body.error).toEqual(expect.any(String));
  });
});

describe('GET /api/specialists/stats', () => {
  it('returns { hours, stats: [] } and clamps hours to [1, 168]', async () => {
    const res = await get('/api/specialists/stats?hours=9999');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.hours).toBe(168);
    expect(body.stats).toBeInstanceOf(Array);
  });
});

describe('GET /api/specialists/:callsign/history', () => {
  it('returns 400 {error} for an unknown callsign', async () => {
    const res = await get('/api/specialists/not_a_callsign/history');
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.any(String) });
  });

  it('returns { callsign, turns: [] } for a real callsign', async () => {
    const cs = ALL_CALLSIGNS[0];
    const res = await get('/api/specialists/' + cs + '/history');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ callsign: cs, turns: expect.any(Array) });
  });
});

describe('GET /api/warroom/meetings', () => {
  it('returns { meetings: [] }', async () => {
    const res = await get('/api/warroom/meetings');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ meetings: expect.any(Array) });
  });
});

describe('GET /api/warroom/meeting/:id/transcript', () => {
  it('returns a { transcript } key even for an unknown meeting', async () => {
    const res = await get('/api/warroom/meeting/wr_missing/transcript');
    expect(res.status).toBe(200);
    expect('transcript' in (await jsonOf(res))).toBe(true);
  });
});

describe('GET /api/warroom/text/list', () => {
  it('returns { ok: true, meetings: [] }', async () => {
    const res = await get('/api/warroom/text/list');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, meetings: expect.any(Array) });
  });
});

// ── Mutation input-validation contracts (rejection branches only) ────────
// Every case below drives an input the handler REJECTS, so it returns at the
// validation guard BEFORE the side effect. That is deliberate and load-
// bearing: the kill-switch and agent-create happy paths write the real .env /
// create a real agent+service, which must never happen in a test. Pinning the
// rejection contract is what has value anyway: it locks the guards so a
// refactor can't silently widen what reaches a side effect (e.g. accept an
// unknown kill-switch name, or skip a required agent field). CSRF allows a
// missing Origin header (proven by the auth-gate suite above), so these reach
// the validation logic rather than 403ing.

describe('POST /api/security/kill-switch validation', () => {
  it('rejects a missing key (never reaches the .env write)', async () => {
    const res = await app.request('/api/security/kill-switch' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.any(String) });
  });

  it('rejects an unknown switch name with 400 (never reaches the .env write)', async () => {
    const res = await app.request('/api/security/kill-switch' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'NOT_A_REAL_SWITCH', enabled: true }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.stringContaining('unknown kill switch') });
  });
});

describe('POST /api/specialists/:callsign/tier validation', () => {
  it('rejects an unknown callsign with 400', async () => {
    const res = await app.request('/api/specialists/not_a_callsign/tier' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'cloud' }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: 'unknown callsign' });
  });

  it('rejects an invalid tier value with 400', async () => {
    const res = await app.request('/api/specialists/' + ALL_CALLSIGNS[0] + '/tier' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'banana' }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.stringContaining('invalid tier') });
  });
});

describe('GET /api/specialists/route', () => {
  it('rejects an empty task with 400', async () => {
    const res = await get('/api/specialists/route?task=');
    expect(res.status).toBe(400);
  });

  it('returns { suggestion } for a real task', async () => {
    const res = await get('/api/specialists/route?task=' + encodeURIComponent('refactor the database migration script'));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ suggestion: expect.any(String) });
  });
});

describe('POST /api/agents/create validation', () => {
  it('rejects an empty body with 400 (never reaches createAgent)', async () => {
    const res = await app.request('/api/agents/create' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a body missing botToken with 400 (never reaches createAgent)', async () => {
    const res = await app.request('/api/agents/create' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'probe', name: 'Probe', description: 'a probe' }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.stringContaining('botToken') });
  });
});

describe('PATCH /api/mission/tasks/:id reassign validation', () => {
  it('rejects a missing assigned_agent with 400 (never reaches reassign)', async () => {
    const res = await app.request('/api/mission/tasks/any-id' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.stringContaining('assigned_agent') });
  });

  it('rejects an unknown target agent with 400 (never reaches reassign)', async () => {
    const res = await app.request('/api/mission/tasks/any-id' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigned_agent: 'nonexistent_agent_xyz' }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: 'Unknown agent' });
  });
});
