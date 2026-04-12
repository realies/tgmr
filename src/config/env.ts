import { resolve, isAbsolute } from 'path';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required');
}

function requirePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const val = parseInt(raw, 10);
  if (!Number.isFinite(val) || val <= 0) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }
  return val;
}

export const env = {
  BOT_TOKEN,
  MAX_FILE_SIZE: requirePositiveInt('MAX_FILE_SIZE', process.env.MAX_FILE_SIZE, 50_000_000),
  DOWNLOAD_TIMEOUT: requirePositiveInt('DOWNLOAD_TIMEOUT', process.env.DOWNLOAD_TIMEOUT, 300),
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
  ? (() => {
      if (!isAbsolute(process.env.COOKIES_FILE!)) {
        throw new Error(
          `COOKIES_FILE must be an absolute path, got: "${process.env.COOKIES_FILE}"`,
        );
      }
      return process.env.COOKIES_FILE!;
    })()
  : null;

// Declarative domain-to-cookie-key alias map
const COOKIE_DOMAIN_ALIASES: Record<string, string> = {
  'youtu.be': 'youtube',
  'youtube.com': 'youtube',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'instagram.com': 'instagram',
  'facebook.com': 'facebook',
  'soundcloud.com': 'soundcloud',
  'bandcamp.com': 'bandcamp',
  'vimeo.com': 'vimeo',
  'mixcloud.com': 'mixcloud',
  'pixiv.net': 'pixiv',
  'deviantart.com': 'deviantart',
  'artstation.com': 'artstation',
};

export const getCookieFileForDomain = (domain: string): string | null => {
  const alias = COOKIE_DOMAIN_ALIASES[domain];
  if (alias) {
    return cookieFileMap.get(alias) || defaultCookieFile;
  }
  return defaultCookieFile;
};
