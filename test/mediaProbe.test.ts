import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStreamInfo, type FFprobeStream } from '../src/services/mediaProbe.js';

test('extractStreamInfo summarizes a video stream with dimensions and bitrate', () => {
  const streams: FFprobeStream[] = [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, bit_rate: '2500000' },
  ];
  const r = extractStreamInfo(streams, true);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.ok(r.info.includes('h264 1920x1080'));
  assert.ok(r.info.includes('2500kbps'));
});

test('extractStreamInfo omits bitrate for still images (isVideo=false)', () => {
  const streams: FFprobeStream[] = [
    { codec_type: 'video', codec_name: 'mjpeg', width: 800, height: 600, bit_rate: '999999' },
  ];
  const r = extractStreamInfo(streams, false);
  assert.equal(r.info, 'mjpeg 800x600');
});

test('extractStreamInfo describes audio with bitrate and sample rate', () => {
  const streams: FFprobeStream[] = [
    { codec_type: 'audio', codec_name: 'opus', bit_rate: '128000', sample_rate: '48000' },
  ];
  const r = extractStreamInfo(streams, false);
  assert.equal(r.info, 'opus 128kbps 48kHz');
  assert.equal(r.width, undefined);
});

test('extractStreamInfo falls back to ? for missing dimensions and uses format bitrate', () => {
  const streams: FFprobeStream[] = [{ codec_type: 'video', codec_name: 'h264' }];
  const r = extractStreamInfo(streams, true, { bit_rate: '1000000' });
  assert.ok(r.info.includes('h264 ?x?'));
  assert.ok(r.info.includes('1000kbps'));
});
