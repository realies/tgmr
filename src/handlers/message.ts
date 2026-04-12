import { Context, InputFile } from 'grammy';
import { readFile, stat } from 'fs/promises';
import { isValidUrl, isSupportedPlatform } from '../utils/url.js';
import { MediaDownloader } from '../services/downloader.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { safeExec } from '../utils/exec.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { escapeMarkdownV2, normalizeLineBreaks } from '../utils/markdown.js';
import { Semaphore } from '../utils/concurrency.js';

const THUMBNAIL_MAX_BYTES = 200 * 1024;
const BYTES_PER_MB = 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_CONCURRENT_DOWNLOADS = 5;
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);

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

  constructor(
    private ctx: Context,
    private chatId: number,
  ) {}

  async start(action: ChatAction): Promise<void> {
    this.stop();
    try {
      await this.sendAction(action);
    } catch (error) {
      logger.error('Failed to start chat action', { error });
      return;
    }
    this.scheduleNext(action);
  }

  private scheduleNext(action: ChatAction): void {
    this.timer = setTimeout(async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      try {
        await this.sendAction(action);
      } catch (error) {
        if (!(error instanceof Error) || !error.message?.includes('Network request')) {
          logger.error('Failed to send chat action', { error });
        }
      } finally {
        this.inFlight = false;
        if (this.timer !== null) this.scheduleNext(action);
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
    if (stats.size === 0 || stats.size > THUMBNAIL_MAX_BYTES) return null;
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
        if (!isVideo) return `${stream.codec_name} ${stream.width}x${stream.height}`;
        const bitrate = stream.bit_rate
          ? `${Math.round(parseInt(stream.bit_rate) / 1000)}kbps`
          : format?.bit_rate
            ? `${Math.round(parseInt(format.bit_rate) / 1000)}kbps`
            : '';
        return `${stream.codec_name} ${stream.width}x${stream.height}${bitrate ? ` ${bitrate}` : ''}`;
      }
      if (stream.codec_type === 'audio') {
        const bitrate = stream.bit_rate
          ? `${Math.round(parseInt(stream.bit_rate) / 1000)}kbps`
          : format?.bit_rate
            ? `${Math.round(parseInt(format.bit_rate) / 1000)}kbps`
            : '';
        const sampleRate = stream.sample_rate
          ? `${Math.round(parseInt(stream.sample_rate) / 1000)}kHz`
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
  const escapedUrl = escapeMarkdownV2(url);
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
  const imageFormats = new Map<string, { count: number; dimensions: string }>();
  const videoFormats = new Map<string, { count: number; dimensions: string; codec: string }>();
  let chunkTotalSize = 0;

  for (const item of chunk) {
    if (item.isVideo) {
      const [codec, dimensions] = item.streamInfo.split(' ');
      const existing = videoFormats.get(dimensions) || { count: 0, dimensions, codec };
      videoFormats.set(dimensions, { ...existing, count: existing.count + 1 });
    } else {
      const dimensions = item.streamInfo;
      const existing = imageFormats.get(dimensions) || { count: 0, dimensions };
      imageFormats.set(dimensions, { ...existing, count: existing.count + 1 });
    }
    chunkTotalSize += parseFloat(item.fileSizeMB);
  }

  const formatParts: string[] = [];
  if (imageFormats.size > 0) {
    const summary = Array.from(imageFormats.values())
      .map((info) => {
        const [codec, dims] = info.dimensions.split(' ');
        return `${info.count} ${codec} image${info.count > 1 ? 's' : ''} at ${dims}`;
      })
      .join(', ');
    formatParts.push(summary);
  }
  if (videoFormats.size > 0) {
    const summary = Array.from(videoFormats.values())
      .map(
        (info) =>
          `${info.count} ${info.codec} video${info.count > 1 ? 's' : ''} at ${info.dimensions}`,
      )
      .join(', ');
    formatParts.push(summary);
  }

  const escapedSummary = escapeMarkdownV2(formatParts.join(', '));
  const escapedSize = escapeMarkdownV2(chunkTotalSize.toFixed(1));
  const sizeLabel = `\`${escapedSummary}, ${escapedSize}MB total\``;

  if (isFirstChunk) {
    const escapedTitle = escapeMarkdownV2(normalizeLineBreaks(title));
    const escapedUrl = escapeMarkdownV2(url);
    return `[${escapedTitle}](${escapedUrl})\n${sizeLabel}`;
  }
  return sizeLabel;
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

  if (!messageText || !chatId) {
    logger.warn('Skipping message due to missing text or chatId', logContext);
    return;
  }

  if (userId && !isAnonymousAdmin) {
    if (!RateLimiter.getInstance().tryConsume(userId)) {
      logger.info(`Rate limit applied for ${userInfo}`, { ...logContext, requestId });
      await ctx.reply('You are sending requests too quickly. Please try again later.', {
        reply_to_message_id: messageId,
      });
      return;
    }
  }

  try {
    const words = messageText.split(/\s+/);
    const urls = words.filter((word) => isValidUrl(word) && isSupportedPlatform(word));
    if (urls.length === 0) return;

    const url = urls[0];
    logger.info(`${userInfo} requested: ${url}`, { ...logContext, requestId });

    await downloadSemaphore.run(() =>
      processMediaRequest(ctx, url, chatId, messageId!, logContext, requestId, userInfo),
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

  try {
    await actionManager.start('typing');

    logger.info('Fetching media info...', { ...logContext, requestId });
    const mediaInfo = await withRetry(() => downloader.getMediaInfo(url), {
      maxAttempts: 5,
      initialDelay: 2000,
      maxDelay: 15000,
    });

    if (!mediaInfo) {
      logger.warn('Failed to get media information after retries', { ...logContext, requestId });
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

    const mediaItems = await buildMediaItems(result.filePaths, logContext, requestId);

    if (mediaItems.length > 1) {
      await sendMediaGroup(ctx, mediaItems, result.mediaInfo, url, messageId);
    } else {
      await sendSingleMedia(ctx, mediaItems[0], result.mediaInfo, url, messageId);
    }

    await Promise.all(
      mediaItems.map(async (item) => {
        const files = [item.path];
        if (item.isVideo) files.push(`${item.path}.thumb.jpg`);
        await Promise.all(
          files.map((file) =>
            downloader
              .cleanup(file)
              .catch((error) =>
                logger.warn('Failed to cleanup file', { ...logContext, requestId, file, error }),
              ),
          ),
        );
      }),
    );

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
  }
}

async function buildMediaItems(
  filePaths: string[],
  logContext: Record<string, unknown>,
  requestId: string,
): Promise<MediaItem[]> {
  return Promise.all(
    filePaths.map(async (path) => {
      assertSafePath(path, env.TMP_DIR);
      const probe = await probeMediaFile(path);
      const isVideo = path.endsWith('.mp4');

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
      const fileSize = probe.format?.size ? parseInt(probe.format.size) : 0;
      const fileSizeMB = fileSize ? (fileSize / BYTES_PER_MB).toFixed(1) : '0';

      if (fileSize > env.MAX_FILE_SIZE) {
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
