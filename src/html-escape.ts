/**
 * Shared HTML-escaping helpers for the server-rendered dashboard / War Room
 * pages. Extracted from the four page generators (dashboard-html, warroom-html,
 * warroom-text-html, warroom-text-picker-html), which previously each carried a
 * byte-identical copy.
 */

/**
 * Escape the five HTML-significant characters so a string is safe to embed as
 * element text or inside a single/double-quoted attribute. `&` is replaced
 * first so the entities introduced by the later replacements are not
 * double-escaped.
 *
 * NOTE: this is the full five-character escaper for browser HTML. It is
 * intentionally NOT the Telegram-message escaper in bot.ts, which escapes only
 * `& < >` because Telegram's HTML mode needs no quote escaping. Those two have
 * different output and must stay separate.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON-encode a string for safe embedding inside an inline <script> block.
 * JSON.stringify alone leaves "<", ">", and "&" intact, so a value containing
 * "</script>" or "<!--" could break out of the script element. Escaping those
 * three as < / > / & keeps the decoded value byte-for-byte
 * identical at JS parse time while making the source inert.
 */
export function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
