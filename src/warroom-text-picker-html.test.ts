import { describe, it, expect } from 'vitest';
import { getWarRoomPickerHtml } from './warroom-text-picker-html.js';

// The picker page interpolates token + chatId into two contexts: an HTML
// attribute (the Back link href) and an inline <script> as JS constants.
// These tests pin the escaping so a token/chatId carrying HTML or quote
// metacharacters can never break out of either context.
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

  it('round-trips a plain token into both the href and the JS constant', () => {
    const html = getWarRoomPickerHtml('abc123', '');
    expect(html).toContain('token=abc123');
    expect(html).toContain('const TOKEN = "abc123";');
  });
});
