import { unlink } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { env, findSiteByDomain, getCookieFileForDomain, getSiteHeaders } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { safeExec } from '../utils/exec.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { applyRateLimitFromError, isRateLimitError } from '../utils/hostCooldown.js';
import type { DownloadOptions, DownloadResult } from '../types/index.js';

const MAX_FILES_PER_DOWNLOAD = 100;
// Metadata fetches should be quick; anything longer is effectively a hang
// from the user's perspective. The retry layer handles transient failures.
const INFO_FETCH_TIMEOUT_SEC = 15;
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi']);
// Gallery-dl Python filter expression derived from the same set — single source of truth
const GALLERY_DL_IMAGE_FILTER = `extension not in (${[...VIDEO_EXTENSIONS]
  .map((e) => `'${e}'`)
  .join(',')})`;

interface MediaType {
  url: string;
  display_url?: string;
  [key: string]: unknown;
}

export interface MediaMetadata {
  url: string;
  title: string;
  duration?: number;
  format: 'audio' | 'video' | 'image';
  mediaTypes?: MediaType[];
  contentCounts?: { images: number; videos: number };
}

/** Coerce an unknown JSON field (from external tool output) to a string. */
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

export class MediaDownloader {
  private static instance: MediaDownloader;

  private constructor() {}

  public static getInstance(): MediaDownloader {
    if (!MediaDownloader.instance) {
      MediaDownloader.instance = new MediaDownloader();
    }
    return MediaDownloader.instance;
  }

