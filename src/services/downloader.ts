import { exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import type { DownloadOptions, DownloadResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { getCookieFileForDomain } from '../config/env.js';

const execAsync = promisify(exec);

// Telegram limits (in bytes)
const TELEGRAM_LIMITS = {
  STANDARD: 50 * 1024 * 1024, // 50MB for regular bot API
  LOCAL_SERVER: 2000 * 1024 * 1024, // 2GB with local bot API server
} as const;

/**
 * Escapes a string for shell usage
 */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

interface FormatInfo {
  id?: string;
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  vcodec?: string;
  acodec?: string;
  abr?: number;
  tbr?: number;
  format_id: string;
}

export interface MediaMetadata {
  url: string;
  title: string;
  duration?: number;
  format: 'audio' | 'video' | 'image';
  thumbnail?: string;
  formats?: FormatInfo[];
  filesize?: number;
  mediaTypes?: MediaType[];
}

interface MediaType {
  url: string;
  display_url?: string;
  [key: string]: unknown;
}

export class MediaDownloader {
  private static instance: MediaDownloader;
  private downloadPath: string;
  private maxFileSize: number;

  private constructor() {
    this.downloadPath = './tmp';
    // Use standard limit by default
    this.maxFileSize = TELEGRAM_LIMITS.STANDARD;
  }

  public static getInstance(): MediaDownloader {
    if (!MediaDownloader.instance) {
      MediaDownloader.instance = new MediaDownloader();
    }
    return MediaDownloader.instance;
  }

  private getYtDlpCookieArgs(url: string): string[] {
    const args: string[] = [];
    try {
      // Extract domain from URL
      const domain = new URL(url).hostname.replace(/^www\./, '');
      const cookieFile = getCookieFileForDomain(domain);

      if (cookieFile) {
        args.push(`--cookies ${shellEscape(cookieFile)}`);
      }
    } catch (error) {
      logger.warn('Failed to parse URL for cookie configuration', { url, error });
    }
    return args;
  }

  private getGalleryDlCookieArgs(url: string): string[] {
    const args: string[] = [];
    try {
      // Extract domain from URL
      const domain = new URL(url).hostname.replace(/^www\./, '');
      const cookieFile = getCookieFileForDomain(domain);

      if (cookieFile) {
        args.push(`--cookies ${shellEscape(cookieFile)}`);
      }
    } catch (error) {
      logger.warn('Failed to parse URL for cookie configuration', { url, error });
    }
    return args;
  }

  private isImageSite(url: string): boolean {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      return [
        'instagram.com',
        'twitter.com',
        'x.com',
        'pixiv.net',
        'deviantart.com',
        'artstation.com',
      ].some((site) => domain.endsWith(site));
    } catch {
      return false;
    }
  }

  /**
   * Gets media information without downloading
   */
  public async getMediaInfo(url: string): Promise<MediaMetadata | null> {
    try {
      if (this.isImageSite(url)) {
        const command = [
          'gallery-dl',
          '-j',
          ...this.getGalleryDlCookieArgs(url),
          shellEscape(url),
        ].join(' ');

        const { stdout, stderr } = await execAsync(command);

        if (stderr) {
          logger.warn('gallery-dl warning', { command: 'getMediaInfo' });
        }

        const output = JSON.parse(stdout);
        // First item contains post metadata
        const postMetadata = output[0][1];
        // Remaining items are media
        const mediaTypes = output.slice(1).map((item: [unknown, string, MediaType]) => {
          const [, itemUrl, metadata] = item;
          const { display_url, ...rest } = metadata;
          return {
            ...rest,
            url: display_url || itemUrl,
          };
        });

        // Build title from available metadata
        let title = '';
        if (postMetadata.tweet_text) {
          title = postMetadata.tweet_text;
        } else if (postMetadata.description) {
          title = postMetadata.description;
        } else if (postMetadata.text) {
          title = postMetadata.text;
        } else if (postMetadata.content) {
          title = postMetadata.content;
        } else {
          title = 'No title';
        }

        return {
          url,
          title,
          format: 'image',
          thumbnail: mediaTypes[0]?.display_url,
          mediaTypes,
        };
      }

      // If we get here, use yt-dlp for audio/video content
      const printTemplate = [
        '{',
        '"url": %(url)j,',
        '"title": %(title)j,',
        '"duration": %(duration)s,',
        '"thumbnail": %(thumbnail)j',
        '}',
      ].join('');

      const command = [
        'yt-dlp',
        '--no-download',
        `--print ${shellEscape(printTemplate)}`,
        '--no-playlist',
        ...this.getYtDlpCookieArgs(url),
        shellEscape(url),
      ].join(' ');

      // Execute with retries
      const { stdout, stderr } = await withRetry(() => execAsync(command));

      if (stderr) {
        logger.warn('yt-dlp warning', { command: 'getMediaInfo', stderr });
      }

      const cleanJson = stdout.replace(/: NA,/g, ': null,').replace(/: NA}/g, ': null}');
      const info = JSON.parse(cleanJson);

      // Get formats with retries only for video/audio content
      const formats = await withRetry(() => this.getFormats(url));
      const hasVideo = formats.some((f) => f.vcodec && f.vcodec !== 'none' && f.vcodec !== 'null');

      return {
        url,
        title: info.title,
        duration: info.duration ? Number(info.duration) : undefined,
        format: hasVideo ? 'video' : 'audio',
        thumbnail: info.thumbnail,
        formats,
      };
    } catch (error) {
      logger.error('Failed to get media info', error);
      return null;
    }
  }

  private async getFormats(url: string): Promise<FormatInfo[]> {
    try {
      const command = [
        'yt-dlp',
        '--no-download',
        '--print',
        shellEscape('%(formats)j'),
        '--no-playlist',
        ...this.getYtDlpCookieArgs(url),
        shellEscape(url),
      ].join(' ');

      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        logger.warn('yt-dlp warning', { command: 'getFormats' });
      }

      return JSON.parse(stdout);
    } catch (error) {
      logger.error('Failed to get formats', error);
      return [];
    }
  }

  private selectBestFormat(formats: FormatInfo[], options: DownloadOptions): string {
    const formatSpec =
      options.format === 'audio'
        ? 'bestaudio[acodec=opus]/bestaudio'
        : options.format === 'image'
          ? 'best[ext=jpg]/best[ext=png]/best[ext=webp]/best'
          : 'best';
    logger.debug('Selected format spec', { command: 'selectBestFormat', formatSpec });
    return formatSpec;
  }

  /**
   * Downloads media from a given URL using yt-dlp
   */
  public async download(url: string, options: DownloadOptions): Promise<DownloadResult> {
    try {
      if (this.isImageSite(url)) {
        const command = [
          'gallery-dl',
          '--download-archive',
          '/dev/null',
          '--dest',
          `'${this.downloadPath}'`,
          '--filename',
          '{filename}.{extension}',
          '--no-mtime',
          ...this.getGalleryDlCookieArgs(url),
          shellEscape(url),
        ].join(' ');

        const { stdout, stderr } = await execAsync(command, { timeout: options.timeout * 1000 });

        if (stderr && !stderr.includes('Failed to open download archive')) {
          logger.warn('gallery-dl warning', { command: 'download' });
        }

        const filePaths = stdout.trim().split('\n').filter(Boolean);

        if (filePaths.length === 0) {
          return {
            success: false,
            error: 'No files were downloaded',
            filePaths: [],
          };
        }

        const mediaInfo = await this.getMediaInfo(url);
        if (!mediaInfo) {
          return {
            success: false,
            error: 'Failed to get media info',
            filePaths: [],
          };
        }

        return {
          success: true,
          filePaths,
          mediaInfo,
        };
      }

      // For non-image sites, use yt-dlp
      // Get available formats first
      const formats = await this.getFormats(url);

      // Select the best format that meets our criteria
      const formatSpec = this.selectBestFormat(formats, options);

      logger.info('Selected format spec', { command: 'download', formatSpec });

      const outputTemplate = `${this.downloadPath}/%(title)s-%(id)s.%(ext)s`;

      const command = [
        'yt-dlp',
        `--format ${shellEscape(formatSpec)}`,
        '--no-playlist',
        `--output ${shellEscape(outputTemplate)}`,
        // Skip info extraction since we already have it
        '--no-download-archive',
        '--no-write-info-json',
        '--no-write-description',
        '--no-write-thumbnail',
        '--no-progress',
        ...this.getYtDlpCookieArgs(url),
        shellEscape(url),
      ].join(' ');

      const { stdout, stderr } = await execAsync(command, { timeout: options.timeout * 1000 });

      if (stderr) {
        logger.warn('yt-dlp warning', { command: 'download', stderr });
      }

      // Extract file path from output
      const filePath = this.extractFilePath(stdout);

      if (!filePath) {
        return {
          success: false,
          error: 'Failed to extract downloaded file path',
          filePaths: [],
        };
      }

      const mediaInfo = await this.getMediaInfo(url);
      if (!mediaInfo) {
        return {
          success: false,
          error: 'Failed to get media info',
          filePaths: [],
        };
      }

      return {
        success: true,
        filePaths: [filePath],
        mediaInfo,
      };
    } catch (error) {
      logger.error('Failed to download media', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        filePaths: [],
      };
    }
  }

  /**
   * Extracts file path from yt-dlp output
   */
  private extractFilePath(output: string): string | null {
    // Split output into lines and reverse to get the most recent messages
    const lines = output.split('\n').reverse();

    for (const line of lines) {
      // Look for the final merged output for videos
      if (line.includes('[Merger] Merging formats into')) {
        const match = line.match(/Merging formats into "(.*?)"/);
        if (match) return match[1];
      }

      // Look for the final audio extraction output
      if (line.includes('[ExtractAudio] Destination:')) {
        const match = line.match(/Destination: (.*)/);
        if (match) return match[1];
      }

      // Look for direct download destination as fallback
      if (line.includes('[download] Destination:')) {
        const match = line.match(/Destination: (.*)/);
        if (match) return match[1];
      }
    }

    return null;
  }

  /**
   * Cleans up downloaded file
   */
  public async cleanup(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
