import { escapeMarkdownV2, escapeMarkdownV2Url, normalizeLineBreaks } from './markdown.js';

// Telegram media captions are capped at 1024 chars.
const TELEGRAM_CAPTION_MAX = 1024;

export interface CaptionMediaItem {
  isVideo: boolean;
  streamInfo: string;
  fileSizeMB: string;
}

/**
 * Truncates a raw (pre-escape) title so the final caption fits within
 * Telegram's 1024-char cap. `suffixLength` is the already-known escaped
 * tail length (link syntax + info/size block). A 2x factor conservatively
 * accounts for MarkdownV2 escape expansion.
 */
function truncateTitleForCaption(title: string, suffixLength: number): string {
  // The result is MarkdownV2 inline-link label text, which must be single-line:
  // a literal newline inside [label](url) makes Telegram reject the caption (400).
  const oneLine = title.replace(/\s*\n+\s*/g, ' ');
  const budget = TELEGRAM_CAPTION_MAX - suffixLength - 1; // -1 for the ellipsis
  if (budget <= 0) return '';
  const maxRawTitle = Math.floor(budget / 2);
  if (oneLine.length <= maxRawTitle) return oneLine;
  // budget === 1 → maxRawTitle === 0: no room for even one title char.
  if (maxRawTitle <= 0) return '';
  // Slice by code point (not UTF-16 unit) so a multi-byte emoji at the cut
  // boundary isn't split into a lone surrogate — Telegram rejects those (400).
  // Each code point still contributes ≤ 2 escaped units, so the cap holds.
  const truncated = Array.from(oneLine)
    .slice(0, maxRawTitle - 1)
    .join('');
  return truncated.trimEnd() + '…';
}

export function buildSingleCaption(title: string, url: string, item: CaptionMediaItem): string {
  const escapedUrl = escapeMarkdownV2Url(url);
  const escapedInfo = escapeMarkdownV2(item.streamInfo);
  const escapedSize = escapeMarkdownV2(item.fileSizeMB);
  const infoBlock = `\`${escapedInfo}, ${escapedSize}MB\``;
  // Fixed tail: `](url)\n\`info, sizeMB\``, plus the leading `[` of the link
  const suffix = `](${escapedUrl})\n${infoBlock}`;
  // If even a zero-length title plus the link would exceed the cap
  // (pathologically long URL), drop the link entirely and emit info only.
  if (suffix.length + 2 > TELEGRAM_CAPTION_MAX) return infoBlock;
  const truncated = truncateTitleForCaption(normalizeLineBreaks(title), suffix.length + 1);
  return `[${escapeMarkdownV2(truncated)}${suffix}`;
}

export function buildGroupCaption(
  title: string,
  url: string,
  chunk: CaptionMediaItem[],
  isFirstChunk: boolean,
): string {
  const imageFormats = new Map<string, { count: number; codec: string; dims: string | null }>();
  const videoFormats = new Map<string, { count: number; codec: string; dims: string | null }>();
  let chunkTotalSize = 0;

  for (const item of chunk) {
    const tokens = item.streamInfo.trim().split(/\s+/);
    const codec = tokens[0] || 'unknown';
    // Only accept WxH — otherwise the token is bitrate/sample-rate from an
    // audio stream, not dimensions. Prevents "opus image at 128kbps" for audio.
    const dims = tokens[1] && /^\d+x\d+$/.test(tokens[1]) ? tokens[1] : null;
    const key = `${codec}-${dims ?? ''}`;

    if (item.isVideo) {
      const existing = videoFormats.get(key) || { count: 0, codec, dims };
      videoFormats.set(key, { ...existing, count: existing.count + 1 });
    } else {
      const existing = imageFormats.get(key) || { count: 0, codec, dims };
      imageFormats.set(key, { ...existing, count: existing.count + 1 });
    }
    chunkTotalSize += parseFloat(item.fileSizeMB) || 0;
  }

  const formatParts: string[] = [];
  if (imageFormats.size > 0) {
    const summary = Array.from(imageFormats.values())
      .map((i) => {
        const suffix = i.dims ? ` at ${i.dims}` : '';
        return `${i.count} ${i.codec} image${i.count > 1 ? 's' : ''}${suffix}`;
      })
      .join(', ');
    formatParts.push(summary);
  }
  if (videoFormats.size > 0) {
    const summary = Array.from(videoFormats.values())
      .map((i) => {
        const suffix = i.dims ? ` at ${i.dims}` : '';
        return `${i.count} ${i.codec} video${i.count > 1 ? 's' : ''}${suffix}`;
      })
      .join(', ');
    formatParts.push(summary);
  }

  const escapedSize = escapeMarkdownV2(chunkTotalSize.toFixed(1));
  const escapedSummary = escapeMarkdownV2(formatParts.join(', '));
  const sizeLabel = escapedSummary
    ? `\`${escapedSummary}, ${escapedSize}MB total\``
    : `\`${escapedSize}MB total\``;

  if (isFirstChunk) {
    const escapedUrl = escapeMarkdownV2Url(url);
    const suffix = `](${escapedUrl})\n${sizeLabel}`;
    // Same pathological-URL guard as the single-media case
    if (suffix.length + 2 > TELEGRAM_CAPTION_MAX) return sizeLabel;
    const truncated = truncateTitleForCaption(normalizeLineBreaks(title), suffix.length + 1);
    return `[${escapeMarkdownV2(truncated)}${suffix}`;
  }
  return sizeLabel;
}
