import { describe, it, expect } from 'vitest';
import { getDashboardHtml } from './dashboard-html.js';

// The legacy Mission Control page interpolates the server token + the
// caller-supplied ?chatId= into an inline <script> (as JS constants) and,
// when the War Room is enabled, into a navigation onclick. chatId is
// unvalidated query input, so these tests pin the two output guards:
//   1. TOKEN/CHAT_ID are emitted via jsLiteral, which escapes < > & so a
//      value containing "</script>" cannot break out of the script element.
//   2. The War Room link is built from the runtime constants (encodeURIComponent)
//      rather than reflecting the raw chatId into the HTML attribute.

// Mirror of the module-private jsLiteral so the escaping contract is pinned
// exactly without exporting the helper.
function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

describe('getDashboardHtml', () => {
  it('returns a full HTML document', () => {
    expect(getDashboardHtml('tok', '123').startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('encodes the token as a JS string literal in the inline script', () => {
    const token = 'a"b';
    const html = getDashboardHtml(token, '');
    // No < > & here, so jsLiteral collapses to plain JSON.stringify.
    expect(html).toContain(`const TOKEN = ${JSON.stringify(token)};`);
    expect(html).not.toContain('const TOKEN = "a"b"');
  });

  it('encodes the chatId as a JS string literal in the inline script', () => {
    const chatId = "o'reilly";
    const html = getDashboardHtml('tok', chatId);
    expect(html).toContain(`const CHAT_ID = ${JSON.stringify(chatId)};`);
  });

  it('neutralizes a </script> breakout attempt in the chatId constant', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = getDashboardHtml('tok', evil);
    // The constant must carry the \\u003c-escaped form, never the raw closer.
    expect(html).toContain(`const CHAT_ID = ${jsLiteral(evil)};`);
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('neutralizes a </script> breakout attempt in the token constant', () => {
    const evil = '</script><svg onload=alert(1)>';
    const html = getDashboardHtml(evil, '');
    expect(html).toContain(`const TOKEN = ${jsLiteral(evil)};`);
    expect(html).not.toContain('</script><svg');
  });

  it('omits the War Room card when warroom is disabled (default)', () => {
    expect(getDashboardHtml('tok', '123')).not.toContain('Voice standup with your agent team');
  });

  it('renders the War Room card when warroom is enabled', () => {
    expect(getDashboardHtml('tok', '123', true)).toContain('Voice standup with your agent team');
  });

  it('builds the War Room link from runtime constants, not reflected input', () => {
    const evil = "'+alert(1)+'";
    const html = getDashboardHtml('tok', evil, true);
    // The onclick references the safe constants and URL-encodes them; the raw
    // chatId is never reflected into the attribute.
    expect(html).toContain(
      "onclick=\"window.location.href='/warroom?token=' + encodeURIComponent(TOKEN) + '&chatId=' + encodeURIComponent(CHAT_ID)\"",
    );
    expect(html).not.toContain(`chatId=${evil}`);
  });
});
