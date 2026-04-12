import { rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import { env } from '../config/env.js';

export class Cleanup {
  private static readonly MAX_AGE = 24 * 60 * 60 * 1000;
  private static cleanupTimer: NodeJS.Timeout | null = null;

  public static async init(): Promise<void> {
    try {
      const files = await readdir(env.TMP_DIR);
      await Promise.all(
        files.map((file) => rm(join(env.TMP_DIR, file), { recursive: true, force: true })),
      );
      logger.info(`Initialized temp directory: ${env.TMP_DIR}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error initializing temp directory', { error });
      }
    }
  }

  public static async cleanOldFiles(): Promise<void> {
    try {
      const files = await readdir(env.TMP_DIR);
      const now = Date.now();

      await Promise.all(
        files.map(async (file) => {
          const filePath = join(env.TMP_DIR, file);
          const stats = await stat(filePath);
          if (now - stats.mtimeMs > this.MAX_AGE) {
            await rm(filePath, { recursive: true, force: true });
            logger.info(`Removed old file: ${file}`);
          }
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error cleaning up old files', { error });
      }
    }
  }

  public static startPeriodicCleanup(interval = 60 * 60 * 1000): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanOldFiles();
    }, interval);
  }

  public static stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
