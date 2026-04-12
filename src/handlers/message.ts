import { Context, InputFile } from 'grammy';
import { isValidUrl, isSupportedPlatform } from '../utils/url.js';
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
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);
const probeSemaphore = new Semaphore(MAX_CONCURRENT_PROBES);

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'jpeg2000']);

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

    // Process only the first URL per message
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

// --- Request Processing ---

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
    const mediaInfo = await fetchMediaInfo(downloader, url, actionManager, logContext, requestId);
    if (!mediaInfo) {
      await ctx.reply('Failed to get media information after several attempts', {
        reply_to_message_id: messageId,
      });
      return;
    }

    const result = await downloadMedia(
      downloader,
      url,
      mediaInfo,
      actionManager,
      logContext,
      requestId,
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

async function fetchMediaInfo(
  downloader: MediaDownloader,
  url: string,
  actionManager: ChatActionManager,
  logContext: Record<string, unknown>,
  requestId: string,
): Promise<MediaMetadata | null> {
  await actionManager.start('typing');
  logger.info('Fetching media info...', { ...logContext, requestId });
  try {
    return await withRetry(() => downloader.getMediaInfo(url), {
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
    return null;
  }
}

async function downloadMedia(
  downloader: MediaDownloader,
  url: string,
  mediaInfo: MediaMetadata,
  actionManager: ChatActionManager,
  logContext: Record<string, unknown>,
  requestId: string,
): ReturnType<MediaDownloader['download']> {
  const action: ChatAction =
    mediaInfo.format === 'audio'
      ? 'upload_voice'
      : mediaInfo.format === 'image'
        ? 'upload_photo'
        : 'upload_video';
  await actionManager.start(action);

  logger.info(`Downloading ${mediaInfo.format} from ${url}`, { ...logContext, requestId });
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
  logContext: Record<string, unknown>,
  requestId: string,
): Promise<MediaItem[]> {
  return Promise.all(
    filePaths.map((path) =>
      probeSemaphore.run(async () => {
        assertSafePath(path, env.TMP_DIR);
        const probe = await probeMediaFile(path);

        const isVideo = probe.streams.some(
          (s) => s.codec_type === 'video' && !IMAGE_CODECS.has(s.codec_name),
        );

        let thumbnail: Buffer | null = null;
        if (isVideo) {
          logger.debug('Creating thumbnail for video', { ...logContext, requestId, path });
          thumbnail = await generateThumbnail(path);
          if (thumbnail) {
            logger.debug('Thumbnail created', { ...logContext, requestId, size: thumbnail.length });
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
      }),
    ),
  );
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
  logContext: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  const pathsToClean = new Set<string>();

  // Raw download paths (covers case where buildMediaItems fails before producing items)
  for (const p of filePaths) {
    pathsToClean.add(p);
  }

  // Media item paths + video thumbnails
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
