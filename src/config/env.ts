export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN as string,
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '50000000', 10),
  DOWNLOAD_TIMEOUT: parseInt(process.env.DOWNLOAD_TIMEOUT || '300', 10),
  RATE_LIMIT: parseInt(process.env.RATE_LIMIT || '10', 10),
  COOLDOWN: parseInt(process.env.COOLDOWN || '60', 10),
  TMP_DIR: process.env.TMP_DIR || './tmp',
  SUPPORTED_DOMAINS: (process.env.SUPPORTED_DOMAINS || 'youtube.com,youtu.be').split(','),
} as const;

// Validate required environment variables
if (!env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required');
}