  private getHostname(url: string): string | null {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  /**
   * All per-URL flags (cookies + browser fingerprint headers) for yt-dlp.
   * Parses the hostname once. Helps keep sessions fresh by matching the
   * browser fingerprint that exported the cookies.
   */
  private getYtDlpPerUrlArgs(url: string): string[] {
    const domain = this.getHostname(url);
    if (!domain) return [];
    const cookieFile = getCookieFileForDomain(domain);
    const headers = getSiteHeaders(domain);
    const args: string[] = [];
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'user-agent') args.push('--user-agent', value);
      else args.push('--add-header', `${name}: ${value}`);
    }
    if (cookieFile) args.push('--cookies', cookieFile);
    return args;
  }

  /**
   * All per-URL flags (cookies + headers) for gallery-dl via -o extractor.<site>.*
   * Values are JSON-encoded so gallery-dl's parser treats them as strings
   * (e.g. "936619743392459" stays a string; values with embedded quotes
   * like Sec-CH-UA get proper escaping).
   *
   * Instagram-specific flags address the Apr-2026 429 wave on the
   * `/api/v1/users/web_profile_info/` endpoint: user-cache + user-strategy=id
   * skip the throttled username→id lookup; sleep-request adds the documented
   * default spacing between Instagram API calls.
   */
  private getGalleryDlPerUrlArgs(url: string): string[] {
    const domain = this.getHostname(url);
    if (!domain) return [];
    const site = findSiteByDomain(domain);
    const cookieFile = getCookieFileForDomain(domain);
    const args: string[] = [];
    if (site) {
      const headers = getSiteHeaders(domain);
      for (const [name, value] of Object.entries(headers)) {
        const encoded = JSON.stringify(value);
        if (name === 'user-agent') {
          args.push('-o', `extractor.${site.alias}.user-agent=${encoded}`);
        } else {
          args.push('-o', `extractor.${site.alias}.headers.${name}=${encoded}`);
        }
      }
      if (site.alias === 'instagram') {
        args.push(
          '-o',
          'extractor.instagram.user-cache=true',
          '-o',
          'extractor.instagram.user-strategy="id"',
          '-o',
          'extractor.instagram.sleep-request="6.0-12.0"',
        );
      }
    }
    if (cookieFile) args.push('--cookies', cookieFile);
    return args;
  }

  private isImageSite(url: string): boolean {
    const domain = this.getHostname(url);
    if (!domain) return false;
    return findSiteByDomain(domain)?.type === 'image';
  }

  /**
   * Gets media information without downloading.
   * Throws on failure so the caller's withRetry can handle retries.
   */
  public async getMediaInfo(url: string): Promise<MediaMetadata> {
    if (this.isImageSite(url)) {
      return await this.getGalleryDlInfo(url);
    }
    return await this.getYtDlpInfo(url);
  }

  private async getGalleryDlInfo(url: string): Promise<MediaMetadata> {
    let stdout: string;
    try {
      // --retries 0: bail immediately on 429 instead of letting gallery-dl
      // burn our 15s budget on internal back-off. The host-cooldown layer
      // (set in catch below) prevents future requests until it's safe.
      const result = await safeExec(
        'gallery-dl',
        ['--retries', '0', '-j', ...this.getGalleryDlPerUrlArgs(url), url],
        { timeout: INFO_FETCH_TIMEOUT_SEC },
      );
      stdout = result.stdout;
    } catch (error) {
      if (isRateLimitError(error)) {
        const host = this.getHostname(url);
        const message = error instanceof Error ? error.message : String(error);
        if (host) applyRateLimitFromError(host, message);
      }
      throw error;
    }

    let output: unknown;
    try {
      output = JSON.parse(stdout);
    } catch {
      throw new Error('Failed to parse gallery-dl JSON output');
    }

    if (!Array.isArray(output) || output.length === 0) {
      throw new Error('Unexpected gallery-dl output structure: expected non-empty array');
    }

    const postMetadata = (output[0]?.[1] ?? {}) as Record<string, unknown>;
    const mediaTypes = output.slice(1).map((item: unknown[]) => {
      if (!Array.isArray(item) || item.length < 3 || !item[2]) {
        return { url: String(item?.[1] ?? '') };
      }
      const [, itemUrl, metadata] = item as [unknown, string, MediaType];
      const { display_url, ...rest } = metadata;
      return { ...rest, url: asString(display_url) || itemUrl };
    });

    const title =
      asString(postMetadata.tweet_text) ||
      asString(postMetadata.description) ||
      asString(postMetadata.text) ||
      asString(postMetadata.content) ||
      'No title';

    const imageCount = mediaTypes.filter(
      (m) =>
        !VIDEO_EXTENSIONS.has(String((m as Record<string, unknown>).extension || '').toLowerCase()),
    ).length;
    const videoCount = mediaTypes.filter((m) =>
      VIDEO_EXTENSIONS.has(String((m as Record<string, unknown>).extension || '').toLowerCase()),
    ).length;

    return {
      url,
      title,
      format: videoCount > 0 ? 'video' : 'image',
      mediaTypes,
      contentCounts: { images: imageCount, videos: videoCount },
    };
  }

  private async getYtDlpInfo(url: string): Promise<MediaMetadata> {
    // No inner withRetry — the caller owns retry responsibility
    const printTemplate = [
      '{',
      '"title": %(title)j,',
      '"duration": %(duration)s,',
      '"vcodec": %(vcodec)j,',
      '"acodec": %(acodec)j',
      '}',
    ].join('');

    let stdout: string;
    try {
      // --retries 0 / --extractor-retries 0: same fast-fail rationale as
      // getGalleryDlInfo — let host-cooldown own 429 backoff, not yt-dlp.
      const result = await safeExec(
        'yt-dlp',
        [
          '--no-download',
          '--print',
          printTemplate,
          '--no-playlist',
          '--retries',
          '0',
          '--extractor-retries',
          '0',
          ...this.getYtDlpPerUrlArgs(url),
          url,
        ],
        { timeout: INFO_FETCH_TIMEOUT_SEC },
      );
      stdout = result.stdout;
    } catch (error) {
      if (isRateLimitError(error)) {
        const host = this.getHostname(url);
        const message = error instanceof Error ? error.message : String(error);
        if (host) applyRateLimitFromError(host, message);
      }
      throw error;
    }

    // yt-dlp emits a bare NA (not "NA" or null) for any unavailable field —
    // %(...)s always, and %(...)j when the value is absent — so normalize every
    // bare NA value to null before parsing (e.g. vcodec/acodec on some sites).
    const cleanJson = stdout.replace(/: NA(?=[,}])/g, ': null');

    let info: Record<string, unknown>;
    try {
      info = JSON.parse(cleanJson);
    } catch {
      throw new Error('Failed to parse yt-dlp JSON output');
    }

    const vcodec = String(info.vcodec || '');
    const hasVideo = vcodec !== '' && vcodec !== 'none' && vcodec !== 'null';

    return {
      url,
      title: asString(info.title) || 'No title',
      duration: info.duration != null ? Number(info.duration) : undefined,
      format: hasVideo ? 'video' : 'audio',
    };
  }

  private getFormatSpec(format: string, maxFileSize: number): string {
    if (format === 'audio') return 'bestaudio[acodec=opus]/bestaudio';
    if (format === 'image') return 'best[ext=jpg]/best[ext=png]/best[ext=webp]/best';
    // Prefer H.264 video + AAC audio under the size cap (Telegram plays these
    // inline), then fall back to the size-filtered DASH chain, then anything.
    // bv (not bv*) keeps the size filter meaningful — pre-merged blobs lack filesize.
    return (
      `bv*[vcodec^=avc1][filesize<${maxFileSize}]+ba[acodec^=mp4a]/` +
      `bv[filesize<${maxFileSize}]+ba/bv[filesize_approx<${maxFileSize}]+ba/bv+ba/b`
    );
  }

  /**
   * Downloads media from a URL. Accepts pre-fetched mediaInfo to avoid redundant calls.
   * Throws on transient errors so the caller's withRetry can retry.
   */
  public async download(
    url: string,
    options: DownloadOptions,
    mediaInfo: MediaMetadata,
  ): Promise<DownloadResult> {
    let filePaths: string[];

    if (this.isImageSite(url)) {
      const { images = 0, videos = 0 } = mediaInfo.contentCounts || {};
      const written: string[] = [];
      try {
        if (images > 0) written.push(...(await this.downloadImagesWithGalleryDl(url, options)));
      } catch (error) {
        // Images are the primary content for image sites — a failure here is fatal.
        await Promise.all(written.map((p) => this.cleanup(p)));
        throw error;
      }
      if (videos > 0) {
        try {
          written.push(...(await this.downloadVideosWithYtDlp(url, options)));
        } catch (error) {
          // Videos totally failed. If we already have images, deliver those
          // rather than discarding a valid partial result; otherwise rethrow.
          if (written.length === 0) throw error;
          logger.warn('Carousel videos failed; delivering images only', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      filePaths = written;
    } else {
      filePaths = await this.downloadWithYtDlp(url, options);
    }

    if (filePaths.length === 0) {
      return { success: false, error: 'No files were downloaded', filePaths: [] };
    }

    return { success: true, filePaths, mediaInfo };
  }

  private async downloadImagesWithGalleryDl(
    url: string,
    options: DownloadOptions,
  ): Promise<string[]> {
    // Per-request filename prefix so two concurrent DISTINCT URLs whose media
    // share a native filename can't collide/overwrite in the flat TMP_DIR.
    const prefix = randomUUID().slice(0, 8);
    let stdout: string;
    try {
      ({ stdout } = await safeExec(
        'gallery-dl',
        [
          '--download-archive',
          '/dev/null',
          '--dest',
          env.TMP_DIR,
          '--filename',
          `${prefix}_{filename}.{extension}`,
          '--no-mtime',
          '--filter',
          GALLERY_DL_IMAGE_FILTER,
          '--range',
          `1-${MAX_FILES_PER_DOWNLOAD}`,
          ...this.getGalleryDlPerUrlArgs(url),
          url,
        ],
        { timeout: options.timeout },
      ));
    } catch (error) {
      // A 429 during the actual download must arm host-cooldown too (not just
      // the info fetch), so the next request short-circuits instead of retrying.
      if (isRateLimitError(error)) {
        const host = this.getHostname(url);
        if (host) {
          applyRateLimitFromError(host, error instanceof Error ? error.message : String(error));
        }
      }
      throw error;
    }

    const filePaths = stdout
      .trim()
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('#'));
    return filePaths.map((p) => assertSafePath(p, env.TMP_DIR));
  }

  private async downloadVideosWithYtDlp(url: string, options: DownloadOptions): Promise<string[]> {
    const formatSpec = this.getFormatSpec('video', options.maxFileSize);
    const outputTemplate = `${env.TMP_DIR}/%(title)s-%(id)s.%(ext)s`;

    // --ignore-errors: skip image items in carousels (yt-dlp can't handle images)
    // No --no-playlist: process all video items in a carousel
    // yt-dlp exits non-zero if ANY item fails, even with --ignore-errors,
    // so catch the error and extract stdout for successfully downloaded paths
    let stdout = '';
    try {
      const result = await safeExec(
        'yt-dlp',
        [
          '--format',
          formatSpec,
          '--ignore-errors',
          '--output',
          outputTemplate,
          '--restrict-filenames',
          '--no-mtime',
          '--merge-output-format',
          'mp4',
          '--write-thumbnail',
          '--convert-thumbnails',
          'jpg',
          '--quiet',
          '--no-warnings',
          '--print',
          'after_move:filepath',
          ...this.getYtDlpPerUrlArgs(url),
          url,
        ],
        { timeout: options.timeout },
      );
      stdout = result.stdout;
    } catch (error) {
      // Extract stdout — successful items still printed paths even on non-zero exit.
      // Log so genuine failures (network, disk, invalid format) remain visible
      // instead of being silently absorbed.
      const hasStdout = (e: unknown): e is { stdout: string } =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { stdout?: unknown }).stdout === 'string';
      const hasStderr = (e: unknown): e is { stderr: string } =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { stderr?: unknown }).stderr === 'string';
      stdout = hasStdout(error) ? error.stdout : '';
      logger.warn('yt-dlp exited non-zero during carousel download', {
        stderr: hasStderr(error) ? error.stderr.slice(0, 500) : undefined,
        message: error instanceof Error ? error.message : String(error),
        gotPaths: stdout.trim().length > 0,
      });
      // Arm host-cooldown on any 429 — even a partial carousel (some items
      // recovered) means the host is rate-limiting, so the next request should
      // wait rather than retry immediately.
      if (isRateLimitError(error)) {
        const host = this.getHostname(url);
        if (host) {
          applyRateLimitFromError(host, error instanceof Error ? error.message : String(error));
        }
      }
      // Nothing recovered → genuine total failure. Surface it so withRetry can
      // retry; a swallowed error would otherwise be cached and sent as empty success.
      if (stdout.trim().length === 0) throw error;
    }

    const filePaths = stdout
      .trimEnd()
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    return filePaths.map((p) => assertSafePath(p, env.TMP_DIR));
  }

  private async downloadWithYtDlp(url: string, options: DownloadOptions): Promise<string[]> {
    const formatSpec = this.getFormatSpec(options.format, options.maxFileSize);
    const outputTemplate = `${env.TMP_DIR}/%(title)s-%(id)s.%(ext)s`;
    // Write per-video thumbnail to disk for video format so buildMediaItems
    // can read it without an extra HTTP round-trip. Audio/image formats don't
    // use thumbnails (replyWithVoice/replyWithPhoto don't accept them).
    const videoArgs =
      options.format === 'video'
        ? ['--merge-output-format', 'mp4', '--write-thumbnail', '--convert-thumbnails', 'jpg']
        : [];

    let stdout: string;
    try {
      ({ stdout } = await safeExec(
        'yt-dlp',
        [
          '--format',
          formatSpec,
          '--no-playlist',
          '--output',
          outputTemplate,
          '--restrict-filenames',
          '--no-mtime',
          ...videoArgs,
          '--quiet',
          '--no-warnings',
          '--print',
          'after_move:filepath',
          ...this.getYtDlpPerUrlArgs(url),
          url,
        ],
        { timeout: options.timeout },
      ));
    } catch (error) {
      // A 429 during the actual download must arm host-cooldown too.
      if (isRateLimitError(error)) {
        const host = this.getHostname(url);
        if (host) {
          applyRateLimitFromError(host, error instanceof Error ? error.message : String(error));
        }
      }
      throw error;
    }

    const filePath = stdout.trimEnd().split('\n').pop()?.trim();
    if (!filePath) return [];

    return [assertSafePath(filePath, env.TMP_DIR)];
  }

  public async cleanup(filePath: string): Promise<void> {
    try {
      assertSafePath(filePath, env.TMP_DIR);
      await unlink(filePath);
    } catch {
      // Ignore cleanup errors (file may already be deleted)
    }
  }
}
