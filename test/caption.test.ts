import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSingleCaption, buildGroupCaption, type CaptionMediaItem } from '../src/utils/caption.js';

const TELEGRAM_CAPTION_MAX = 1024;
const videoItem: CaptionMediaItem = { isVideo: true, streamInfo: 'h264 1920x1080', fileSizeMB: '12.3' };

test('buildSingleCaption fits within the cap and links the URL for normal input', () => {
  const cap = buildSingleCaption('A nice video', 'https://youtube.com/watch?v=abc', videoItem);
  assert.ok(cap.length <= TELEGRAM_CAPTION_MAX);
  assert.ok(cap.includes('watch?v=abc'));
});

test('buildSingleCaption stays within the cap for very long titles', () => {
  const cap = buildSingleCaption('x'.repeat(5000), 'https://youtube.com/watch?v=abc', videoItem);
  assert.ok(cap.length <= TELEGRAM_CAPTION_MAX, `len=${cap.length}`);
});

test('buildSingleCaption stays within the cap for pathologically long URLs', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(2000);
  const cap = buildSingleCaption('title', longUrl, videoItem);
  assert.ok(cap.length <= TELEGRAM_CAPTION_MAX, `len=${cap.length}`);
});

test('buildGroupCaption stays within the cap for first and subsequent chunks', () => {
  const chunk: CaptionMediaItem[] = [
    { isVideo: false, streamInfo: 'jpeg 800x600', fileSizeMB: '1.0' },
    { isVideo: true, streamInfo: 'h264 1920x1080', fileSizeMB: '5.0' },
  ];
  const first = buildGroupCaption('x'.repeat(5000), 'https://youtube.com/watch?v=abc', chunk, true);
  assert.ok(first.length <= TELEGRAM_CAPTION_MAX, `len=${first.length}`);
  const rest = buildGroupCaption('t', 'https://youtube.com/watch?v=abc', chunk, false);
  assert.ok(rest.length <= TELEGRAM_CAPTION_MAX);
});

test('buildGroupCaption summarizes image/video counts and total size', () => {
  const chunk: CaptionMediaItem[] = [
    { isVideo: false, streamInfo: 'jpeg 800x600', fileSizeMB: '1.0' },
    { isVideo: false, streamInfo: 'jpeg 800x600', fileSizeMB: '2.0' },
    { isVideo: true, streamInfo: 'h264 1920x1080', fileSizeMB: '5.0' },
  ];
  const cap = buildGroupCaption('title', 'https://youtube.com/watch?v=abc', chunk, true);
  assert.ok(cap.includes('2 jpeg images'), cap);
  assert.ok(cap.includes('1 h264 video'), cap);
  assert.ok(cap.includes('MB total'), cap);
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('buildSingleCaption never emits a lone surrogate from a long emoji title', () => {
  const cap = buildSingleCaption('😀'.repeat(2000), 'https://youtube.com/watch?v=abc', videoItem);
  assert.ok(cap.length <= TELEGRAM_CAPTION_MAX, `len=${cap.length}`);
  assert.ok(!LONE_SURROGATE.test(cap), 'caption must be well-formed UTF-16 (no split surrogate pair)');
});

test('buildSingleCaption flattens newlines so the MarkdownV2 link label is single-line', () => {
  const cap = buildSingleCaption(
    'line one\nline two\n\n\nline three',
    'https://youtube.com/watch?v=abc',
    videoItem,
  );
  const linkSep = cap.indexOf('](');
  assert.notEqual(linkSep, -1, `expected a markdown link delimiter in: ${cap}`);
  const label = cap.slice(0, linkSep);
  assert.ok(!label.includes('\n'), `link label must not contain a newline: ${JSON.stringify(label)}`);
});
