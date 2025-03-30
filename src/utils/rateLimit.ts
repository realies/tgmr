import { env } from '../config/env.js';
import { logger } from './logger.js';

interface RateLimitEntry {
  count: number;
  lastReset: number;
  cooldownUntil: number;
}

export class RateLimiter {
  private limits: Map<number, RateLimitEntry> = new Map();
  private readonly resetInterval = 60 * 1000; // 1 minute in milliseconds

  /**
   * Checks if a user can make a request
   * @param userId The user ID to check
   * @returns Whether the user is allowed to make a request
   */
  public canMakeRequest(userId: number): boolean {
    const now = Date.now();
    const entry = this.getOrCreateEntry(userId, now);

    // Check if user is in cooldown
    if (entry.cooldownUntil > now) {
      const secondsLeft = Math.ceil((entry.cooldownUntil - now) / 1000);
      logger.info(`User ${userId} is in cooldown for ${secondsLeft} more seconds`);
      return false;
    }

    // Check if rate limit exceeded
    if (entry.count >= env.RATE_LIMIT) {
      // Set cooldown period
      entry.cooldownUntil = now + env.COOLDOWN * 1000;
      logger.info(`User ${userId} has exceeded rate limit, cooldown for ${env.COOLDOWN}s`);
      return false;
    }

    // User can make request
    return true;
  }

  /**
   * Records a request for a user
   * @param userId The user ID making the request
   */
  public recordRequest(userId: number): void {
    const now = Date.now();
    const entry = this.getOrCreateEntry(userId, now);
    entry.count++;
    logger.debug(`User ${userId} has made ${entry.count}/${env.RATE_LIMIT} requests`);
  }

  /**
   * Gets or creates a rate limit entry for a user
   */
  private getOrCreateEntry(userId: number, now: number): RateLimitEntry {
    let entry = this.limits.get(userId);

    // Create new entry if none exists
    if (!entry) {
      entry = {
        count: 0,
        lastReset: now,
        cooldownUntil: 0,
      };
      this.limits.set(userId, entry);
      return entry;
    }

    // Reset count if minute has passed
    if (now - entry.lastReset > this.resetInterval) {
      entry.count = 0;
      entry.lastReset = now;
    }

    return entry;
  }

  // Singleton pattern
  private static instance: RateLimiter;

  public static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }
}
