import { env } from '../config/env.js';
import { logger } from './logger.js';

interface RateLimitEntry {
  readonly count: number;
  readonly lastReset: number;
  readonly cooldownUntil: number;
}

const EVICTION_INTERVAL_MS = 10 * 60 * 1000;

export class RateLimiter {
  private static instance: RateLimiter;
  private limits = new Map<number, RateLimitEntry>();
  private readonly resetInterval = 60 * 1000;
  private evictTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.evictTimer = setInterval(() => this.evictStale(), EVICTION_INTERVAL_MS);
    this.evictTimer.unref();
  }

  public static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }

  public tryConsume(userId: number): boolean {
    const now = Date.now();
    const entry = this.limits.get(userId);

    if (!entry) {
      this.limits.set(userId, { count: 1, lastReset: now, cooldownUntil: 0 });
      return true;
    }

    if (entry.cooldownUntil > now) {
      const secondsLeft = Math.ceil((entry.cooldownUntil - now) / 1000);
      logger.info(`User ${userId} is in cooldown for ${secondsLeft} more seconds`);
      return false;
    }

    if (entry.cooldownUntil > 0) {
      this.limits.set(userId, { count: 1, lastReset: now, cooldownUntil: 0 });
      return true;
    }

    if (now - entry.lastReset > this.resetInterval) {
      this.limits.set(userId, { count: 1, lastReset: now, cooldownUntil: 0 });
      return true;
    }

    if (entry.count >= env.RATE_LIMIT) {
      this.limits.set(userId, {
        count: 0,
        lastReset: now,
        cooldownUntil: now + env.COOLDOWN * 1000,
      });
      logger.info(`User ${userId} has exceeded rate limit, cooldown for ${env.COOLDOWN}s`);
      return false;
    }

    this.limits.set(userId, { ...entry, count: entry.count + 1 });
    logger.debug(`User ${userId} has made ${entry.count + 1}/${env.RATE_LIMIT} requests`);
    return true;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [userId, entry] of this.limits) {
      if (now - entry.lastReset > EVICTION_INTERVAL_MS && entry.cooldownUntil <= now) {
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
