import { readFile, stat, unlink } from 'fs/promises';
import { safeExec } from '../utils/exec.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { env } from '../config/env.js';

const THUMBNAIL_MAX_BYTES = 200 * 1024;

export interface FFprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  bit_rate?: string;
}

export interface FFprobeData {
  streams: FFprobeStream[];
  format?: { size?: string; bit_rate?: string };
}

export async function probeMediaFile(path: string): Promise<FFprobeData> {
  const { stdout } = await safeExec('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  try {
    return JSON.parse(stdout) as FFprobeData;
  } catch {
    throw new Error(`Failed to parse ffprobe output for ${path}`);
  }
}

export async function generateThumbnail(videoPath: string): Promise<Buffer | null> {
  const thumbnailPath = `${videoPath}.thumb.jpg`;
  assertSafePath(thumbnailPath, env.TMP_DIR);
  try {
    await safeExec('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-vf',
      "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease",
      '-q:v',
      '6',
      '-frames:v',
      '1',
      thumbnailPath,
    ]);
    const stats = await stat(thumbnailPath);
    if (stats.size === 0 || stats.size > THUMBNAIL_MAX_BYTES) {
      await unlink(thumbnailPath).catch(() => {});
      return null;
    }
    const data = await readFile(thumbnailPath);
    await unlink(thumbnailPath).catch(() => {});
    return data;
  } catch {
    await unlink(thumbnailPath).catch(() => {});
    return null;
  }
}

function parseBitrate(raw: string | undefined): string {
  if (!raw) return '';
  const val = parseInt(raw, 10);
  if (!Number.isFinite(val) || val <= 0) return '';
  return `${Math.round(val / 1000)}kbps`;
}

function parseSampleRate(raw: string | undefined): string {
  if (!raw) return '';
  const val = parseInt(raw, 10);
  if (!Number.isFinite(val) || val <= 0) return '';
  return `${Math.round(val / 1000)}kHz`;
}

export function extractStreamInfo(
  streams: FFprobeStream[],
  isVideo: boolean,
  format?: FFprobeData['format'],
): { info: string; width?: number; height?: number } {
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const width = videoStream?.width;
  const height = videoStream?.height;

  const parts = streams
    .map((stream) => {
      if (stream.codec_type === 'video') {
        const dims = `${stream.width ?? '?'}x${stream.height ?? '?'}`;
        if (!isVideo) return `${stream.codec_name} ${dims}`;
        const bitrate = parseBitrate(stream.bit_rate) || parseBitrate(format?.bit_rate);
        return `${stream.codec_name} ${dims}${bitrate ? ` ${bitrate}` : ''}`;
      }
      if (stream.codec_type === 'audio') {
        // No format-level bitrate fallback for audio — it would duplicate the container bitrate
        const bitrate = parseBitrate(stream.bit_rate);
        const sampleRate = parseSampleRate(stream.sample_rate);
        return `${stream.codec_name}${bitrate ? ` ${bitrate}` : ''}${sampleRate ? ` ${sampleRate}` : ''}`;
      }
      return null;
    })
    .filter(Boolean)
    .join(', ');

  return { info: parts, width, height };
}
