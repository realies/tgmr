import { Context, InputFile } from 'grammy';
import { access, stat } from 'fs/promises';
import { isSupportedUrl } from '../utils/url.js';
import { MediaDownloader } from '../services/downloader.js';
import type { MediaMetadata } from '../services/downloader.js';
import { probeMediaFile, extractStreamInfo, scaleThumbnail } from '../services/mediaProbe.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { buildSingleCaption, buildGroupCaption } from '../utils/caption.js';
import { Semaphore } from '../utils/concurrency.js';
import { ChatActionManager } from '../utils/chatAction.js';
import type { ChatAction } from '../utils/chatAction.js';
import { normalizeUrl } from '../utils/urlNormalize.js';
import { withTelegramFlood } from '../utils/telegramFlood.js';
import { getCooldownRemainingMs } from '../utils/hostCooldown.js';

const BYTES_PER_MB = 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_CONCURRENT_PROBES = 10;
const DOWNLOAD_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
// Byte cap on the on-disk cache so a busy chat can't fill the tmpfs across the
// 7-day TTL (entry count is meaningless when one album can be ~500MB). On
// overflow the oldest entries that aren't mid-send are evicted to make room.
const CACHE_MAX_BYTES = 512 * 1024 * 1024;
// Aggregate cap across all files in a single album (post-probe check).
// Individual per-file limit is env.MAX_FILE_SIZE; this bounds huge galleries.
const MAX_ALBUM_BYTES = 500 * 1024 * 1024;
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);
const probeSemaphore = new Semaphore(MAX_CONCURRENT_PROBES);

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'jpeg2000']);

// --- Download Cache ---

interface MediaItem {
  path: string;
  isVideo: boolean;
  thumbnailPath?: string;
  videoWidth?: number;
  videoHeight?: number;
  streamInfo: string;
  fileSizeBytes: number;
  fileSizeMB: string;
}

interface CachedDownload {
  mediaInfo: MediaMetadata;
  mediaItems: MediaItem[];
  expiry: number;
}

const downloadCache = new Map<string, CachedDownload>();

// Keys whose files are currently being uploaded. The cache-evict timer must
// not delete files mid-send, so it skips any key with a live send. Refcounted
// because concurrent duplicate requests can send the same cached entry.
const inUseKeys = new Map<string, number>();
function markInUse(key: string): void {
  inUseKeys.set(key, (inUseKeys.get(key) ?? 0) + 1);
}
function unmarkInUse(key: string): void {
  const next = (inUseKeys.get(key) ?? 1) - 1;
  if (next <= 0) {
    inUseKeys.delete(key);
    // A finished send may have been the only thing pinning the cache over
    // budget (trimCacheToBudget can't evict in-use entries) — reclaim now.
    trimCacheToBudget(MediaDownloader.getInstance());
  } else {
    inUseKeys.set(key, next);
  }
}

function entryBytes(entry: CachedDownload): number {
  return entry.mediaItems.reduce((sum, item) => sum + item.fileSizeBytes, 0);
}

// Evict the oldest non-in-use entries (Map preserves insertion order), cleaning
// their files, until the live cache fits within `budget`. In-use entries can't
// be evicted, so this is re-run when a send finishes (see unmarkInUse) to keep
// the cap effectively hard rather than only enforced at insert time.
function trimCacheToBudget(downloader: MediaDownloader, budget: number = CACHE_MAX_BYTES): void {
  let total = 0;
  for (const entry of downloadCache.values()) total += entryBytes(entry);
  if (total <= budget) return;
  for (const [key, entry] of downloadCache) {
    if (total <= budget) break;
    if (inUseKeys.has(key)) continue;
    downloadCache.delete(key);
    total -= entryBytes(entry);
    for (const item of entry.mediaItems) {
      downloader.cleanup(item.path).catch(() => {});
      if (item.thumbnailPath) downloader.cleanup(item.thumbnailPath).catch(() => {});
    }
  }
}

