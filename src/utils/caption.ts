import { escapeMarkdownV2, escapeMarkdownV2Url, normalizeLineBreaks } from './markdown.js';

export interface CaptionMediaItem {
  isVideo: boolean;
  streamInfo: string;
  fileSizeMB: string;
}

export function buildSingleCaption(title: string, url: string, item: CaptionMediaItem): string {
  const escapedTitle = escapeMarkdownV2(normalizeLineBreaks(title));
  const escapedUrl = escapeMarkdownV2Url(url);
  const escapedInfo = escapeMarkdownV2(item.streamInfo);
  const escapedSize = escapeMarkdownV2(item.fileSizeMB);
  return `[${escapedTitle}](${escapedUrl})\n\`${escapedInfo}, ${escapedSize}MB\``;
}

export function buildGroupCaption(
  title: string,
  url: string,
  chunk: CaptionMediaItem[],
  isFirstChunk: boolean,
): string {
  const imageFormats = new Map<string, { count: number; codec: string; dims: string }>();
  const videoFormats = new Map<string, { count: number; codec: string; dims: string }>();
  let chunkTotalSize = 0;

  for (const item of chunk) {
    const parts = item.streamInfo.split(' ');
    const codec = parts[0] || 'unknown';
    const dims = parts[1] || 'unknown';
    const key = `${codec}-${dims}`;

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
      .map((i) => `${i.count} ${i.codec} image${i.count > 1 ? 's' : ''} at ${i.dims}`)
      .join(', ');
    formatParts.push(summary);
  }
  if (videoFormats.size > 0) {
    const summary = Array.from(videoFormats.values())
      .map((i) => `${i.count} ${i.codec} video${i.count > 1 ? 's' : ''} at ${i.dims}`)
      .join(', ');
    formatParts.push(summary);
  }

  const escapedSummary = escapeMarkdownV2(formatParts.join(', '));
  const escapedSize = escapeMarkdownV2(chunkTotalSize.toFixed(1));
  const sizeLabel = `\`${escapedSummary}, ${escapedSize}MB total\``;

  if (isFirstChunk) {
    const escapedTitle = escapeMarkdownV2(normalizeLineBreaks(title));
    const escapedUrl = escapeMarkdownV2Url(url);
    return `[${escapedTitle}](${escapedUrl})\n${sizeLabel}`;
  }
  return sizeLabel;
}
