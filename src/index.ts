import { createBot } from './bot/index.js';
import { logger } from './utils/logger.js';
import { Cleanup } from './utils/cleanup.js';
import { RateLimiter } from './utils/rateLimit.js';

async function main(): Promise<void> {
  try {
    await Cleanup.init();
    Cleanup.startPeriodicCleanup();
    logger.info('Started cleanup service');

    const bot = await createBot();
    logger.info('Starting bot...');

    try {
      await bot.api.getMe();
    } catch (error) {
      if (error instanceof Error && error.message.includes('404: Not Found')) {
        logger.error('Invalid bot token');
        process.exit(1);
      }
      throw error;
    }

    // Graceful shutdown
    const shutdown = (): void => {
      logger.info('Shutting down...');
      bot.stop();
      Cleanup.stop();
      RateLimiter.getInstance().stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await bot.start({
      onStart: (botInfo) => {
        logger.info(`Bot @${botInfo.username} is starting...`);
      },
      drop_pending_updates: true,
    });
  } catch (error) {
    logger.error('Failed to start bot', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Unhandled error in main', { error });
  process.exit(1);
});
