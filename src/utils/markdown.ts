const MARKDOWNV2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const MARKDOWNV2_URL_CHARS = /[)\\]/g;

/**
 * Escapes special characters for Telegram's MarkdownV2 format.
 * Use for text content (titles, descriptions, stream info).
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_SPECIAL_CHARS, '\\$&');
}

/**
 * Escapes only the characters that need escaping inside the URL part
 * of a MarkdownV2 inline link [text](url). Per Telegram's spec, only
 * ')' and '\' need escaping inside the URL parentheses.
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(MARKDOWNV2_URL_CHARS, '\\$&');
}

/**
 * Normalizes line breaks: CRLF to LF, strips whitespace-only lines,
 * collapses 3+ consecutive newlines to double newline (paragraph break).
 * Preserves single-character lines and legitimate paragraph separation.
 */
export function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^\s+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
