import { resolve, isAbsolute } from 'path';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required');
}

function requirePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  // Reject partially-numeric typos like "60s" or "10MB" — parseInt would
  // silently accept them. Require a positive decimal integer.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }
  const val = Number(raw);
  if (val <= 0) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }
  return val;
}

export const env = {
  BOT_TOKEN,
  MAX_FILE_SIZE: requirePositiveInt('MAX_FILE_SIZE', process.env.MAX_FILE_SIZE, 50 * 1024 * 1024),
  DOWNLOAD_TIMEOUT: requirePositiveInt('DOWNLOAD_TIMEOUT', process.env.DOWNLOAD_TIMEOUT, 120),
  RATE_LIMIT: requirePositiveInt('RATE_LIMIT', process.env.RATE_LIMIT, 10),
  COOLDOWN: requirePositiveInt('COOLDOWN', process.env.COOLDOWN, 60),
  TMP_DIR: resolve(process.env.TMP_DIR || './tmp'),
  SUPPORTED_DOMAINS: (process.env.SUPPORTED_DOMAINS || 'youtube.com,youtu.be')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
} as const;

// Build cookie file lookup map once at startup, with validation
const cookieFileMap = new Map<string, string>();
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('COOKIES_FILE_') && value) {
    if (!isAbsolute(value)) {
      throw new Error(`${key} must be an absolute path, got: "${value}"`);
    }
    cookieFileMap.set(key.replace('COOKIES_FILE_', '').toLowerCase(), value);
  }
}
const defaultCookieFile = process.env.COOKIES_FILE
  ? ((): string => {
      if (!isAbsolute(process.env.COOKIES_FILE!)) {
        throw new Error(
          `COOKIES_FILE must be an absolute path, got: "${process.env.COOKIES_FILE}"`,
        );
      }
      return process.env.COOKIES_FILE!;
    })()
  : null;

// Unified site registry: each supported domain maps to an alias (cookie
// env-var key + gallery-dl extractor name) and a content type that drives
// download routing — 'image' sites use gallery-dl for images with yt-dlp
// fallback for video items; 'video' sites go straight to yt-dlp.
export interface SiteEntry {
  readonly alias: string;
  readonly type: 'image' | 'video';
}

const SITES: Readonly<Record<string, SiteEntry>> = {
  // Video-first platforms
  'youtu.be': { alias: 'youtube', type: 'video' },
  'youtube.com': { alias: 'youtube', type: 'video' },
  'facebook.com': { alias: 'facebook', type: 'video' },
  'soundcloud.com': { alias: 'soundcloud', type: 'video' },
  'bandcamp.com': { alias: 'bandcamp', type: 'video' },
  'vimeo.com': { alias: 'vimeo', type: 'video' },
  'mixcloud.com': { alias: 'mixcloud', type: 'video' },
  // Image-first platforms (gallery-dl, with yt-dlp for any video items)
  'instagram.com': { alias: 'instagram', type: 'image' },
  'twitter.com': { alias: 'twitter', type: 'image' },
  'x.com': { alias: 'twitter', type: 'image' },
  'pixiv.net': { alias: 'pixiv', type: 'image' },
  'deviantart.com': { alias: 'deviantart', type: 'image' },
  'artstation.com': { alias: 'artstation', type: 'image' },
};

// Matches exact hostname or any subdomain (duplicated from url.ts to avoid
// a circular import — url.ts imports env).
const domainMatches = (hostname: string, site: string): boolean =>
  hostname === site || hostname.endsWith(`.${site}`);

/**
 * Finds the site entry (alias + content type) for a domain. Matches exact
 * hostname or any subdomain (e.g. music.youtube.com → youtube).
 */
export const findSiteByDomain = (domain: string): SiteEntry | null => {
  const exact = SITES[domain];
  if (exact) return exact;
  for (const [siteDomain, entry] of Object.entries(SITES)) {
    if (domainMatches(domain, siteDomain)) return entry;
  }
  return null;
};

export const getCookieFileForDomain = (domain: string): string | null => {
  const site = findSiteByDomain(domain);
  if (site) return cookieFileMap.get(site.alias) || defaultCookieFile;
  return defaultCookieFile;
};

// Per-site request headers, keyed by site alias (e.g. 'instagram').
// Parsed from env vars like INSTAGRAM_USER_AGENT, INSTAGRAM_SEC_CH_UA, etc.
// Suffixes reserved for other config (COOKIES_FILE) are ignored. Invalid
// header names are rejected. Helps keep sessions fresh by matching the
// browser fingerprint that exported the cookies.
const RESERVED_SUFFIXES = new Set(['COOKIES_FILE']);
const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;
const siteHeadersMap = new Map<string, Record<string, string>>();
const knownSiteAliases = new Set(Object.values(SITES).map((s) => s.alias));

// Iterate sites → env vars (not the reverse) so collision-avoidance is explicit
for (const site of knownSiteAliases) {
  const prefix = `${site.toUpperCase()}_`;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (!suffix || RESERVED_SUFFIXES.has(suffix)) continue;
    const headerName = suffix.replace(/_/g, '-').toLowerCase();
    if (!HEADER_NAME_PATTERN.test(headerName)) continue;
    headers[headerName] = value;
  }
  if (Object.keys(headers).length > 0) siteHeadersMap.set(site, headers);
}

export const getSiteHeaders = (domain: string): Record<string, string> => {
  const site = findSiteByDomain(domain);
  if (!site) return {};
  // Shallow copy so a caller mutating the result can't leak into the shared cache.
  return { ...(siteHeadersMap.get(site.alias) ?? {}) };
};
