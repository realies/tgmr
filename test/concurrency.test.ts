import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/utils/concurrency.js';

test('Semaphore caps concurrency and runs every task', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const task = async (): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return 'done';
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => sem.run(task)));
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r === 'done'));
  assert.equal(maxActive, 2, `maxActive=${maxActive}`);
});

test('Semaphore rejects non-integer and non-positive sizes', () => {
  assert.throws(() => new Semaphore(0), RangeError);
  assert.throws(() => new Semaphore(-1), RangeError);
  assert.throws(() => new Semaphore(2.5), RangeError);
  assert.throws(() => new Semaphore(Number.NaN), RangeError);
  assert.doesNotThrow(() => new Semaphore(1));
});

test('Semaphore propagates task errors and still releases the slot', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    () => sem.run(async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(await sem.run(async () => 'ok'), 'ok');
});
