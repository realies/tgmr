import { Context, InputFile } from 'grammy';
import { readFile, stat, unlink } from 'fs/promises';
import { isValidUrl, isSupportedPlatform } from '../utils/url.js';
import { MediaDownloader } from '../services/downloader.js';
import type { MediaMetadata } from '../services/downloader.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { safeExec } from '../utils/exec.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { escapeMarkdownV2, escapeMarkdownV2Url, normalizeLineBreaks } from '../utils/markdown.js';
import { Semaphore } from '../utils/concurrency.js';

const THUMBNAIL_MAX_BYTES = 200 * 1024;
const BYTES_PER_MB = 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_CONCURRENT_PROBES = 10;
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);
const probeSemaphore = new Semaphore(MAX_CONCURRENT_PROBES);

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'jpeg2000']);

type ChatAction = 'typing' | 'upload_photo' | 'upload_video' | 'upload_voice' | 'upload_document';

interface FFprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  bit_rate?: string;
}

interface FFprobeData {
  streams: FFprobeStream[];
  format?: { size?: string; bit_rate?: string };
}

interface MediaItem {
  path: string;
  isVideo: boolean;
  thumbnail?: Buffer;
  videoWidth?: number;
  videoHeight?: number;
  streamInfo: string;
  fileSizeMB: string;
}

// --- Chat Action Manager ---

class ChatActionManager {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(
    private ctx: Context,
    private chatId: number,
  ) {}

  async start(action: ChatAction): Promise<void> {
    this.stop();
    this.stopped = false;
    try {
      await this.sendAction(action);
    } catch (error) {
      logger.error('Failed to start chat action', { error });
      return;
    }
    this.scheduleNext(action);
  }

  private scheduleNext(action: ChatAction): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      if (this.inFlight || this.stopped) return;
      this.inFlight = true;
      try {
        await this.sendAction(action);
      } catch (error) {
        if (!(error instanceof Error) || !error.message?.includes('Network request')) {
          logger.error('Failed to send chat action', { error });
        }
      } finally {
        this.inFlight = false;
        if (!this.stopped) this.scheduleNext(action);
      }
    }, 1000);
  }

  private async sendAction(action: ChatAction): Promise<void> {
    await withRetry(() => this.ctx.api.sendChatAction(this.chatId, action), {
      maxAttempts: 5,
      initialDelay: 500,
      maxDelay: 5000,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// --- Media Probe Helpers ---

async function probeMediaFile(path: string): Promise<FFprobeData> {
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

async function generateThumbnail(videoPath: string): Promise<Buffer | null> {
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
    return await readFile(thumbnailPath);
  } catch {
    return null;
  }
}

function extractStreamInfo(
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
        if (!isVideo) return `${stream.codec_name} ${stream.width ?? '?'}x${stream.height ?? '?'}`;
        const bitrate = stream.bit_rate
          ? `${Math.round(parseInt(stream.bit_rate, 10) / 1000)}kbps`
          : format?.bit_rate
            ? `${Math.round(parseInt(format.bit_rate, 10) / 1000)}kbps`
            : '';
        return `${stream.codec_name} ${stream.width ?? '?'}x${stream.height ?? '?'}${bitrate ? ` ${bitrate}` : ''}`;
      }
      if (stream.codec_type === 'audio') {
        const bitrate = stream.bit_rate
          ? `${Math.round(parseInt(stream.bit_rate, 10) / 1000)}kbps`
          : format?.bit_rate
            ? `${Math.round(parseInt(format.bit_rate, 10) / 1000)}kbps`
            : '';
        const sampleRate = stream.sample_rate
          ? `${Math.round(parseInt(stream.sample_rate, 10) / 1000)}kHz`
          : '';
        return `${stream.codec_name}${bitrate ? ` ${bitrate}` : ''}${sampleRate ? ` ${sampleRate}` : ''}`;
      }
      return null;
    })
    .filter(Boolean)
    .join(', ');

  return { info: parts, width, height };
}

// --- Caption Builders ---

