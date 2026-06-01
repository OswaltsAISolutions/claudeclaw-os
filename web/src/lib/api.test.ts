import { describe, it, expect, beforeEach, vi } from 'vitest';

// api.ts appends the dashboard token to every authenticated request and SSE
// URL via withToken (reachable through tokenizedSseUrl). A bug in the
// separator choice (? vs &) or the encodeURIComponent step would break auth
// on every call or corrupt the query string. The token is resolved at
// module load from the URL query then sessionStorage, so we seed
// sessionStorage and re-import the module per case to control it.

async function freshApi(token: string) {
  sessionStorage.clear();
  if (token) sessionStorage.setItem('claudeclaw.token', token);
  vi.resetModules();
  return import('./api');
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('tokenizedSseUrl (token append)', () => {
  it('uses ? when the path has no query string', async () => {
    const { tokenizedSseUrl } = await freshApi('tok123');
    expect(tokenizedSseUrl('/api/x')).toBe('/api/x?token=tok123');
  });

  it('uses & when the path already has a query string', async () => {
    const { tokenizedSseUrl } = await freshApi('tok123');
    expect(tokenizedSseUrl('/api/x?mode=1')).toBe('/api/x?mode=1&token=tok123');
  });

  it('URL-encodes special characters in the token', async () => {
    const { tokenizedSseUrl } = await freshApi('a b&c=d');
    expect(tokenizedSseUrl('/api/x')).toBe('/api/x?token=a%20b%26c%3Dd');
  });

  it('exposes the token cached from sessionStorage', async () => {
    const { dashboardToken } = await freshApi('seeded-token');
    expect(dashboardToken).toBe('seeded-token');
  });
});

describe('ApiError', () => {
  it('is an Error that carries status and body', async () => {
    const { ApiError } = await freshApi('');
    const e = new ApiError(404, { error: 'nope' }, 'GET /x failed: 404');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(404);
    expect(e.body).toEqual({ error: 'nope' });
    expect(e.message).toBe('GET /x failed: 404');
  });
});
