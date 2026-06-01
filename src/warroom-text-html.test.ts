import { describe, it, expect } from 'vitest';
import { getWarRoomTextHtml } from './warroom-text-html.js';

// The text War Room page interpolates token + chatId + meetingId into HTML
// attributes (Back-link href, via escapeHtml) and inline <script> JS constants
// (TOKEN / CHAT_ID / MEETING_ID, via jsLiteral). These tests pin both guards.

// Mirror of the module-private jsLiteral so the script-escaping contract is
// pinned exactly without exporting the helper.
function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

describe('getWarRoomTextHtml', () => {
  it('returns a full HTML document', () => {
    expect(getWarRoomTextHtml('tok', '123', 'wr_abcd').startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('encodes token, chatId and meetingId as JS string literals in the script', () => {
    const html = getWarRoomTextHtml('a"b', "o'reilly", 'wr_x"y');
    expect(html).toContain(`const TOKEN = ${jsLiteral('a"b')};`);
    expect(html).toContain(`const CHAT_ID = ${jsLiteral("o'reilly")};`);
    expect(html).toContain(`const MEETING_ID = ${jsLiteral('wr_x"y')};`);
  });

  it('neutralizes a </script> breakout attempt in the meetingId constant', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = getWarRoomTextHtml('tok', '', evil);
    expect(html).toContain(`const MEETING_ID = ${jsLiteral(evil)};`);
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('HTML-escapes the token in the Back-link href', () => {
    const html = getWarRoomTextHtml('"><script>alert(1)</script>', '', 'wr_abcd');
    expect(html).toContain('token=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="/?token="><script>alert(1)</script>');
  });

  it('omits the chatId query param from the Back link when chatId is empty', () => {
    const html = getWarRoomTextHtml('tok', '', 'wr_abcd');
    expect(html).toContain('href="/?token=tok"');
  });
});
