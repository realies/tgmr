import { Context, InputFile } from 'grammy';
import { isSupportedUrl } from '../utils/url.js';
import { MediaDownloader } from '../services/downloader.js';
import type { MediaMetadata } from '../services/downloader.js';
import { probeMediaFile, generateThumbnail, extractStreamInfo } from '../services/mediaProbe.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { buildSingleCaption, buildGroupCaption } from '../utils/caption.js';
import { Semaphore } from '../utils/concurrency.js';
import { ChatActionManager } from '../utils/chatAction.js';
import type { ChatAction } from '../utils/chatAction.js';

const BYTES_PER_MB = 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_CONCURRENT_PROBES = 10;
const MEDIA_INFO_CACHE_TTL = 5 * 60 * 1000;
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);
const probeSemaphore = new Semaphore(MAX_CONCURRENT_PROBES);

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'jpeg2000']);

// Simple TTL cache for media info to avoid re-fetching the same URL
const mediaInfoCache = new Map<string, { data: MediaMetadata; expiry: number }>();

function getCachedMediaInfo(url: string): MediaMetadata | null {
  const cached = mediaInfoCache.get(url);
  if (!cached || Date.now() > cached.expiry) {
    mediaInfoCache.delete(url);
    return null;
  }
  return cached.data;
}

