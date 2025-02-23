import { rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import { env } from '../config/env.js';

export class Cleanup {
  private static readonly MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  /**
   * Ensures the tmp directory exists and is empty
   */
  public static async init(): Promise<void> {
    try {
      // Only remove contents of the directory, not the directory itself
      const files = await readdir(env.TMP_DIR);
      await Promise.all(
        files.map((file) => rm(join(env.TMP_DIR, file), { recursive: true, force: true }))
      );
      logger.info(`Initialized temp directory: ${env.TMP_DIR}`);
    } catch (error) {
      // Ignore if directory is empty or doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error initializing temp directory', error);
      }
    }
  }

  /**
   * Cleans up old files from the tmp directory
   */
  public static async cleanOldFiles(): Promise<void> {
    try {
      const files = await readdir(env.TMP_DIR);
      const now = Date.now();

      for (const file of files) {
        const filePath = join(env.TMP_DIR, file);
        const stats = await stat(filePath);

        if (now - stats.mtimeMs > this.MAX_AGE) {
          await rm(filePath, { recursive: true, force: true });
          logger.info(`Removed old file: ${file}`);
        }
      }
    } catch (error) {
      // Only log if it's not a "no such file or directory" error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error cleaning up old files', error);
      }
    }
  }

  /**
   * Starts periodic cleanup of old files
   */
  public static startPeriodicCleanup(interval = 60 * 60 * 1000): void {
    // Default: 1 hour
    setInterval(() => {
      void this.cleanOldFiles();
    }, interval);
  }
}
