import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/utils/urlNormalize.js';

test('normalizeUrl canonicalizes youtu.be and youtube watch URLs', () => {
  assert.equal(normalizeUrl('https://youtu.be/abc123'), 'youtube.com/watch?v=abc123');
  assert.equal(normalizeUrl('https://www.youtube.com/watch?v=XYZ&t=10s'), 'youtube.com/watch?v=XYZ');
});

test('normalizeUrl maps x.com to twitter.com and strips www, trailing slash and query', () => {
  assert.equal(normalizeUrl('https://x.com/user/status/1'), 'twitter.com/user/status/1');
  assert.equal(normalizeUrl('https://www.instagram.com/p/ABC/'), 'instagram.com/p/ABC');
  assert.equal(normalizeUrl('https://instagram.com/p/ABC?igsh=xyz'), 'instagram.com/p/ABC');
});

test('normalizeUrl returns the raw string for unparseable input', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('normalizeUrl does not collide distinct YouTube videos', () => {
  assert.notEqual(
    normalizeUrl('https://youtube.com/watch?v=AAA'),
    normalizeUrl('https://youtube.com/watch?v=BBB'),
  );
});

test('normalizeUrl keeps content-identifying query params so distinct content does not collide', () => {
  assert.equal(normalizeUrl('https://www.facebook.com/watch/?v=123'), 'facebook.com/watch?v=123');
  assert.notEqual(
    normalizeUrl('https://www.facebook.com/watch/?v=1'),
    normalizeUrl('https://www.facebook.com/watch/?v=2'),
  );
});

test('normalizeUrl strips tracking params and sorts the rest for a stable key', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?b=2&a=1&utm_source=x&fbclid=y'),
    'example.com/p?a=1&b=2',
  );
  assert.equal(
    normalizeUrl('https://example.com/p?a=1&b=2'),
    normalizeUrl('https://example.com/p?b=2&a=1'),
  );
});
