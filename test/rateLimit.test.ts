import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/utils/rateLimit.js';
import { env } from '../src/config/env.js';

// Each test uses a unique user id because RateLimiter is a process-wide singleton.

test('tryConsume allows up to RATE_LIMIT requests, then blocks within the window', () => {
  const rl = RateLimiter.getInstance();
  const user = 900001;
  for (let i = 0; i < env.RATE_LIMIT; i++) {
    assert.equal(rl.tryConsume(user), true, `request ${i + 1} should pass`);
  }
  assert.equal(rl.tryConsume(user), false, 'request over the limit should be blocked');
});

test('tryConsume tracks users independently', () => {
  const rl = RateLimiter.getInstance();
  assert.equal(rl.tryConsume(900002), true);
  assert.equal(rl.tryConsume(900003), true);
});

test('stop() clears the eviction timer and is idempotent', () => {
  const rl = RateLimiter.getInstance();
  assert.doesNotThrow(() => rl.stop());
  assert.doesNotThrow(() => rl.stop());
});
