import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTelegramFlood } from '../src/utils/telegramFlood.js';

test('withTelegramFlood returns on success', async () => {
  let calls = 0;
  const r = await withTelegramFlood(async () => {
    calls++;
    return 'sent';
  });
  assert.equal(r, 'sent');
  assert.equal(calls, 1);
});

test('withTelegramFlood propagates non-429 errors immediately', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withTelegramFlood(async () => {
        calls++;
        throw new Error('400 bad request');
      }),
    /400/,
  );
  assert.equal(calls, 1);
});

test('withTelegramFlood retries once on 429 honoring retry_after', async () => {
  let calls = 0;
  const start = Date.now();
  const r = await withTelegramFlood(async () => {
    calls++;
    if (calls < 2) throw { error_code: 429, parameters: { retry_after: 0.001 } };
    return 'sent';
  }, 2);
  assert.equal(r, 'sent');
  assert.equal(calls, 2);
  // Prove it actually waited (retry_after + the 500ms buffer) rather than
  // retrying immediately — otherwise the delay contract is untested.
  assert.ok(Date.now() - start >= 450, `retried after only ${Date.now() - start}ms`);
});

test('withTelegramFlood rejects invalid maxAttempts', async () => {
  await assert.rejects(() => withTelegramFlood(async () => 1, 0), RangeError);
  await assert.rejects(() => withTelegramFlood(async () => 1, 2.5), RangeError);
});
