import { describe, it, expect } from 'vitest';
import { getWarRoomHtml } from './warroom-html.js';

// The voice War Room page interpolates token + chatId into two contexts: HTML
// attributes (avatar/music/back-link hrefs, via escapeHtml) and inline <script>
// JS constants (TOKEN / CHAT_ID, via jsLiteral). These tests pin both guards so
// a token/chatId carrying HTML or quote metacharacters can't break out of
// either context.

// Mirror of the module-private jsLiteral so the script-escaping contract is
// pinned exactly without exporting the helper.
function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

describe('getWarRoomHtml', () => {
  it('returns a full HTML document', () => {
    expect(getWarRoomHtml('tok', '123', 8788).startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('encodes token and chatId as JS string literals in the inline script', () => {
    const html = getWarRoomHtml('a"b', "o'reilly", 8788);
    expect(html).toContain(`const TOKEN = ${jsLiteral('a"b')};`);
    expect(html).toContain(`const CHAT_ID = ${jsLiteral("o'reilly")};`);
  });

  it('neutralizes a </script> breakout attempt in the chatId constant', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = getWarRoomHtml('tok', evil, 8788);
    expect(html).toContain(`const CHAT_ID = ${jsLiteral(evil)};`);
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('HTML-escapes the token in attribute contexts (back-link href)', () => {
    const html = getWarRoomHtml('"><script>alert(1)</script>', '', 8788);
    expect(html).toContain('token=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
