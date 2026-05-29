import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertSafePath } from '../src/utils/pathSafety.js';

test('assertSafePath returns the resolved path for files strictly inside base', () => {
  const base = resolve('/tmp/tgmr-base');
  assert.equal(
    assertSafePath('/tmp/tgmr-base/sub/file.mp4', base),
    resolve('/tmp/tgmr-base/sub/file.mp4'),
  );
});

test('assertSafePath rejects the base itself, traversal, and outside paths', () => {
  const base = '/tmp/tgmr-base';
  assert.throws(() => assertSafePath('/tmp/tgmr-base', base), /Path traversal/);
  assert.throws(() => assertSafePath('/tmp/tgmr-base/../etc/passwd', base), /Path traversal/);
  assert.throws(() => assertSafePath('/etc/passwd', base), /Path traversal/);
});