const cacheEvictTimer = setInterval(
  () => {
    const now = Date.now();
    const downloader = MediaDownloader.getInstance();
    for (const [key, entry] of downloadCache) {
      if (now > entry.expiry && !inUseKeys.has(key)) {
        downloadCache.delete(key);
        for (const item of entry.mediaItems) {
          downloader
            .cleanup(item.path)
            .catch((error) =>
              logger.warn('Cache evict cleanup failed', { path: item.path, error }),
            );
          if (item.thumbnailPath) {
            downloader.cleanup(item.thumbnailPath).catch((error) =>
              logger.warn('Cache evict thumb cleanup failed', {
                path: item.thumbnailPath,
                error,
              }),
            );
          }
        }
      }
    }
  },
  5 * 60 * 1000,
);
cacheEvictTimer.unref();

export function stopCacheEvict(): void {
  clearInterval(cacheEvictTimer);
}

async function filesExist(items: MediaItem[]): Promise<boolean> {
  const checks = await Promise.all(
    items.flatMap((item) =>
      [item.path, item.thumbnailPath]
        .filter((p): p is string => typeof p === 'string')
        .map((p) =>
          access(p)
            .then(() => true)
            .catch(() => false),
        ),
    ),
  );
  return checks.every(Boolean);
}

async function getCachedDownload(url: string): Promise<CachedDownload | null> {
  const key = normalizeUrl(url);
  const cached = downloadCache.get(key);
  if (!cached || Date.now() > cached.expiry) {
    if (cached) downloadCache.delete(key);
    return null;
  }
  if (await filesExist(cached.mediaItems)) {
    return cached;
  }
  downloadCache.delete(key);
  return null;
}

// Tracks downloads currently in progress so concurrent duplicate-URL requests
// share the single download instead of both writing to the same filename.
// Resolves to null on download failure; callers handle that themselves.
const inFlightDownloads = new Map<string, Promise<CachedDownload | null>>();

// Snapshot of files owned by live cache entries — the periodic cleanup sweep
// skips these so it only reaps true orphans, decoupling it from the cache's own
// TTL/eviction lifecycle (and from download-tool mtime behaviour).
export function getCachedFilePaths(): Set<string> {
  const paths = new Set<string>();
  for (const entry of downloadCache.values()) {
    for (const item of entry.mediaItems) {
      paths.add(item.path);
      if (item.thumbnailPath) paths.add(item.thumbnailPath);
    }
  }
  return paths;
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
    const trimmed = messageText.trim();
    // Treat a trailing standalone "+info" token as the info flag — but only as
    // its own whitespace-delimited token, so a URL that legitimately ends in
    // "+info" (e.g. .../tag/best+info) isn't corrupted by stripping it.
    const tokens = trimmed.split(/\s+/);
    const showInfo = tokens.length > 1 && tokens[tokens.length - 1] === '+info';
    const textForParsing = showInfo ? tokens.slice(0, -1).join(' ') : trimmed;

    const url = textForParsing.split(/\s+/).find(isSupportedUrl);
    if (!url) return;

    const rateLimitKey = userId && !isAnonymousAdmin ? userId : chatId;
    if (!RateLimiter.getInstance().tryConsume(rateLimitKey)) {
      logger.info(`Rate limited ${userInfo}`, logCtx);
      await ctx.reply('You are sending requests too quickly. Please try again later.', {
        reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      });
      return;
    }

    // Strip query string from the INFO-level log — query params can carry
    // auth tokens or session ids on some platforms. Full URL still in debug.
    let loggedUrl = url;
    try {
      const u = new URL(url);
      loggedUrl = `${u.origin}${u.pathname}`;
    } catch {
      // keep raw url
    }
    logger.info(`${userInfo} → ${loggedUrl}${showInfo ? ' +info' : ''}`, logCtx);

    // Short-circuit if the host is currently in 429-cooldown. Avoids burning
    // a download slot on a request guaranteed to fail and keeps the user
    // informed with an accurate retry hint.
    let cooldownHost: string | null = null;
    try {
      cooldownHost = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // unparseable — let the pipeline handle it
    }
    if (cooldownHost) {
      const remainingMs = getCooldownRemainingMs(cooldownHost);
      if (remainingMs > 0) {
        const seconds = Math.ceil(remainingMs / 1000);
        logger.info(`Cooldown active for ${cooldownHost} (${seconds}s remaining)`, logCtx);
        await ctx
          .reply(
            `${cooldownHost} is rate-limiting downloads. Please try again in about ${seconds} seconds.`,
            { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } },
          )
          .catch(() => {});
        return;
      }
    }

    await processMediaRequest(ctx, url, chatId, messageId, logCtx, showInfo);
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
  showInfo: boolean,
): Promise<void> {
  // Check cache first — pure cache hits skip the action manager entirely.
  const cached = await getCachedDownload(url);
  if (cached) {
    logger.info('Cache hit — re-sending', logCtx);
    await sendResult(ctx, cached, url, messageId, showInfo);
    return;
  }

  const actionManager = new ChatActionManager(ctx, chatId);
  try {
    await actionManager.start('typing');

    // If another request is already downloading this URL, wait for it.
    // Otherwise re-check the cache (a concurrent request may have completed
    // between our initial check and now) before starting a fresh download.
    const key = normalizeUrl(url);
    let promise = inFlightDownloads.get(key);
    if (promise) {
      logger.info('Awaiting in-flight download', logCtx);
    } else {
      // Register the in-flight promise synchronously (no await between the get
      // and the set) so two concurrent requests for the same URL can't both miss
      // the map and start duplicate downloads to the same filename. The post-lock
      // cache recheck and the download both run inside this promise; the download
      // slot is acquired only around the actual download.
      promise = (async (): Promise<CachedDownload | null> => {
        const recheck = await getCachedDownload(url);
        if (recheck) {
          logger.info('Cache hit (post-lock) — re-sending', logCtx);
          return recheck;
        }
        return runDownloadPipeline(url, actionManager, logCtx);
      })().finally(() => inFlightDownloads.delete(key));
      inFlightDownloads.set(key, promise);
    }

    const result = await promise;

    if (!result) {
      await ctx
        .reply('Failed to process media. Please try a different URL.', {
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        })
        .catch(() => {});
      return;
    }

    await sendResult(ctx, result, url, messageId, showInfo);
  } catch (error) {
    logger.error('Failed to process media request', { ...logCtx, error });
    await ctx
      .reply('Failed to process media request', {
        reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      })
      .catch(() => {});
  } finally {
    actionManager.stop();
  }
}

