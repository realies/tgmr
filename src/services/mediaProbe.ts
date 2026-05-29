import { rename, unlink, stat } from 'node:fs/promises';
import { safeExec } from '../utils/exec.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { env } from '../config/env.js';

// Telegram video thumbnails must be JPEG, ≤320px per side, and <200KB.
const TELEGRAM_THUMB_MAX_DIM = 320;
const TELEGRAM_THUMB_MAX_BYTES = 200 * 1024;

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
  assertSafePath(path, env.TMP_DIR);
  const { stdout } = await safeExec(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeout: 10 },
  );
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { streams?: unknown }).streams)
    ) {
      throw new Error('ffprobe output missing a streams array');
    }
    return parsed as FFprobeData;
  } catch {
    throw new Error(`Failed to parse ffprobe output for ${path}`);
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

/**
 * Downscales a thumbnail in place to fit Telegram's ≤320px/<200KB JPEG limit
 * (yt-dlp's --convert-thumbnails makes it JPEG but does not constrain size, and
 * an oversized thumbnail can make the whole video send fail). Returns false —
 * caller should omit the thumbnail and let Telegram auto-generate — if it fails.
 */
export async function scaleThumbnail(path: string): Promise<boolean> {
  assertSafePath(path, env.TMP_DIR);
  const scaled = `${path}.scaled.jpg`;
  assertSafePath(scaled, env.TMP_DIR);
  try {
    await safeExec(
      'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-i',
        path,
        '-vf',
        `scale='min(${TELEGRAM_THUMB_MAX_DIM},iw)':'min(${TELEGRAM_THUMB_MAX_DIM},ih)':force_original_aspect_ratio=decrease`,
        '-frames:v',
        '1',
        scaled,
      ],
      { timeout: 15 },
    );
    // ≤320px JPEG is normally well under 200KB, but verify so a dense thumbnail
    // can't still exceed Telegram's limit and fail the video send.
    const { size } = await stat(scaled);
    if (size > TELEGRAM_THUMB_MAX_BYTES) {
      await unlink(scaled).catch(() => {});
      return false;
    }
    await rename(scaled, path);
    return true;
  } catch {
    await unlink(scaled).catch(() => {});
    return false;
  }
}