function buildSingleCaption(title: string, url: string, item: MediaItem): string {
  const escapedTitle = escapeMarkdownV2(normalizeLineBreaks(title));
  const escapedUrl = escapeMarkdownV2Url(url);
  const escapedInfo = escapeMarkdownV2(item.streamInfo);
  const escapedSize = escapeMarkdownV2(item.fileSizeMB);
  return `[${escapedTitle}](${escapedUrl})\n\`${escapedInfo}, ${escapedSize}MB\``;
}

function buildGroupCaption(
  title: string,
  url: string,
  chunk: MediaItem[],
  isFirstChunk: boolean,
): string {
  const imageFormats = new Map<string, { count: number; codec: string; dims: string }>();
  const videoFormats = new Map<string, { count: number; codec: string; dims: string }>();
  let chunkTotalSize = 0;

  for (const item of chunk) {
    const parts = item.streamInfo.split(' ');
    const codec = parts[0] || 'unknown';
    const dims = parts[1] || 'unknown';
    const key = `${codec}-${dims}`;

    if (item.isVideo) {
      const existing = videoFormats.get(key) || { count: 0, codec, dims };
      videoFormats.set(key, { ...existing, count: existing.count + 1 });
    } else {
      const existing = imageFormats.get(key) || { count: 0, codec, dims };
      imageFormats.set(key, { ...existing, count: existing.count + 1 });
    }
    chunkTotalSize += parseFloat(item.fileSizeMB);
  }

  const formatParts: string[] = [];
  if (imageFormats.size > 0) {
    const summary = Array.from(imageFormats.values())
      .map((i) => `${i.count} ${i.codec} image${i.count > 1 ? 's' : ''} at ${i.dims}`)
      .join(', ');
    formatParts.push(summary);
  }
  if (videoFormats.size > 0) {
    const summary = Array.from(videoFormats.values())
      .map((i) => `${i.count} ${i.codec} video${i.count > 1 ? 's' : ''} at ${i.dims}`)
      .join(', ');
    formatParts.push(summary);
  }

  const escapedSummary = escapeMarkdownV2(formatParts.join(', '));
  const escapedSize = escapeMarkdownV2(chunkTotalSize.toFixed(1));
  const sizeLabel = `\`${escapedSummary}, ${escapedSize}MB total\``;

  if (isFirstChunk) {
    const escapedTitle = escapeMarkdownV2(normalizeLineBreaks(title));
    const escapedUrl = escapeMarkdownV2Url(url);
    return `[${escapedTitle}](${escapedUrl})\n${sizeLabel}`;
  }
  return sizeLabel;
}

// --- Cleanup Helper ---

async function cleanupFiles(
  filePaths: string[],
  mediaItems: MediaItem[],
  downloader: MediaDownloader,
  logContext: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  const pathsToClean = new Set<string>();

  // Add raw download paths (covers case where buildMediaItems fails)
  for (const p of filePaths) {
    pathsToClean.add(p);
    pathsToClean.add(`${p}.thumb.jpg`);
  }

  // Add media item paths (may include thumbnails)
  for (const item of mediaItems) {
    pathsToClean.add(item.path);
    if (item.isVideo) pathsToClean.add(`${item.path}.thumb.jpg`);
  }

  await Promise.all(
    Array.from(pathsToClean).map((file) =>
      downloader
        .cleanup(file)
        .catch((error) =>
          logger.warn('Failed to cleanup file', { ...logContext, requestId, file, error }),
        ),
    ),
  );
}

// --- Main Handler ---

