// X (Twitter) bookmark sync via the OFFICIAL v2 API (OAuth 2.0 PKCE).
//
// This is the sanctioned, zero-ban-risk path: Gabe authorizes once in the
// browser, tokens live encrypted in social_accounts, and a nightly sync
// pulls new bookmarks (newest-first, stops at the first already-seen post)
// into library_items where the Phase 1 worker handles media + transcripts.
//
// Scopes: bookmark.read tweet.read users.read offline.access
// Cost: pay-per-use reads on the new console, cents per night at this volume.

import crypto from 'crypto';

import { X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI } from './config.js';
import {
  createLibraryItem,
  getLibraryItemByUrl,
  getSocialAccount,
  saveSocialAccount,
  setDashboardSetting,
  getDashboardSetting,
} from './db.js';
import { logger } from './logger.js';

const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API = 'https://api.x.com/2';
const SCOPES = 'bookmark.read tweet.read users.read offline.access';

export function xConfigured(): boolean {
  return !!X_CLIENT_ID;
}

// ── PKCE state (in-memory; the flow completes within minutes) ────────
const pendingAuth = new Map<string, { verifier: string; createdAt: number }>();

export function buildAuthUrl(): { url: string; state: string } {
  if (!X_CLIENT_ID) throw new Error('X_CLIENT_ID not configured in .env');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pendingAuth.set(state, { verifier, createdAt: Date.now() });
  // Expire stale attempts after 15 min.
  for (const [k, v] of pendingAuth) {
    if (Date.now() - v.createdAt > 15 * 60_000) pendingAuth.delete(k);
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params.toString()}`, state };
}

function basicAuthHeader(): Record<string, string> {
  // Confidential clients must authenticate the token endpoint with
  // client_id:client_secret; public (PKCE-only) clients send client_id in the body.
  if (X_CLIENT_SECRET) {
    const b64 = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
    return { Authorization: `Basic ${b64}` };
  }
  return {};
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...basicAuthHeader() },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${data.error_description || data.error || 'unknown error'}`);
  return data;
}

export async function completeAuth(code: string, state: string): Promise<{ handle: string | null }> {
  const pending = pendingAuth.get(state);
  if (!pending) throw new Error('unknown or expired state (restart the connect flow)');
  pendingAuth.delete(state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: X_REDIRECT_URI,
    code_verifier: pending.verifier,
  });
  if (!X_CLIENT_SECRET) body.set('client_id', X_CLIENT_ID);
  const tok = await tokenRequest(body);

  // Identify the user so syncs can call /users/:id/bookmarks.
  const meRes = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const me = (await meRes.json().catch(() => ({}))) as { data?: { id: string; username: string } };

  saveSocialAccount({
    platform: 'x',
    userId: me.data?.id ?? null,
    handle: me.data?.username ?? null,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    expiresAt: tok.expires_in ? Math.floor(Date.now() / 1000) + tok.expires_in : null,
    scopes: tok.scope ?? SCOPES,
  });
  logger.info({ scope: 'x-sync', handle: me.data?.username }, 'X account connected');
  return { handle: me.data?.username ?? null };
}

/** Get a valid access token, refreshing if within 5 min of expiry. */
async function freshToken(): Promise<{ token: string; userId: string } | null> {
  const acc = getSocialAccount('x');
  if (!acc) return null;
  let token = acc.access_token;
  const nearExpiry = acc.expires_at && acc.expires_at - Math.floor(Date.now() / 1000) < 300;
  if (nearExpiry && acc.refresh_token) {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acc.refresh_token });
    if (!X_CLIENT_SECRET) body.set('client_id', X_CLIENT_ID);
    try {
      const tok = await tokenRequest(body);
      token = tok.access_token;
      saveSocialAccount({
        platform: 'x',
        userId: acc.user_id,
        handle: acc.handle,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? acc.refresh_token,
        expiresAt: tok.expires_in ? Math.floor(Date.now() / 1000) + tok.expires_in : null,
        scopes: acc.scopes,
      });
    } catch (err) {
      logger.warn({ scope: 'x-sync', err: String(err) }, 'X token refresh failed');
      return null;
    }
  }
  if (!acc.user_id) return null;
  return { token, userId: acc.user_id };
}

