export interface MediaInfo {
  url: string;
  title: string;
  duration?: number;
  filesize?: number;
  format: 'audio' | 'video';
  thumbnail?: string;
}

export interface DownloadOptions {
  maxFileSize: number;
  timeout: number;
  format: 'audio' | 'video';
}

export interface DownloadResult {
  success: boolean;
  filePath?: string;
  error?: string;
  mediaInfo?: MediaInfo;
}
