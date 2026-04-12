const MARKDOWNV2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/**
 * Escapes special characters for Telegram's MarkdownV2 format.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_SPECIAL_CHARS, '\\$&');
}

/**
 * Normalizes line breaks in text to have at most one empty line between content.
 */
export function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^\s*(.)\s*$/gm, (match) => {
      return match.trim().length > 1 ? match : '';
    })
    .replace(/(\n\s*(.)\s*\n\s*\2\s*\n\s*)+/g, '\n')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
