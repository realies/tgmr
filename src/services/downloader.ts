import { exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import type { DownloadOptions, DownloadResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { env, getCookieFileForDomain } from '../config/env.js';

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

interface MediaMetadata {
  url: string;
  title: string;
  duration?: number;
  format: 'audio' | 'video';
  thumbnail?: string;
  formats?: FormatInfo[];
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

  /**
   * Gets media information without downloading
   */
  public async getMediaInfo(url: string): Promise<MediaMetadata | null> {
    try {
      // Get formats with retries
      const formats = await withRetry(() => this.getFormats(url));

      const printTemplate = [
        '{',
        '"url": %(url)j,',
        '"title": %(title)j,',
        '"duration": %(duration)s,',
        '"thumbnail": %(thumbnail)j',
        '}'
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

      // Determine format based on available formats
      const hasVideo = formats.some(f => f.vcodec && f.vcodec !== 'none' && f.vcodec !== 'null');

      return {
        url,
        title: info.title,
        duration: info.duration ? Number(info.duration) : undefined,
        format: hasVideo ? 'video' : 'audio',
        thumbnail: info.thumbnail,
        formats,
      };
    } catch (error) {
      logger.error('Failed to get media info', error, { command: 'getMediaInfo', url });
      if (error instanceof Error && 'stderr' in error) {
        logger.error('yt-dlp error', null, { command: 'getMediaInfo', stderr: error.stderr });
      }
      return null;
    }
  }

  private async getFormats(url: string): Promise<FormatInfo[]> {
    const command = [
      'yt-dlp',
      '--no-download',
      '--print-json',
      '--no-playlist',
      ...this.getYtDlpCookieArgs(url),
      shellEscape(url),
    ].join(' ');

    try {
      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        logger.warn('yt-dlp warning', { command: 'getFormats', stderr });
      }

      const info = JSON.parse(stdout);
      return info.formats || [];
    } catch (error) {
      logger.error('Failed to get formats', error, { command: 'getFormats', url });
      throw error;
    }
  }

  private selectBestFormat(formats: FormatInfo[], options: DownloadOptions): string {
    const formatSpec = options.format === 'audio' ? 'bestaudio[acodec=opus]/bestaudio' : 'best';
    logger.debug('Selected format spec', { command: 'selectBestFormat', formatSpec });
    return formatSpec;
  }

  /**
   * Downloads media from a given URL using yt-dlp
   */
  public async download(url: string, options: DownloadOptions): Promise<DownloadResult> {
    try {
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
        return { success: false, error: 'Failed to extract downloaded file path' };
      }

      return {
        success: true,
        filePath,
        mediaInfo: (await this.getMediaInfo(url)) || undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('Failed to download media', error, { command: 'download', url });
      return { success: false, error: errorMessage };
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