async function sendResult(
  ctx: Context,
  result: CachedDownload,
  url: string,
  messageId: number,
  showInfo: boolean,
): Promise<void> {
  // Pin the cache key while uploading so the evict timer can't delete the files
  // from under an in-progress send (e.g. a slow album read near TTL expiry).
  const key = normalizeUrl(url);
  markInUse(key);
  try {
    if (result.mediaItems.length > 1) {
      await sendMediaGroup(ctx, result.mediaItems, result.mediaInfo, url, messageId, showInfo);
    } else {
      await sendSingleMedia(ctx, result.mediaItems[0], result.mediaInfo, url, messageId, showInfo);
    }
  } finally {
    unmarkInUse(key);
  }
}

/**
 * Runs fetch info → download → probe → cache. Returns the cached entry on
 * success, or null on failure (with files cleaned up). Shared across
 * concurrent duplicate-URL requests via inFlightDownloads so only one
 * actual download ever hits the filesystem for a given URL.
 */
async function runDownloadPipeline(
  url: string,
  actionManager: ChatActionManager,
  logCtx: Record<string, unknown>,
): Promise<CachedDownload | null> {
  const downloader = MediaDownloader.getInstance();
  let filePaths: string[] = [];
  let mediaItems: MediaItem[] = [];
  let cached = false;

  try {
    const mediaInfo = await fetchMediaInfo(downloader, url, actionManager, logCtx);
    if (!mediaInfo) return null;

    // Hold a download slot only around the actual download — the metadata fetch
    // (above) and probe/thumbnail work (buildMediaItems, bounded separately by
    // probeSemaphore) run outside it so they don't throttle other requests' slots.
    const result = await downloadSemaphore.run(() =>
      downloadMedia(downloader, url, mediaInfo, actionManager, logCtx),
    );
    if (!result.success || result.filePaths.length === 0 || !result.mediaInfo) {
      logger.error('Download failed', { ...logCtx, error: result.error });
      return null;
    }

    filePaths = result.filePaths;
    mediaItems = await buildMediaItems(filePaths);

    const key = normalizeUrl(url);
    const existing = downloadCache.get(key);
    if (existing && Date.now() <= existing.expiry && (await filesExist(existing.mediaItems))) {
      // Lost a cache race for this URL: a valid entry already exists. Serve it
      // and discard our redundant download so the duplicate files don't leak.
      await cleanupFiles(filePaths, mediaItems, downloader, logCtx);
      cached = true; // already cleaned — keep the finally from double-cleaning
      return existing;
    }

    const entry: CachedDownload = {
      mediaInfo: result.mediaInfo,
      mediaItems,
      expiry: Date.now() + DOWNLOAD_CACHE_TTL,
    };
    trimCacheToBudget(downloader, CACHE_MAX_BYTES - entryBytes(entry));
    downloadCache.set(key, entry);
    cached = true;
    return entry;
  } catch (error) {
    logger.error('Download pipeline failed', { ...logCtx, error });
    return null;
  } finally {
    if (!cached) {
      await cleanupFiles(filePaths, mediaItems, MediaDownloader.getInstance(), logCtx);
    }
  }
}