export async function handleMessage(ctx: Context): Promise<void> {
  const messageText = ctx.message?.text;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const messageId = ctx.message?.message_id;
  const chatType = ctx.chat?.type;
  const isAnonymousAdmin = ctx.from?.username === 'GroupAnonymousBot';

  const logContext = {
    type: chatType,
    chat: chatId,
    from: isAnonymousAdmin ? 'AnonymousAdmin' : username || userId,
    msgId: messageId,
  };
  const userInfo = isAnonymousAdmin
    ? 'Anonymous Admin'
    : username
      ? `@${username}`
      : `user ${userId}`;
  const requestId = `[${chatId}:${messageId}]`;

  if (!messageText || !chatId || !messageId) {
    logger.warn('Skipping message due to missing text, chatId, or messageId', logContext);
    return;
  }

  try {
    // Extract URLs first — only consume rate limit if there's a supported URL
    const words = messageText.split(/\s+/);
    const urls = words.filter((word) => isValidUrl(word) && isSupportedPlatform(word));
    if (urls.length === 0) return;

    // Rate limit check AFTER URL extraction (non-URL messages don't count)
    if (userId && !isAnonymousAdmin) {
      if (!RateLimiter.getInstance().tryConsume(userId)) {
        logger.info(`Rate limit applied for ${userInfo}`, { ...logContext, requestId });
        await ctx.reply('You are sending requests too quickly. Please try again later.', {
          reply_to_message_id: messageId,
        });
        return;
      }
    }

    const url = urls[0];
    logger.info(`${userInfo} requested: ${url}`, { ...logContext, requestId });

    await downloadSemaphore.run(() =>
      processMediaRequest(ctx, url, chatId, messageId, logContext, requestId, userInfo),
    );
  } catch (error) {
    logger.error('Failed to process message', { error });
    await ctx.reply('Failed to process message').catch(() => {});
  }
}

async function processMediaRequest(
  ctx: Context,
  url: string,
  chatId: number,
  messageId: number,
  logContext: Record<string, unknown>,
  requestId: string,
  userInfo: string,
): Promise<void> {
  const downloader = MediaDownloader.getInstance();
  const actionManager = new ChatActionManager(ctx, chatId);
  let filePaths: string[] = [];
  let mediaItems: MediaItem[] = [];

  try {
    await actionManager.start('typing');

    // Get media info — throws on failure for withRetry to retry
    logger.info('Fetching media info...', { ...logContext, requestId });
    let mediaInfo: MediaMetadata;
    try {
      mediaInfo = await withRetry(() => downloader.getMediaInfo(url), {
        maxAttempts: 5,
        initialDelay: 2000,
        maxDelay: 15000,
      });
    } catch (error) {
      logger.warn('Failed to get media information after retries', {
        ...logContext,
        requestId,
        error,
      });
      await ctx.reply('Failed to get media information after several attempts', {
        reply_to_message_id: messageId,
      });
      return;
    }

    const action: ChatAction =
      mediaInfo.format === 'audio'
        ? 'upload_voice'
        : mediaInfo.format === 'image'
          ? 'upload_photo'
          : 'upload_video';
    await actionManager.start(action);

    // Download media — throws on transient errors for withRetry to retry
    logger.info(`Downloading ${mediaInfo.format} from ${url}`, { ...logContext, requestId });
    const result = await withRetry(
      () =>
        downloader.download(
          url,
          {
            maxFileSize: env.MAX_FILE_SIZE,
            timeout: env.DOWNLOAD_TIMEOUT,
            format: mediaInfo.format,
          },
          mediaInfo,
        ),
      { maxAttempts: 3, initialDelay: 3000, maxDelay: 20000 },
    );

    actionManager.stop();

    if (!result.success || result.filePaths.length === 0 || !result.mediaInfo) {
      logger.error('Failed to process media after retries', {
        ...logContext,
        requestId,
        error: result.error,
      });
      await ctx.reply('Failed to process media. Please try a different URL.', {
        reply_to_message_id: messageId,
      });
      return;
    }

    filePaths = result.filePaths;
    mediaItems = await buildMediaItems(filePaths, logContext, requestId);

    if (mediaItems.length > 1) {
      await sendMediaGroup(ctx, mediaItems, result.mediaInfo, url, messageId);
    } else {
      await sendSingleMedia(ctx, mediaItems[0], result.mediaInfo, url, messageId);
    }

    logger.debug(`Successfully processed media request for ${userInfo}`, {
      ...logContext,
      requestId,
    });
  } catch (error) {
    logger.error('Failed to process media request', { error });
    await ctx
      .reply('Failed to process media request', { reply_to_message_id: messageId })
      .catch(() => {});
  } finally {
    actionManager.stop();
    await cleanupFiles(filePaths, mediaItems, downloader, logContext, requestId);
  }
}

