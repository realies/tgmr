import { createBot } from './bot/index.js';
import { logger } from './utils/logger.js';
import { Cleanup } from './utils/cleanup.js';
import { RateLimiter } from './utils/rateLimit.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason });
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

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

    const shutdown = async (): Promise<void> => {
      logger.info('Shutting down...');
      // Hard-exit fallback if graceful shutdown hangs
      const hardExit = setTimeout(() => {
        logger.warn('Shutdown timed out, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      hardExit.unref();

      try {
        await bot.stop();
      } catch (error) {
        logger.error('Error stopping bot', { error });
      }
      Cleanup.stop();
      RateLimiter.getInstance().stop();
      process.exitCode = 0;
    };
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());

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