export interface SyncResult {
  ok: boolean;
  added: number;
  scanned: number;
  error?: string;
}

/**
 * Pull bookmarks newest-first; stop at the first URL already in the library
 * (or after maxPages). New items enter the normal ingestion queue.
 */
export async function syncBookmarks(maxPages = 5): Promise<SyncResult> {
  if (!xConfigured()) return { ok: false, added: 0, scanned: 0, error: 'X_CLIENT_ID not configured' };
  const auth = await freshToken();
  if (!auth) return { ok: false, added: 0, scanned: 0, error: 'X account not connected (or token refresh failed)' };

  let added = 0;
  let scanned = 0;
  let paginationToken: string | undefined;

  try {
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        max_results: '100',
        'tweet.fields': 'created_at,author_id',
        expansions: 'author_id',
        'user.fields': 'username',
      });
      if (paginationToken) params.set('pagination_token', paginationToken);
      const res = await fetch(`${API}/users/${auth.userId}/bookmarks?${params.toString()}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) return { ok: false, added, scanned, error: 'rate limited; will retry next sync' };
      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{ id: string; author_id?: string }>;
        includes?: { users?: Array<{ id: string; username: string }> };
        meta?: { next_token?: string };
        title?: string; detail?: string;
      };
      if (!res.ok) return { ok: false, added, scanned, error: `bookmarks ${res.status}: ${data.detail || data.title || 'error'}` };

      const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u.username]));
      const tweets = data.data ?? [];
      let sawExisting = false;
      for (const t of tweets) {
        scanned++;
        const username = (t.author_id && users.get(t.author_id)) || 'i';
        const url = `https://x.com/${username}/status/${t.id}`;
        if (getLibraryItemByUrl(url)) {
          sawExisting = true;
          continue; // keep scanning the page; bookmarks can be re-ordered
        }
        const id = crypto.randomBytes(4).toString('hex');
        createLibraryItem(id, url, 'x', { source: 'bookmark_sync' });
        added++;
      }
      paginationToken = data.meta?.next_token;
      // Newest-first: once a whole page is already known, stop early.
      if (!paginationToken || (sawExisting && added === 0 && page > 0)) break;
    }
    setDashboardSetting('x_bookmarks_last_sync', String(Math.floor(Date.now() / 1000)));
    setDashboardSetting('x_bookmarks_last_result', JSON.stringify({ added, scanned, at: Math.floor(Date.now() / 1000) }));
    logger.info({ scope: 'x-sync', added, scanned }, 'X bookmark sync complete');
    return { ok: true, added, scanned };
  } catch (err) {
    return { ok: false, added, scanned, error: String(err).slice(0, 300) };
  }
}

export function xSyncStatus(): {
  configured: boolean;
  connected: boolean;
  handle: string | null;
  last_sync: number | null;
  last_result: string | null;
} {
  const acc = getSocialAccount('x');
  const last = getDashboardSetting('x_bookmarks_last_sync');
  return {
    configured: xConfigured(),
    connected: !!acc,
    handle: acc?.handle ?? null,
    last_sync: last ? parseInt(last, 10) : null,
    last_result: getDashboardSetting('x_bookmarks_last_result'),
  };
}

// ── Nightly sync timer (main process only) ───────────────────────────
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function msUntil(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startXBookmarkSync(): void {
  if (syncTimer) return;
  const schedule = () => {
    // 2:30am local, after the nightly recap.
    syncTimer = setTimeout(async () => {
      try {
        if (getSocialAccount('x')) await syncBookmarks();
      } catch (err) {
        logger.warn({ scope: 'x-sync', err: String(err) }, 'nightly X bookmark sync failed');
      }
      schedule();
    }, msUntil(2, 30));
  };
  schedule();
  logger.info({ scope: 'x-sync' }, 'nightly X bookmark sync scheduled (2:30am)');
}

export function stopXBookmarkSync(): void {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
}
