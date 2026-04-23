import type { MediaMetadata } from '../services/downloader.js';

export interface DownloadOptions {
  maxFileSize: number;
  timeout: number;
  format: 'audio' | 'video' | 'image';
}

export interface DownloadResult {
  success: boolean;
  filePaths: string[];
  error?: string;
  mediaInfo?: MediaMetadata;
}
