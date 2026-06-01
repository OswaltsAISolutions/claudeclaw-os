import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

// renderMarkdown renders chat/agent output, which can carry prompt-injected
// HTML. It runs marked -> DOMPurify with a strict allowlist (no images, no
// event handlers, URI-scheme filtering). These tests pin the security
// properties so a config regression that reopens an XSS vector fails loudly.
describe('renderMarkdown', () => {
  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders basic emphasis and inline code', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('`snippet`')).toContain('<code>snippet</code>');
  });

  it('keeps a safe https link with its href intact', () => {
    const out = renderMarkdown('[ok](https://example.com)');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('>ok<');
  });

  it('strips <script> tags and their payload', () => {
    const out = renderMarkdown('before<script>alert(1)</script>after');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    // Surrounding text survives (KEEP_CONTENT), only the script is gone.
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('strips images entirely (XSS / exfil vector)', () => {
    expect(renderMarkdown('![x](https://evil.test/x.png)')).not.toContain('<img');
    const evil = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(evil).not.toContain('<img');
    expect(evil).not.toContain('onerror');
  });

  it('neutralizes a javascript: URL in a link', () => {
    const out = renderMarkdown('[click](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
  });

  it('drops disallowed event-handler attributes but keeps the element text', () => {
    const out = renderMarkdown('<p onclick="alert(1)">hi</p>');
    expect(out).toContain('hi');
    expect(out).not.toContain('onclick');
  });

  it('neutralizes a data: URL in a link (HTML/script smuggling vector)', () => {
    const out = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
    expect(out).not.toContain('data:');
  });

  it('neutralizes a vbscript: URL in a link', () => {
    const out = renderMarkdown('[x](vbscript:msgbox(1))');
    expect(out).not.toContain('vbscript:');
  });

  it('keeps a mailto: link (allowlisted scheme)', () => {
    // The ALLOWED_URI_REGEXP explicitly permits mailto:; this is the positive
    // complement to the javascript:/data: rejections so a regex tightening
    // that breaks normal email links is caught.
    const out = renderMarkdown('[mail](mailto:a@b.com)');
    expect(out).toContain('href="mailto:a@b.com"');
  });

  it('strips <iframe> entirely (clickjacking / XSS vector)', () => {
    const out = renderMarkdown('<iframe src="https://evil.test"></iframe>');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('evil.test');
  });

  it('strips style attributes (CSS injection vector) but keeps the text', () => {
    const out = renderMarkdown('<p style="background:url(javascript:alert(1))">hi</p>');
    expect(out).toContain('hi');
    expect(out).not.toContain('style');
    expect(out).not.toContain('javascript');
  });

  it('renders GFM tables (pins gfm stays enabled)', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<table');
    expect(out).toContain('<td>1</td>');
  });
});
