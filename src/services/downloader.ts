import { unlink } from 'fs/promises';
import { env, getCookieFileForDomain } from '../config/env.js';
import { safeExec } from '../utils/exec.js';
import { assertSafePath } from '../utils/pathSafety.js';
import { isDomainMatch } from '../utils/url.js';
import type { DownloadOptions, DownloadResult } from '../types/index.js';

const IMAGE_SITES = [
  'instagram.com',
  'twitter.com',
  'x.com',
  'pixiv.net',
  'deviantart.com',
  'artstation.com',
];

const MAX_FILES_PER_DOWNLOAD = 100;

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
  thumbnail?: string;
  mediaTypes?: MediaType[];
}

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

  private getCookieArgs(url: string): string[] {
    const domain = this.getHostname(url);
    if (!domain) return [];
    const cookieFile = getCookieFileForDomain(domain);
    return cookieFile ? ['--cookies', cookieFile] : [];
  }

  private isImageSite(url: string): boolean {
    const domain = this.getHostname(url);
    if (!domain) return false;
    return IMAGE_SITES.some((site) => isDomainMatch(domain, site));
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
    const { stdout } = await safeExec('gallery-dl', ['-j', ...this.getCookieArgs(url), url]);

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
      return { ...rest, url: display_url || itemUrl };
    });

    const title =
      (postMetadata.tweet_text as string) ||
      (postMetadata.description as string) ||
      (postMetadata.text as string) ||
      (postMetadata.content as string) ||
      'No title';

    return {
      url,
      title,
      format: 'image',
      thumbnail: mediaTypes[0]?.url,
      mediaTypes,
    };
  }

  private async getYtDlpInfo(url: string): Promise<MediaMetadata> {
    // No inner withRetry — the caller owns retry responsibility
    const printTemplate = [
      '{',
      '"url": %(url)j,',
      '"title": %(title)j,',
      '"duration": %(duration)s,',
      '"thumbnail": %(thumbnail)j,',
      '"vcodec": "%(vcodec)s",',
      '"acodec": "%(acodec)s"',
      '}',
    ].join('');

    const { stdout } = await safeExec('yt-dlp', [
      '--no-download',
      '--print',
      printTemplate,
      '--no-playlist',
      ...this.getCookieArgs(url),
      url,
    ]);

    const cleanJson = stdout.replace(/: NA,/g, ': null,').replace(/: NA}/g, ': null}');

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
      title: (info.title as string) || 'No title',
      duration: info.duration ? Number(info.duration) : undefined,
      format: hasVideo ? 'video' : 'audio',
      thumbnail: info.thumbnail as string | undefined,
    };
  }

  private getFormatSpec(format: string): string {
    if (format === 'audio') return 'bestaudio[acodec=opus]/bestaudio';
    if (format === 'image') return 'best[ext=jpg]/best[ext=png]/best[ext=webp]/best';
    return 'best';
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
    const filePaths = this.isImageSite(url)
      ? await this.downloadWithGalleryDl(url, options)
      : await this.downloadWithYtDlp(url, options);

    if (filePaths.length === 0) {
      return { success: false, error: 'No files were downloaded', filePaths: [] };
    }

    return { success: true, filePaths, mediaInfo };
  }

  private async downloadWithGalleryDl(url: string, options: DownloadOptions): Promise<string[]> {
    const { stdout } = await safeExec(
      'gallery-dl',
      [
        '--download-archive',
        '/dev/null',
        '--dest',
        env.TMP_DIR,
        '--filename',
        '{filename}.{extension}',
        '--no-mtime',
        '--range',
        `1-${MAX_FILES_PER_DOWNLOAD}`,
        ...this.getCookieArgs(url),
        url,
      ],
      { timeout: options.timeout },
    );

    const filePaths = stdout.trim().split('\n').filter(Boolean);
    return filePaths.map((p) => assertSafePath(p.trimEnd(), env.TMP_DIR));
  }

  private async downloadWithYtDlp(url: string, options: DownloadOptions): Promise<string[]> {
    const formatSpec = this.getFormatSpec(options.format);
    const outputTemplate = `${env.TMP_DIR}/%(title)s-%(id)s.%(ext)s`;

    // Use --print after_move:filepath for reliable path extraction
    const { stdout } = await safeExec(
      'yt-dlp',
      [
        '--format',
        formatSpec,
        '--no-playlist',
        '--output',
        outputTemplate,
        '--restrict-filenames',
        '--max-filesize',
        String(options.maxFileSize),
        '--quiet',
        '--no-warnings',
        '--print',
        'after_move:filepath',
        ...this.getCookieArgs(url),
        url,
      ],
      { timeout: options.timeout },
    );

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
