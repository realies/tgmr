// Validate required environment variables before exporting
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required');
}

export const env = {
  BOT_TOKEN,
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '50000000', 10),
  DOWNLOAD_TIMEOUT: parseInt(process.env.DOWNLOAD_TIMEOUT || '300', 10),
  RATE_LIMIT: parseInt(process.env.RATE_LIMIT || '10', 10),
  COOLDOWN: parseInt(process.env.COOLDOWN || '60', 10),
  TMP_DIR: process.env.TMP_DIR || './tmp',
  SUPPORTED_DOMAINS: (process.env.SUPPORTED_DOMAINS || 'youtube.com,youtu.be')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
} as const;

// Build cookie file lookup map once at startup
const cookieFileMap = new Map<string, string>();
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('COOKIES_FILE_') && value) {
    cookieFileMap.set(key.replace('COOKIES_FILE_', '').toLowerCase(), value);
  }
}
const defaultCookieFile = process.env.COOKIES_FILE || null;

export const getCookieFileForDomain = (domain: string): string | null => {
  if (domain === 'youtube.com' || domain === 'youtu.be') {
    return cookieFileMap.get('youtube') || defaultCookieFile;
  }
  if (domain === 'twitter.com' || domain === 'x.com') {
    return cookieFileMap.get('twitter') || cookieFileMap.get('x') || defaultCookieFile;
  }
  for (const [site, path] of cookieFileMap) {
    if (domain === `${site}.com` || domain === site) {
      return path;
    }
  }
  return defaultCookieFile;
};
