// Shared Brave Search client. Used by the live-event sweep (content-sweep.ts)
// and the fact-checker (fact-checker.ts); the /api/web/search endpoint in
// dashboard.ts keeps its own inline copy because it proxies the raw response.

import { readEnvFile } from './env.js';

export interface BraveResult { title: string; url: string; description?: string; age?: string }

export async function braveSearch(
  q: string,
  opts: { count?: number; freshness?: 'pd' | 'pw' | 'pm' | 'py' } = {},
): Promise<BraveResult[]> {
  const envCfg = readEnvFile(['BRAVE_API_KEY']);
  const apiKey = envCfg.BRAVE_API_KEY || process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY not configured');

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(Math.max(1, Math.min(20, opts.count ?? 5))));
  if (opts.freshness) url.searchParams.set('freshness', opts.freshness);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`brave api ${res.status}`);
    const data = await res.json() as {
      web?: { results?: BraveResult[] };
      news?: { results?: BraveResult[] };
    };
    return [...(data.news?.results ?? []), ...(data.web?.results ?? [])];
  } finally {
    clearTimeout(timer);
  }
}

/** Strip tracking params/fragments so the same page dedups across lookups. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_)/.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return raw; }
}

export function domainOf(raw: string): string | null {
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return null; }
}
