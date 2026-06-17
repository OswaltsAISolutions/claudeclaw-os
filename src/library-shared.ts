// Shared helpers for the Content Library: URL detection + canonicalization.
// Kept tiny and dependency-free so bot.ts and dashboard.ts can import it
// without pulling in the ingestion worker.

export const SOCIAL_URL_RE = /https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com|instagram\.com|arxiv\.org)\/\S+/gi;

export interface CanonicalSocialUrl {
  url: string;
  platform: 'x' | 'instagram' | 'arxiv';
}

/**
 * Canonicalize an X / Instagram / arXiv URL so the UNIQUE(url) constraint
 * dedupes shares of the same item regardless of tracking params.
 *   - twitter.com -> x.com, strip query/fragment
 *   - X: keep /<user>/status/<id> (or /i/status/<id>)
 *   - IG: /p|reel|reels|tv/<code> -> https://www.instagram.com/<kind>/<code>/
 *   - arXiv: /abs|pdf/<id>[vN][.pdf] -> https://arxiv.org/abs/<id> (version stripped)
 * Returns null when the URL is recognized but not an ingestible item
 * (profiles, search pages, arXiv listings, etc.).
 */
export function canonicalizeSocialUrl(raw: string): CanonicalSocialUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www\.|mobile\.)/, '');

  if (host === 'x.com' || host === 'twitter.com') {
    const m = u.pathname.match(/^\/([A-Za-z0-9_]+|i)\/status(?:es)?\/(\d+)/);
    if (!m) return null;
    return { url: `https://x.com/${m[1]}/status/${m[2]}`, platform: 'x' };
  }

  if (host === 'instagram.com') {
    const m = u.pathname.match(/^\/(?:([A-Za-z0-9_.]+)\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const kind = m[2] === 'reels' ? 'reel' : m[2];
    return { url: `https://www.instagram.com/${kind}/${m[3]}/`, platform: 'instagram' };
  }

  if (host === 'arxiv.org') {
    // Modern ids (2502.12345) and legacy ids (q-fin.TR/0701123 style).
    const m = u.pathname.match(/^\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?\/?$/);
    if (!m) return null;
    return { url: `https://arxiv.org/abs/${m[1]}`, platform: 'arxiv' };
  }

  return null;
}

/** Extract every ingestible URL (social post or arXiv paper) from free text. */
export function extractSocialUrls(text: string): CanonicalSocialUrl[] {
  const seen = new Set<string>();
  const out: CanonicalSocialUrl[] = [];
  for (const match of text.matchAll(SOCIAL_URL_RE)) {
    const canon = canonicalizeSocialUrl(match[0]);
    if (canon && !seen.has(canon.url)) {
      seen.add(canon.url);
      out.push(canon);
    }
  }
  return out;
}

/** The arXiv id from a canonical arXiv URL, or null. */
export function arxivIdFromUrl(url: string): string | null {
  const m = url.match(/arxiv\.org\/abs\/(.+)$/);
  return m ? m[1] : null;
}
