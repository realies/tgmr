import { env } from '../config/env.js';
import { logger } from './logger.js';

interface RateLimitEntry {
  readonly count: number;
  readonly lastReset: number;
  readonly cooldownUntil: number;
}

export class RateLimiter {
  private static instance: RateLimiter;
  private limits = new Map<number, RateLimitEntry>();
  private readonly resetInterval = 60 * 1000;
  private evictTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.evictTimer = setInterval(() => this.evictStale(), 10 * 60 * 1000);
    this.evictTimer.unref();
  }

  public static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }

  /**
   * Atomically checks and consumes a rate limit slot.
   * Returns true if the request is allowed, false if rate-limited.
   */
  public tryConsume(userId: number): boolean {
    const now = Date.now();
    const entry = this.limits.get(userId);

    if (!entry) {
      this.limits.set(userId, { count: 1, lastReset: now, cooldownUntil: 0 });
      return true;
    }

    // In cooldown — reject
    if (entry.cooldownUntil > now) {
      const secondsLeft = Math.ceil((entry.cooldownUntil - now) / 1000);
      logger.info(`User ${userId} is in cooldown for ${secondsLeft} more seconds`);
      return false;
    }

    // Cooldown just expired — reset bucket and allow
    if (entry.cooldownUntil > 0) {
      this.limits.set(userId, { count: 1, lastReset: now, cooldownUntil: 0 });
      return true;
    }

    // Window expired — reset and allow
    if (now - entry.lastReset > this.resetInterval) {
      this.limits.set(userId, { count: 1, lastReset: now, cooldownUntil: 0 });
      return true;
    }

    // At limit — enter cooldown, reset count for next window
    if (entry.count >= env.RATE_LIMIT) {
      this.limits.set(userId, {
        count: 0,
        lastReset: now,
        cooldownUntil: now + env.COOLDOWN * 1000,
      });
      logger.info(`User ${userId} has exceeded rate limit, cooldown for ${env.COOLDOWN}s`);
      return false;
    }

    // Allow and increment
    this.limits.set(userId, { ...entry, count: entry.count + 1 });
    logger.debug(`User ${userId} has made ${entry.count + 1}/${env.RATE_LIMIT} requests`);
    return true;
  }

  private evictStale(): void {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000;
    for (const [userId, entry] of this.limits) {
      if (now - entry.lastReset > staleThreshold && entry.cooldownUntil <= now) {
        this.limits.delete(userId);
      }
    }
  }

  public stop(): void {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
  }
}
