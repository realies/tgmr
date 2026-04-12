import { logger } from './logger.js';

interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  retryableErrors?: Array<string | RegExp>;
}

const defaultOptions: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffFactor: 2,
  retryableErrors: [
    'Network request',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'socket hang up',
    'getaddrinfo',
    'HTTP Error 429',
    'HTTP Error 5',
    'Read timed out',
    'urlopen error',
    'Too Many Requests',
  ],
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelay;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (caught) {
      lastError = caught instanceof Error ? caught : new Error(String(caught));
      const errorMessage = lastError.message;
      const isRetryable = opts.retryableErrors.some((pattern) =>
        typeof pattern === 'string' ? errorMessage.includes(pattern) : pattern.test(errorMessage),
      );

      if (!isRetryable || attempt === opts.maxAttempts) {
        throw lastError;
      }

      const jittered = delay * (0.8 + Math.random() * 0.4);
      logger.warn(
        `Operation failed (attempt ${attempt}/${opts.maxAttempts}), retrying in ${
          Math.round(jittered) / 1000
        }s: ${errorMessage}`,
      );

      await new Promise((resolve) => setTimeout(resolve, jittered));
      delay = Math.min(delay * opts.backoffFactor, opts.maxDelay);
    }
  }

  throw lastError;
}
