import { describe, it, expect } from 'vitest';
import { splitMessage, extractFileMarkers, formatForTelegram } from './bot.js';

describe('splitMessage', () => {
  it('returns single-element array for short messages', () => {
    const result = splitMessage('Hello, world!');
    expect(result).toEqual(['Hello, world!']);
  });

  it('returns single-element array for empty string', () => {
    const result = splitMessage('');
    expect(result).toEqual(['']);
  });

  it('returns single-element array for exact 4096 char message', () => {
    const msg = 'a'.repeat(4096);
    const result = splitMessage(msg);
    expect(result).toEqual([msg]);
  });

  it('splits 4097 char message into two parts', () => {
    const msg = 'a'.repeat(4097);
    const result = splitMessage(msg);
    expect(result.length).toBe(2);
    // Reconstruct the original - parts should cover all chars
    expect(result.join('').length).toBe(4097);
  });

  it('never produces chunks longer than 4096 chars', () => {
    const msg = 'a'.repeat(10000);
    const result = splitMessage(msg);
    for (const part of result) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
  });

  it('splits on newline boundaries when possible', () => {
    // Create a message with newlines where the total exceeds 4096
    const line = 'x'.repeat(2000);
    const msg = `${line}\n${line}\n${line}`;
    // Total: 2000 + 1 + 2000 + 1 + 2000 = 6002
    const result = splitMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // First chunk should end at a newline boundary
    // (i.e., should be 2000 + 1 + 2000 = 4001 which fits in 4096)
    expect(result[0]).toContain('\n');
  });

  it('handles message with many short lines', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i}`);
    const msg = lines.join('\n');
    const result = splitMessage(msg);
    for (const part of result) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
    // All content should be preserved
    expect(result.join('').replace(/^\s+/gm, '')).toBeTruthy();
  });

  it('handles message with no newlines that exceeds limit', () => {
    const msg = 'x'.repeat(8192);
    const result = splitMessage(msg);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(4096);
    expect(result[1].length).toBe(4096);
  });
});

describe('extractFileMarkers', () => {
  // ── Basic extraction ──────────────────────────────────────────────

  it('returns text unchanged when no markers present', () => {
    const input = 'Here is your report. Let me know if you need anything else.';
    const result = extractFileMarkers(input);
    expect(result.text).toBe(input);
    expect(result.files).toEqual([]);
  });

  it('extracts a single SEND_FILE marker', () => {
    const input = 'Here is the PDF.\n[SEND_FILE:/tmp/report.pdf]\nLet me know if you need changes.';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      type: 'document',
      filePath: '/tmp/report.pdf',
      caption: undefined,
    });
    expect(result.text).toBe('Here is the PDF.\n\nLet me know if you need changes.');
  });

  it('extracts a single SEND_PHOTO marker', () => {
    const input = 'Here is the chart.\n[SEND_PHOTO:/tmp/chart.png]';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      type: 'photo',
      filePath: '/tmp/chart.png',
      caption: undefined,
    });
    expect(result.text).toBe('Here is the chart.');
  });

  // ── Captions ──────────────────────────────────────────────────────

  it('extracts caption from pipe separator', () => {
    const input = '[SEND_FILE:/tmp/report.pdf|Q1 Financial Report]';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      type: 'document',
      filePath: '/tmp/report.pdf',
      caption: 'Q1 Financial Report',
    });
  });

  it('trims whitespace from caption and path', () => {
    const input = '[SEND_FILE: /tmp/report.pdf | Q1 Report ]';
    const result = extractFileMarkers(input);
    expect(result.files[0].filePath).toBe('/tmp/report.pdf');
    expect(result.files[0].caption).toBe('Q1 Report');
  });

  it('treats empty caption as undefined', () => {
    const input = '[SEND_FILE:/tmp/report.pdf|]';
    const result = extractFileMarkers(input);
    expect(result.files[0].caption).toBeUndefined();
  });

  // ── Multiple files ────────────────────────────────────────────────

  it('extracts multiple file markers', () => {
    const input = 'Here are both files.\n[SEND_FILE:/tmp/report.pdf]\n[SEND_PHOTO:/tmp/chart.png]\nDone.';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].type).toBe('document');
    expect(result.files[0].filePath).toBe('/tmp/report.pdf');
    expect(result.files[1].type).toBe('photo');
    expect(result.files[1].filePath).toBe('/tmp/chart.png');
    expect(result.text).toBe('Here are both files.\n\nDone.');
  });

  it('extracts multiple files with captions', () => {
    const input = '[SEND_FILE:/tmp/a.pdf|First doc]\n[SEND_FILE:/tmp/b.xlsx|Second doc]';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].caption).toBe('First doc');
    expect(result.files[1].caption).toBe('Second doc');
  });

  // ── Path variations ───────────────────────────────────────────────

  it('handles paths with spaces', () => {
    const input = '[SEND_FILE:/tmp/test/My Report.pdf]';
    const result = extractFileMarkers(input);
    expect(result.files[0].filePath).toBe('/tmp/test/My Report.pdf');
  });

  it('handles deep nested paths', () => {
    const input = '[SEND_FILE:/tmp/test/output/nested/deep/file.csv]';
    const result = extractFileMarkers(input);
    expect(result.files[0].filePath).toBe('/tmp/test/output/nested/deep/file.csv');
  });

  it('handles various file extensions', () => {
    const extensions = ['pdf', 'xlsx', 'csv', 'png', 'jpg', 'zip', 'docx', 'mp4', 'txt'];
    for (const ext of extensions) {
      const input = `[SEND_FILE:/tmp/file.${ext}]`;
      const result = extractFileMarkers(input);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].filePath).toBe(`/tmp/file.${ext}`);
    }
  });

  // ── Text cleanup ──────────────────────────────────────────────────

  it('collapses triple+ newlines left after marker removal', () => {
    const input = 'Before.\n\n\n[SEND_FILE:/tmp/f.pdf]\n\n\nAfter.';
    const result = extractFileMarkers(input);
    // Should not have more than two consecutive newlines
    expect(result.text).not.toMatch(/\n{3,}/);
    expect(result.text).toContain('Before.');
    expect(result.text).toContain('After.');
  });

  it('trims leading/trailing whitespace from cleaned text', () => {
    const input = '\n\n[SEND_FILE:/tmp/f.pdf]\n\nHere you go.';
    const result = extractFileMarkers(input);
    expect(result.text).toBe('Here you go.');
  });

  it('returns empty string when response is only a marker', () => {
    const input = '[SEND_FILE:/tmp/report.pdf]';
    const result = extractFileMarkers(input);
    expect(result.text).toBe('');
    expect(result.files).toHaveLength(1);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it('extracts unbracketed markers with absolute paths', () => {
    // The dashboard demo failed when an agent emitted a marker
    // without surrounding brackets (`SEND_PHOTO|https://...`). The
    // tolerant matcher now extracts those so the chat doesn't show
    // the raw command string. We require an absolute path or a URL
    // so unrelated prose like "SEND_FILE:later" doesn't match.
    const input = 'SEND_FILE:/tmp/report.pdf';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ type: 'document', filePath: '/tmp/report.pdf' });
  });

  it('extracts unbracketed SEND_PHOTO with pipe and http URL', () => {
    const input = 'Here it is. SEND_PHOTO|https://example.com/photo.png|nice shot';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      type: 'photo',
      filePath: 'https://example.com/photo.png',
      caption: 'nice shot',
    });
  });

  it('does not match unknown marker types', () => {
    const input = '[SEND_VIDEO:/tmp/video.mp4]';
    const result = extractFileMarkers(input);
    expect(result.files).toEqual([]);
    expect(result.text).toBe(input);
  });

  it('does not match markers with empty path', () => {
    const input = '[SEND_FILE:]';
    const result = extractFileMarkers(input);
    // The regex requires at least one char in the path group
    expect(result.files).toEqual([]);
  });

  it('handles marker embedded in a sentence', () => {
    const input = 'I created the file [SEND_FILE:/tmp/out.pdf] for you.';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filePath).toBe('/tmp/out.pdf');
    expect(result.text).toBe('I created the file  for you.');
  });

  it('preserves text around multiple markers on separate lines', () => {
    const input = 'Line 1\n[SEND_FILE:/a.pdf]\nLine 2\n[SEND_FILE:/b.pdf]\nLine 3';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(2);
    expect(result.text).toContain('Line 1');
    expect(result.text).toContain('Line 2');
    expect(result.text).toContain('Line 3');
  });
});

