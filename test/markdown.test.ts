import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeMarkdownV2, escapeMarkdownV2Url, normalizeLineBreaks } from '../src/utils/markdown.js';

test('escapeMarkdownV2 prefixes every MarkdownV2 special char with a backslash', () => {
  const special = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\'];
  for (const ch of special) {
    assert.equal(escapeMarkdownV2(ch), '\\' + ch, `char ${JSON.stringify(ch)}`);
  }
  assert.equal(escapeMarkdownV2('plain text'), 'plain text');
  assert.equal(escapeMarkdownV2('a.b_c'), 'a\\.b\\_c');
});

test('escapeMarkdownV2Url escapes only ) and backslash', () => {
  assert.equal(escapeMarkdownV2Url(')'), '\\)');
  assert.equal(escapeMarkdownV2Url('\\'), '\\\\');
  assert.equal(escapeMarkdownV2Url('('), '('); // ( is not escaped inside a link URL
  assert.equal(escapeMarkdownV2Url('https://ex.com/a.b_c-d'), 'https://ex.com/a.b_c-d');
});

test('normalizeLineBreaks normalizes CRLF, blank lines and 3+ newlines', () => {
  assert.equal(normalizeLineBreaks('a\r\nb'), 'a\nb');
  assert.equal(normalizeLineBreaks('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeLineBreaks('  \n a \n  '), 'a');
  assert.equal(normalizeLineBreaks('a\n\nb'), 'a\n\nb'); // legitimate paragraph break preserved
});
