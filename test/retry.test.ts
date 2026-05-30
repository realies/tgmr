import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/utils/retry.js';

test('withRetry returns immediately on success', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    return 42;
  });
  assert.equal(r, 42);
  assert.equal(calls, 1);
});

test('withRetry retries retryable errors then succeeds', async () => {
  let calls = 0;
  const r = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error('ETIMEDOUT while connecting');
      return 'ok';
    },
    { maxAttempts: 3, initialDelay: 1, maxDelay: 2 },
  );
  assert.equal(r, 'ok');
  assert.equal(calls, 2);
});

test('withRetry does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error('fatal: bad input');
        },
        { maxAttempts: 3, initialDelay: 1 },
      ),
    /fatal/,
  );
  assert.equal(calls, 1);
});

test('withRetry throws after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error('ECONNRESET');
        },
        { maxAttempts: 2, initialDelay: 1 },
      ),
    /ECONNRESET/,
  );
  assert.equal(calls, 2);
});

test('withRetry rejects invalid maxAttempts', async () => {
  await assert.rejects(() => withRetry(async () => 1, { maxAttempts: 0 }), RangeError);
  await assert.rejects(() => withRetry(async () => 1, { maxAttempts: 1.5 }), RangeError);
});
