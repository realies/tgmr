import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeExec } from '../src/utils/exec.js';

test('safeExec runs a command and captures stdout (no shell)', async () => {
  const { stdout } = await safeExec(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(stdout, 'ok');
});

test('safeExec rejects invalid timeout and maxBuffer', async () => {
  await assert.rejects(() => safeExec('true', [], { timeout: 0 }), RangeError);
  await assert.rejects(() => safeExec('true', [], { timeout: -5 }), RangeError);
  await assert.rejects(() => safeExec('true', [], { maxBuffer: 0 }), RangeError);
  await assert.rejects(() => safeExec('true', [], { timeout: Number.NaN }), RangeError);
});
