import { describe, it, expect } from 'vitest';
import { escapeHtml, jsLiteral } from './html-escape.js';

// These pin the contract of the two shared escapers that the four server-page
// generators (dashboard / warroom / warroom-text / warroom-text-picker) now
// import instead of each carrying a byte-identical private copy. The
// generator-level tests still assert the rendered pages; these assert the
// primitives directly so a regression is localized to the helper.

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('replaces & first so introduced entities are not double-escaped', () => {
    // If "<" were escaped before "&", the "&" of "&lt;" would itself be
    // re-escaped to "&amp;lt;". Ampersand-first keeps it at "&lt;".
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('neutralizes a <script> tag so it cannot break out of element text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes both quote styles for safe attribute embedding', () => {
    expect(escapeHtml('"quoted" and \'single\'')).toBe(
      '&quot;quoted&quot; and &#39;single&#39;',
    );
  });

  it('leaves a string with no significant characters unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('jsLiteral', () => {
  it('produces a quoted JS string literal', () => {
    expect(jsLiteral('abc')).toBe('"abc"');
  });

  it('neutralizes a </script> breakout into an inert escape', () => {
    const out = jsLiteral('</script><img src=x onerror=alert(1)>');
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script\\u003e');
    expect(out).toContain('\\u003e'); // the trailing > of the img tag
  });

  it('escapes <, >, and & as \\u00xx without altering the decoded value', () => {
    const raw = 'a<b>c&d';
    const literal = jsLiteral(raw);
    expect(literal).toBe('"a\\u003cb\\u003ec\\u0026d"');
    // The source is inert, yet JS (here, JSON) parses it back to the original
    // byte-for-byte: escaping only changed the source encoding, not the value.
    expect(JSON.parse(literal)).toBe(raw);
  });

  it('round-trips arbitrary content through JSON.parse unchanged', () => {
    const raw = `mix "quotes" & <tags> and a newline\n`;
    expect(JSON.parse(jsLiteral(raw))).toBe(raw);
  });
});