function cacheMediaInfo(url: string, data: MediaMetadata): void {
  mediaInfoCache.set(url, { data, expiry: Date.now() + MEDIA_INFO_CACHE_TTL });
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

// --- Main Handler ---

export async function handleMessage(ctx: Context): Promise<void> {
  const messageText = ctx.message?.text;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const messageId = ctx.message?.message_id;
  const chatType = ctx.chat?.type;
  const isAnonymousAdmin = ctx.from?.username === 'GroupAnonymousBot';

  const logCtx = { type: chatType, chat: chatId, msgId: messageId };
  const userInfo = isAnonymousAdmin
    ? 'Anonymous Admin'
    : username
      ? `@${username}`
      : `user ${userId}`;

  if (!messageText || !chatId || !messageId) {
    logger.warn('Skipping: missing text, chatId, or messageId', logCtx);
    return;
  }

  try {
    const urls = messageText.split(/\s+/).filter(isSupportedUrl);
    if (urls.length === 0) return;

    const rateLimitKey = userId && !isAnonymousAdmin ? userId : chatId;
    if (!RateLimiter.getInstance().tryConsume(rateLimitKey)) {
      logger.info(`Rate limited ${userInfo}`, logCtx);
      await ctx.reply('You are sending requests too quickly. Please try again later.', {
        reply_to_message_id: messageId,
      });
      return;
    }

    const url = urls[0];
    logger.info(`${userInfo} → ${url}`, logCtx);

    await downloadSemaphore.run(() =>
      processMediaRequest(ctx, url, chatId, messageId, logCtx, userInfo),
    );
  } catch (error) {
    logger.error('Failed to process message', { ...logCtx, error });
    await ctx.reply('Failed to process message').catch(() => {});
  }
}

// --- Request Processing ---

async function processMediaRequest(
  ctx: Context,
  url: string,
  chatId: number,
  messageId: number,
  logCtx: Record<string, unknown>,
  userInfo: string,
): Promise<void> {
  const downloader = MediaDownloader.getInstance();
  const actionManager = new ChatActionManager(ctx, chatId);
  let filePaths: string[] = [];
  let mediaItems: MediaItem[] = [];

  try {
    const mediaInfo = await fetchMediaInfo(downloader, url, actionManager, logCtx);
    if (!mediaInfo) {
      await ctx.reply('Failed to get media information after several attempts', {
        reply_to_message_id: messageId,
      });
      return;
    }

    const result = await downloadMedia(downloader, url, mediaInfo, actionManager, logCtx);
    actionManager.stop();

    if (!result.success || result.filePaths.length === 0 || !result.mediaInfo) {
      logger.error('Download failed', { ...logCtx, error: result.error });
      await ctx.reply('Failed to process media. Please try a different URL.', {
        reply_to_message_id: messageId,
      });
      return;
    }

    filePaths = result.filePaths;
    mediaItems = await buildMediaItems(filePaths, logCtx);

    if (mediaItems.length > 1) {
      await sendMediaGroup(ctx, mediaItems, result.mediaInfo, url, messageId);
    } else {
      await sendSingleMedia(ctx, mediaItems[0], result.mediaInfo, url, messageId);
    }

    logger.debug(`Done for ${userInfo}`, logCtx);
  } catch (error) {
    logger.error('Failed to process media request', { ...logCtx, error });
    await ctx
      .reply('Failed to process media request', { reply_to_message_id: messageId })
      .catch(() => {});
  } finally {
    actionManager.stop();
    await cleanupFiles(filePaths, mediaItems, downloader, logCtx);
  }
}

async function fetchMediaInfo(
  downloader: MediaDownloader,
  url: string,
  actionManager: ChatActionManager,
  logCtx: Record<string, unknown>,
): Promise<MediaMetadata | null> {
  // Check cache first
  const cached = getCachedMediaInfo(url);
  if (cached) {
    logger.info(`Media info cache hit`, logCtx);
    return cached;
  }

  await actionManager.start('typing');
  logger.info('Fetching media info...', logCtx);
  try {
    const info = await withRetry(() => downloader.getMediaInfo(url), {
      maxAttempts: 5,
      initialDelay: 2000,
      maxDelay: 15000,
    });
    cacheMediaInfo(url, info);
    return info;
  } catch (error) {
    logger.warn('Failed to get media info', { ...logCtx, error });
    return null;
  }
}

async function downloadMedia(
  downloader: MediaDownloader,
  url: string,
  mediaInfo: MediaMetadata,
  actionManager: ChatActionManager,
  logCtx: Record<string, unknown>,
): ReturnType<MediaDownloader['download']> {
  const action: ChatAction =
    mediaInfo.format === 'audio'
      ? 'upload_voice'
      : mediaInfo.format === 'image'
        ? 'upload_photo'
        : 'upload_video';
  await actionManager.start(action);

  logger.info(`Downloading ${mediaInfo.format}`, logCtx);
  return withRetry(
    () =>
      downloader.download(
        url,
        { maxFileSize: env.MAX_FILE_SIZE, timeout: env.DOWNLOAD_TIMEOUT, format: mediaInfo.format },
        mediaInfo,
      ),
    { maxAttempts: 3, initialDelay: 3000, maxDelay: 20000 },
  );
}

// --- Media Item Building ---

async function buildMediaItems(
  filePaths: string[],
  logCtx: Record<string, unknown>,
): Promise<MediaItem[]> {
  const results = await Promise.allSettled(
    filePaths.map((path) =>
      probeSemaphore.run(async () => {
        assertSafePath(path, env.TMP_DIR);
        const probe = await probeMediaFile(path);

        const isVideo = probe.streams.some(
          (s) => s.codec_type === 'video' && !IMAGE_CODECS.has(s.codec_name),
        );

        let thumbnail: Buffer | null = null;
        if (isVideo) {
          logger.debug('Creating thumbnail', { ...logCtx, path });
          thumbnail = await generateThumbnail(path);
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
      }),
    ),
  );

  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;

  return results.map((r) => (r as PromiseFulfilledResult<MediaItem>).value);
}

// --- Telegram Send ---

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

// --- Cleanup ---

async function cleanupFiles(
  filePaths: string[],
  mediaItems: MediaItem[],
  downloader: MediaDownloader,
  logCtx: Record<string, unknown>,
): Promise<void> {
  const pathsToClean = new Set<string>();

  for (const p of filePaths) {
    pathsToClean.add(p);
  }

  for (const item of mediaItems) {
    pathsToClean.add(item.path);
  }

  await Promise.all(
    Array.from(pathsToClean).map((file) =>
      downloader
        .cleanup(file)
        .catch((error) => logger.warn('Cleanup failed', { ...logCtx, file, error })),
    ),
  );
}
