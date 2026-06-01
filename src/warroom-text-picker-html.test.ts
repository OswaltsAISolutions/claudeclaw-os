import { describe, it, expect } from 'vitest';
import { getWarRoomPickerHtml } from './warroom-text-picker-html.js';

// The picker page interpolates token + chatId into two contexts: an HTML
// attribute (the Back link href) and an inline <script> as JS constants.
// These tests pin the escaping so a token/chatId carrying HTML or quote
// metacharacters can never break out of either context.

// Mirror of the module-private jsLiteral so the script-escaping contract is
// pinned exactly without exporting the helper. The plain-JSON.stringify
// assertions below only exercise quote-escaping; these breakout tests prove
// the page actually carries the < > & escaping (a downgrade to bare
// JSON.stringify would silently pass every other test in this file).
function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

describe('getWarRoomPickerHtml', () => {
  it('returns a full HTML document', () => {
    const html = getWarRoomPickerHtml('abc', '123');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('HTML-escapes the token in the Back-link href', () => {
    const html = getWarRoomPickerHtml('"><script>alert(1)</script>', '');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('HTML-escapes the chatId in the href when present', () => {
    const html = getWarRoomPickerHtml('tok', 'x"y');
    expect(html).toContain('&chatId=x&quot;y');
    expect(html).not.toContain('chatId=x"y');
  });

  it('omits the chatId query param from the Back link when chatId is empty', () => {
    const html = getWarRoomPickerHtml('tok', '');
    // Assert against the Back-link href specifically: the &chatId= that still
    // appears in the page is the static history-fetch JS (...&chatId=' +
    // encodeURIComponent(CHAT_ID || '')), which is emitted regardless of the
    // chatId value and is not a reflected sink.
    expect(html).toContain('href="/?token=tok"');
  });

  it('encodes the token as a JS string literal in the inline script', () => {
    const token = 'a"b';
    const html = getWarRoomPickerHtml(token, '');
    // JSON.stringify gives a safely-quoted JS literal; the raw broken form must not appear.
    expect(html).toContain(`const TOKEN = ${JSON.stringify(token)};`);
    expect(html).not.toContain('const TOKEN = "a"b"');
  });

  it('encodes the chatId as a JS string literal in the inline script', () => {
    const chatId = "o'reilly";
    const html = getWarRoomPickerHtml('tok', chatId);
    expect(html).toContain(`const CHAT_ID = ${JSON.stringify(chatId)};`);
  });

  it('neutralizes a </script> breakout attempt in the token constant', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = getWarRoomPickerHtml(evil, '');
    expect(html).toContain(`const TOKEN = ${jsLiteral(evil)};`);
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('neutralizes a </script> breakout attempt in the chatId constant', () => {
    const evil = '</script><svg onload=alert(1)>';
    const html = getWarRoomPickerHtml('tok', evil);
    expect(html).toContain(`const CHAT_ID = ${jsLiteral(evil)};`);
    expect(html).not.toContain('</script><svg');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('round-trips a plain token into both the href and the JS constant', () => {
    const html = getWarRoomPickerHtml('abc123', '');
    expect(html).toContain('token=abc123');
    expect(html).toContain('const TOKEN = "abc123";');
  });
});
