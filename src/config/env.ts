export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN as string,
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '50000000', 10),
  DOWNLOAD_TIMEOUT: parseInt(process.env.DOWNLOAD_TIMEOUT || '300', 10),
  RATE_LIMIT: parseInt(process.env.RATE_LIMIT || '10', 10),
  COOLDOWN: parseInt(process.env.COOLDOWN || '60', 10),
  TMP_DIR: process.env.TMP_DIR || './tmp',
  SUPPORTED_DOMAINS: (process.env.SUPPORTED_DOMAINS || 'youtube.com,youtu.be').split(','),
} as const;

// Map domain patterns to their cookie files
export const getCookieFileForDomain = (domain: string): string | null => {
  // Get all environment variables starting with COOKIES_FILE_
  const cookieEnvVars = Object.entries(process.env)
    .filter(([key]) => key.startsWith('COOKIES_FILE_'))
    .map(([key, value]) => ({
      site: key.replace('COOKIES_FILE_', '').toLowerCase(),
      path: value
    }));

  // Find matching cookie file based on domain
  for (const { site, path } of cookieEnvVars) {
    // Handle special cases
    switch (site) {
      case 'youtube':
        if (domain === 'youtube.com' || domain === 'youtu.be') return path || null;
        break;
      case 'twitter':
      case 'x':
        if (domain === 'twitter.com' || domain === 'x.com') return path || null;
        break;
      default:
        // For other sites, match the domain directly
        if (domain === `${site}.com` || domain === site) return path || null;
    }
  }

  // Fallback to default cookies file if specified
  return process.env.COOKIES_FILE || null;
};

// Validate required environment variables
if (!env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required');
}