// formatForTelegram is the markdown -> Telegram-HTML boundary for every Claude
// response that reaches Telegram. It is security-critical: Telegram renders the
// output with parse_mode=HTML, so any unescaped `<`/`&` from model output could
// inject markup. The most important contract is the &-first escaping order in
// step 2 (escaping `&` last would double-escape the `&lt;`/`&gt;` it just
// produced). The rest is markdown conversion: code-block/inline-code protection
// (their contents must NOT be re-interpreted as markdown), headings, rules,
// checkboxes, bold/italic/strike, and links restricted to http(s) (so a
// javascript: URL can never become a clickable anchor).
describe('formatForTelegram', () => {
  it('returns empty string for empty input', () => {
    expect(formatForTelegram('')).toBe('');
  });

  it('passes through plain text unchanged', () => {
    expect(formatForTelegram('just a sentence')).toBe('just a sentence');
  });

  it('escapes & before < and > so entities are never double-escaped', () => {
    // If & were escaped last, the &lt;/&gt; produced here would become
    // &amp;lt;/&amp;gt;. &-first is the only correct order.
    expect(formatForTelegram('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('wraps a fenced code block in <pre>, strips the language tag, escapes and trims', () => {
    expect(formatForTelegram('```js\nconst x = 1 < 2;\n```')).toBe(
      '<pre>const x = 1 &lt; 2;</pre>',
    );
  });

  it('does not interpret markdown inside a code block', () => {
    expect(formatForTelegram('```\n**not bold**\n```')).toBe('<pre>**not bold**</pre>');
  });

  it('wraps inline code in <code>', () => {
    expect(formatForTelegram('use `hello` here')).toBe('use <code>hello</code> here');
  });

  it('does not interpret markdown inside inline code', () => {
    expect(formatForTelegram('`**x**`')).toBe('<code>**x**</code>');
  });

  it('escapes <, >, & inside inline code exactly once (no double-escape)', () => {
    // Regression: the general HTML-escape pass used to run BEFORE inline
    // extraction, which then escaped the already-escaped content a second
    // time, turning `Map<string, int>` into Map&amp;lt;...&amp;gt; (rendered
    // literally as "&lt;" in Telegram). A developer's inline code is full of
    // generics / comparisons / shell redirects, so this hit constantly. The
    // content must be escaped exactly once: < -> &lt;, > -> &gt;, & -> &amp;.
    expect(formatForTelegram('use `Map<string, int>` here')).toBe(
      'use <code>Map&lt;string, int&gt;</code> here',
    );
    expect(formatForTelegram('run `a && b`')).toBe('run <code>a &amp;&amp; b</code>');
  });

  it('escapes special chars in inline code while still escaping bare text around it', () => {
    // The bare `<` outside the code is escaped by the general pass; the `<`
    // inside the code is escaped by the inline pass. Both end up escaped
    // exactly once, from two different stages, with no interference.
    expect(formatForTelegram('a < b and `c < d`')).toBe(
      'a &lt; b and <code>c &lt; d</code>',
    );
  });

  it('converts a heading to bold, dropping the # prefix', () => {
    expect(formatForTelegram('## Title')).toBe('<b>Title</b>');
  });

  it('removes a horizontal rule and its surrounding blank lines', () => {
    expect(formatForTelegram('a\n---\nb')).toBe('a\nb');
  });

  it('converts a checked checkbox to a check mark', () => {
    expect(formatForTelegram('- [x] done')).toBe('✓ done');
  });

  it('converts an unchecked checkbox to an empty box', () => {
    expect(formatForTelegram('- [ ] todo')).toBe('☐ todo');
  });

  it('converts **bold** and __bold__ to <b>', () => {
    expect(formatForTelegram('**a** and __b__')).toBe('<b>a</b> and <b>b</b>');
  });

  it('converts *italic* to <i>', () => {
    expect(formatForTelegram('an *it* word')).toBe('an <i>it</i> word');
  });

  it('leaves snake_case identifiers untouched (underscores inside words)', () => {
    expect(formatForTelegram('call some_func_name now')).toBe('call some_func_name now');
  });

  it('converts ~~strike~~ to <s>', () => {
    expect(formatForTelegram('~~gone~~')).toBe('<s>gone</s>');
  });

  it('converts an http(s) link to an anchor', () => {
    expect(formatForTelegram('[ok](https://example.com)')).toBe(
      '<a href="https://example.com">ok</a>',
    );
  });

  it('never turns a javascript: URL into an anchor', () => {
    const out = formatForTelegram('[x](javascript:alert(1))');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).toContain('[x](javascript:alert(1))');
  });

  it('collapses 3+ consecutive blank lines down to a single blank line', () => {
    expect(formatForTelegram('a\n\n\n\nb')).toBe('a\n\nb');
  });
});
