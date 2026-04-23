/**
 * Normalizes a URL to a stable cache key by stripping the protocol,
 * www prefix, and everything from the first '&' onward. The content
 * identifier on supported platforms is always before the first '&'.
 */
export function normalizeUrl(url: string): string {
  const ampIndex = url.indexOf('&');
  const cleaned = ampIndex >= 0 ? url.slice(0, ampIndex) : url;
  return cleaned.replace(/^https?:\/\/(www\.)?/, '');
}
