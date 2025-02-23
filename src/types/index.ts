import type { MediaMetadata } from '../services/downloader.js';

export interface MediaInfo {
  url: string;
  title: string;
  duration?: number;
  filesize?: number;
  format: 'audio' | 'video' | 'image';
  thumbnail?: string;
}

export interface DownloadOptions {
  maxFileSize: number;
  timeout: number;
  format: 'audio' | 'video' | 'image';
}

export interface DownloadResult {
  success: boolean;
  filePaths: string[]; // Array of paths, can contain one or more files
  error?: string;
  mediaInfo?: MediaMetadata;
}
