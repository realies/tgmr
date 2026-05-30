// Query params that never identify content — stripped so they don't fragment
// the cache. Everything else is kept (sorted) so distinct content under the
// same path (e.g. facebook /watch/?v=ID) doesn't collide to one key.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'igsh',
  'igshid',
  'si',
  'feature',
]);

/**
 * Normalizes a URL to a stable cache key.
 * - Strips protocol, www., fragments, trailing slashes
 * - Canonicalizes domain aliases (youtu.be→youtube.com, x.com→twitter.com)
 * - For YouTube, keeps only ?v=ID
 * - Drops tracking query params; keeps the rest (sorted) because content can
 *   live in the query string (e.g. facebook /watch/?v=ID)
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Upstream validation should prevent this, but fall back to the raw
    // string so callers (cache keys, in-flight map) don't see exceptions.
    return url;
  }
  let host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');

  // youtu.be/ID → youtube.com/watch?v=ID
  if (host === 'youtu.be') {
    return `youtube.com/watch?v=${path.slice(1)}`;
  }

  // youtube.com/watch?v=ID — keep only the video id.
  if (host === 'youtube.com') {
    const v = parsed.searchParams.get('v');
    if (v) return `youtube.com/watch?v=${v}`;
  }

  // x.com → twitter.com
  if (host === 'x.com') host = 'twitter.com';

  // Keep content-identifying query params (drop tracking noise), sorted for a
  // stable key, so e.g. facebook /watch/?v=1 and ?v=2 stay distinct.
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';

  return `${host}${path}${query}`;
}
