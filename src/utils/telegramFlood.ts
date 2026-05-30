import { logger } from './logger.js';

const DEFAULT_MAX_ATTEMPTS = 2;
// Small buffer to clear the server's rate-limit window before retrying.
const RETRY_AFTER_BUFFER_MS = 500;

/**
 * Reads `retry_after` (seconds) from a Grammy 429 error.
 * Returns null for any other error shape, so callers know to rethrow.
 */
function getTelegramRetryAfter(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { error_code?: number; parameters?: { retry_after?: number } };
  if (e.error_code !== 429) return null;
  const ra = e.parameters?.retry_after;
  return typeof ra === 'number' && ra > 0 ? ra : null;
}

/**
 * Runs a Telegram send operation, retrying once on HTTP 429 by sleeping
 * exactly the server-reported `retry_after` (plus a small buffer).
 * Non-429 errors propagate immediately — this is not a generic retry layer.
 */
export async function withTelegramFlood<T>(
  operation: () => Promise<T>,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got: ${maxAttempts}`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryAfter = getTelegramRetryAfter(error);
      if (retryAfter === null || attempt === maxAttempts) throw error;
      const sleepMs = retryAfter * 1000 + RETRY_AFTER_BUFFER_MS;
      logger.warn(
        `Telegram 429 — waiting ${retryAfter}s before retry (attempt ${attempt}/${maxAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
  throw lastError ?? new Error('withTelegramFlood: all attempts failed without a captured error');
}