async function buildMediaItems(
  filePaths: string[],
  logContext: Record<string, unknown>,
  requestId: string,
): Promise<MediaItem[]> {
  return Promise.all(
    filePaths.map(async (path) => {
      return probeSemaphore.run(async () => {
        assertSafePath(path, env.TMP_DIR);
        const probe = await probeMediaFile(path);

        // Determine video from probe data, not file extension
        const isVideo = probe.streams.some(
          (s) => s.codec_type === 'video' && !IMAGE_CODECS.has(s.codec_name),
        );

        let thumbnail: Buffer | null = null;
        if (isVideo) {
          logger.debug('Creating thumbnail for video', { ...logContext, requestId, path });
          thumbnail = await generateThumbnail(path);
          if (thumbnail) {
            logger.debug('Thumbnail created successfully', {
              ...logContext,
              requestId,
              size: thumbnail.length,
            });
          }
        }

        const { info, width, height } = extractStreamInfo(probe.streams, isVideo, probe.format);
        const fileSize = probe.format?.size ? parseInt(probe.format.size, 10) : 0;
        const fileSizeMB =
          Number.isFinite(fileSize) && fileSize > 0 ? (fileSize / BYTES_PER_MB).toFixed(1) : '0';

        if (Number.isFinite(fileSize) && fileSize > env.MAX_FILE_SIZE) {
          throw new Error(
            `Media file (${fileSizeMB}MB) exceeds size limit (${env.MAX_FILE_SIZE / BYTES_PER_MB}MB)`,
          );
        }

        return {
          path,
          isVideo,
          thumbnail: thumbnail ?? undefined,
          videoWidth: width,
          videoHeight: height,
          streamInfo: info,
          fileSizeMB,
        };
      });
    }),
  );
}

async function sendMediaGroup(
  ctx: Context,
  mediaItems: MediaItem[],
  mediaInfo: { title: string },
  url: string,
  messageId: number,
): Promise<void> {
  for (let i = 0; i < mediaItems.length; i += MAX_MEDIA_GROUP_SIZE) {
    const chunk = mediaItems.slice(i, i + MAX_MEDIA_GROUP_SIZE);
    const caption = buildGroupCaption(mediaInfo.title, url, chunk, i === 0);

    const mediaGroup = chunk.map((item, index) => {
      const captionOpts = index === 0 ? { caption, parse_mode: 'MarkdownV2' as const } : {};

      if (item.isVideo) {
        return {
          type: 'video' as const,
          media: new InputFile(item.path),
          ...captionOpts,
          ...(item.thumbnail && { thumbnail: new InputFile(item.thumbnail) }),
          ...(item.videoWidth &&
            item.videoHeight && { width: item.videoWidth, height: item.videoHeight }),
        };
      }
      return {
        type: 'photo' as const,
        media: new InputFile(item.path),
        ...captionOpts,
      };
    });

    await ctx.replyWithMediaGroup(mediaGroup, { reply_to_message_id: messageId });
  }
}

async function sendSingleMedia(
  ctx: Context,
  item: MediaItem,
  mediaInfo: { title: string; format: string },
  url: string,
  messageId: number,
): Promise<void> {
  const caption = buildSingleCaption(mediaInfo.title, url, item);
  const baseOpts = { caption, reply_to_message_id: messageId, parse_mode: 'MarkdownV2' as const };

  if (mediaInfo.format === 'audio') {
    await ctx.replyWithVoice(new InputFile(item.path), baseOpts);
  } else if (item.isVideo) {
    await ctx.replyWithVideo(new InputFile(item.path), {
      ...baseOpts,
      ...(item.thumbnail && { thumbnail: new InputFile(item.thumbnail) }),
      ...(item.videoWidth &&
        item.videoHeight && { width: item.videoWidth, height: item.videoHeight }),
    });
  } else {
    await ctx.replyWithPhoto(new InputFile(item.path), baseOpts);
  }
}
