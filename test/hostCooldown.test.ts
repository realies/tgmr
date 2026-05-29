import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimitError,
  applyRateLimitFromError,
  getCooldownRemainingMs,
  computeCooldownTarget,
} from '../src/utils/hostCooldown.js';

test('isRateLimitError detects known 429 signals', () => {
  assert.ok(isRateLimitError(new Error('HTTP Error 429: Too Many Requests')));
  assert.ok(isRateLimitError('Waiting until 23:59:59'));
  assert.ok(isRateLimitError(new Error('got 429 back')));
  assert.ok(!isRateLimitError(new Error('connection refused')));
});

test('applyRateLimitFromError sets a bounded, positive cooldown', () => {
  const host = 'cooldown-test-default.example';
  const secs = applyRateLimitFromError(host, 'some 429 with no timestamp');
  assert.ok(secs > 0 && secs <= 30 * 60, `secs=${secs}`);
  assert.ok(getCooldownRemainingMs(host) > 0);
});

test('getCooldownRemainingMs returns 0 for an unknown host', () => {
  assert.equal(getCooldownRemainingMs('never-seen.example'), 0);
});

test('computeCooldownTarget caps a far-future wait at 30 minutes (deterministic clock)', () => {
  // From 00:00:00 UTC, "Waiting until 23:59:59" is ~24h away → capped to 30 min.
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(computeCooldownTarget('Waiting until 23:59:59', now) - now, 30 * 60 * 1000);
});

test('computeCooldownTarget falls back to the default cooldown without a timestamp', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(computeCooldownTarget('HTTP Error 429: Too Many Requests', now) - now, 90 * 1000);
});
