import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/services/versionCheck.js';

test('compareVersions compares numerically component-by-component', () => {
  // yt-dlp CalVer: component 1 (04 vs 3) decides → 4 > 3
  assert.ok(compareVersions('2026.04.10.235301', '2026.3.17') > 0);
  assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions ignores trailing non-numeric/dev segments and missing components', () => {
  assert.equal(compareVersions('1.2.3.dev0', '1.2.3'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.1', '1.2') > 0);
});