async function fetchMediaInfo(
  downloader: MediaDownloader,
  url: string,
  actionManager: ChatActionManager,
  logCtx: Record<string, unknown>,
): Promise<MediaMetadata | null> {
  await actionManager.start('typing');
  logger.info('Fetching media info...', logCtx);
  try {
    return await withRetry(() => downloader.getMediaInfo(url), {
      maxAttempts: 3,
      initialDelay: 1000,
      maxDelay: 5000,
    });
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
    { maxAttempts: 2, initialDelay: 2000, maxDelay: 10000 },
  );
}

// --- Media Item Building ---

async function buildMediaItems(filePaths: string[]): Promise<MediaItem[]> {
  const results = await Promise.allSettled(
    filePaths.map((path) =>
      probeSemaphore.run(async () => {
        assertSafePath(path, env.TMP_DIR);
        const probe = await probeMediaFile(path);

        const isVideo = probe.streams.some(
          (s) => s.codec_type === 'video' && !IMAGE_CODECS.has(s.codec_name),
        );

        // Per-video thumbnail: yt-dlp writes <basename>.jpg alongside each
        // video via --write-thumbnail. Store the path (not the bytes) so we
        // don't pin 50-200KB in memory for the whole 7-day cache TTL.
        let thumbnailPath: string | undefined;
        if (isVideo) {
          const candidate = path.replace(/\.[^.]+$/, '.jpg');
          // Extensionless filenames leave the regex with no match → candidate
          // === path. Skip entirely rather than point at the media file.
          if (candidate !== path) {
            assertSafePath(candidate, env.TMP_DIR);
            try {
              await access(candidate);
              // Downscale to Telegram's ≤320px / <200KB thumbnail constraint;
              // omit (Telegram auto-generates) if the scale step fails.
              if (await scaleThumbnail(candidate)) thumbnailPath = candidate;
            } catch {
              // No per-video thumb on disk — Telegram auto-generates
            }
          }
        }

        const { info, width, height } = extractStreamInfo(probe.streams, isVideo, probe.format);
        // ffprobe doesn't always report format.size; fall back to stat() (the
        // file is already on disk) so a missing size can't bypass the per-file /
        // album caps or get cached as 0 bytes (defeating the cache byte budget).
        const probedSize = probe.format?.size ? parseInt(probe.format.size, 10) : 0;
        const fileSizeBytes =
          Number.isFinite(probedSize) && probedSize > 0 ? probedSize : (await stat(path)).size;
        const fileSizeMB = fileSizeBytes > 0 ? (fileSizeBytes / BYTES_PER_MB).toFixed(1) : '0';

        if (fileSizeBytes > env.MAX_FILE_SIZE) {
          throw new Error(
            `Media file (${fileSizeMB}MB) exceeds size limit (${Math.round(env.MAX_FILE_SIZE / BYTES_PER_MB)}MB)`,
          );
        }

        return {
          path,
          isVideo,
          thumbnailPath,
          videoWidth: width,
          videoHeight: height,
          streamInfo: info,
          fileSizeBytes,
          fileSizeMB,
        };
      }),
    ),
  );

  const fulfilled: MediaItem[] = [];
  for (const r of results) {
    if (r.status === 'rejected') throw r.reason;
    fulfilled.push(r.value);
  }

  // Aggregate cap: guards against 100-item galleries that fit the per-file
  // limit but collectively exhaust disk/bandwidth/Telegram upload budget.
  const totalBytes = fulfilled.reduce((sum, item) => sum + item.fileSizeBytes, 0);
  if (totalBytes > MAX_ALBUM_BYTES) {
    throw new Error(
      `Album total (${(totalBytes / BYTES_PER_MB).toFixed(0)}MB) exceeds limit (${Math.round(MAX_ALBUM_BYTES / BYTES_PER_MB)}MB)`,
    );
  }

  return fulfilled;
}

