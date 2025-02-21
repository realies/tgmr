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
    } catch (error) {
      lastError = error as Error;
      const errorMessage = lastError.message || String(error);
      const isRetryable = opts.retryableErrors.some(pattern =>
        typeof pattern === 'string'
          ? errorMessage.includes(pattern)
          : pattern.test(errorMessage)
      );

      if (!isRetryable || attempt === opts.maxAttempts) {
        throw lastError;
      }

      logger.warn(
        `Operation failed (attempt ${attempt}/${opts.maxAttempts}), retrying in ${
          delay / 1000
        }s: ${errorMessage}`,
      );

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * opts.backoffFactor, opts.maxDelay);
    }
  }

  throw lastError;
}
