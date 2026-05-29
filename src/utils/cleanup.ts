import { rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import { env } from '../config/env.js';
import { assertSafePath } from './pathSafety.js';
import { getCachedFilePaths } from '../handlers/message.js';

export class Cleanup {
  private static readonly MAX_AGE = 7 * 24 * 60 * 60 * 1000; // Match download cache TTL
  private static cleanupTimer: NodeJS.Timeout | null = null;

  public static async init(): Promise<void> {
    try {
      const files = await readdir(env.TMP_DIR);
      await Promise.all(
        files.map((file) => {
          const filePath = assertSafePath(join(env.TMP_DIR, file), env.TMP_DIR);
          return rm(filePath, { recursive: true, force: true });
        }),
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
      // Files owned by a live cache entry are the cache's responsibility to evict;
      // skip them so a stale download-tool mtime can't delete a file that's still
      // cached (and possibly mid-send). The sweep then only reaps true orphans.
      const live = getCachedFilePaths();

      await Promise.all(
        files.map(async (file) => {
          try {
            const filePath = assertSafePath(join(env.TMP_DIR, file), env.TMP_DIR);
            if (live.has(filePath)) return;
            const stats = await stat(filePath);
            if (now - stats.mtimeMs > this.MAX_AGE) {
              await rm(filePath, { recursive: true, force: true });
              logger.info(`Removed old file: ${file}`);
            }
          } catch (error) {
            // A concurrent cleanup (cache-evict / per-request) may have removed
            // the file between readdir and stat — ENOENT is expected; ignore it
            // and never let one file abort the whole sweep.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              logger.warn('Failed to clean old file', { file, error });
            }
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
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanOldFiles();
    }, interval);
    this.cleanupTimer.unref();
  }

  public static stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