// --- Telegram Send ---

async function sendMediaGroup(
  ctx: Context,
  mediaItems: MediaItem[],
  mediaInfo: { title: string },
  url: string,
  messageId: number,
  showInfo: boolean,
): Promise<void> {
  let sent = 0;
  for (let i = 0; i < mediaItems.length; i += MAX_MEDIA_GROUP_SIZE) {
    const chunk = mediaItems.slice(i, i + MAX_MEDIA_GROUP_SIZE);
    try {
      if (chunk.length === 1) {
        // Telegram media groups require 2-10 items; a lone trailing item (album
        // of 10n+1) must use the single-media path or replyWithMediaGroup 400s.
        await sendSingleMedia(
          ctx,
          chunk[0],
          { title: mediaInfo.title, format: chunk[0].isVideo ? 'video' : 'image' },
          url,
          messageId,
          showInfo && i === 0,
        );
      } else {
        const caption = showInfo
          ? buildGroupCaption(mediaInfo.title, url, chunk, i === 0)
          : undefined;
        const mediaGroup = chunk.map((item, index) => {
          const captionOpts =
            index === 0 && caption ? { caption, parse_mode: 'MarkdownV2' as const } : {};
          if (item.isVideo) {
            return {
              type: 'video' as const,
              media: new InputFile(item.path),
              ...captionOpts,
              ...(item.thumbnailPath && { thumbnail: new InputFile(item.thumbnailPath) }),
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
        await withTelegramFlood(() =>
          ctx.replyWithMediaGroup(mediaGroup, {
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
          }),
        );
      }
      sent += chunk.length;
    } catch (error) {
      // Nothing delivered yet → let the caller report a normal failure.
      if (sent === 0) throw error;
      // Some chunks already arrived → don't masquerade as a total failure.
      logger.warn('Partial album delivery', { sent, total: mediaItems.length, error });
      await ctx
        .reply(`Sent ${sent} of ${mediaItems.length} items; the rest failed — please retry.`, {
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        })
        .catch(() => {});
      return;
    }
  }
}

async function sendSingleMedia(
  ctx: Context,
  item: MediaItem,
  mediaInfo: { title: string; format: string },
  url: string,
  messageId: number,
  showInfo: boolean,
): Promise<void> {
  const caption = showInfo ? buildSingleCaption(mediaInfo.title, url, item) : undefined;
  const baseOpts = {
    reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
    ...(caption && { caption, parse_mode: 'MarkdownV2' as const }),
  };

  if (mediaInfo.format === 'audio') {
    await withTelegramFlood(() => ctx.replyWithVoice(new InputFile(item.path), baseOpts));
  } else if (item.isVideo) {
    await withTelegramFlood(() =>
      ctx.replyWithVideo(new InputFile(item.path), {
        ...baseOpts,
        ...(item.thumbnailPath && { thumbnail: new InputFile(item.thumbnailPath) }),
        ...(item.videoWidth &&
          item.videoHeight && { width: item.videoWidth, height: item.videoHeight }),
      }),
    );
  } else {
    await withTelegramFlood(() => ctx.replyWithPhoto(new InputFile(item.path), baseOpts));
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
    // yt-dlp writes a sibling thumbnail (--write-thumbnail) that buildMediaItems
    // discovers lazily; derive the candidates here too so a throw before/within
    // buildMediaItems (probe error, size cap) still cleans the sidecar. Covers
    // the converted .jpg plus a pre-conversion .webp/.png if conversion didn't run.
    const stem = p.replace(/\.[^.]+$/, '');
    if (stem !== p) {
      for (const ext of ['jpg', 'webp', 'png']) pathsToClean.add(`${stem}.${ext}`);
    }
  }
  for (const item of mediaItems) {
    pathsToClean.add(item.path);
    if (item.thumbnailPath) pathsToClean.add(item.thumbnailPath);
  }

  await Promise.all(
    Array.from(pathsToClean).map((file) =>
      downloader
        .cleanup(file)
        .catch((error) => logger.warn('Cleanup failed', { ...logCtx, file, error })),
    ),
  );
}
