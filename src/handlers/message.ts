import { Context, InputFile } from 'grammy';
import { isValidUrl, isSupportedPlatform } from '../utils/url.js';
import { MediaDownloader } from '../services/downloader.js';
import { env } from '../config/env.js';
import { createReadStream, stat, unlink } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const execAsync = promisify(exec);
const statAsync = promisify(stat);
const unlinkAsync = promisify(unlink);

type ChatAction = 
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

interface FFprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  bit_rate?: string;
}

interface FFprobeData {
  streams: FFprobeStream[];
  format?: {
    size?: string;
    bit_rate?: string;
  };
}

/**
 * Manages a chat action status with immediate start and cleanup
 */
class ChatActionManager {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private ctx: Context,
    private chatId: number
  ) {}

  async start(action: ChatAction): Promise<void> {
    try {
      // Clear any existing interval
      this.stop();
      
      // Send action immediately with retry
      await this.sendActionWithRetry(action);
      
      // Set up interval for keeping the action alive
      this.interval = setInterval(() => {
        this.sendActionWithRetry(action).catch(error => {
          // Only log if it's not a network error (since those will be retried)
          if (!error.message?.includes('Network request')) {
            logger.error('Failed to send chat action after retries', error);
          }
        });
      }, 1000);
    } catch (error) {
      logger.error('Failed to start chat action after retries', error);
      this.stop();
    }
  }

  private async sendActionWithRetry(action: ChatAction): Promise<void> {
    await withRetry(
      () => this.ctx.api.sendChatAction(this.chatId, action),
      {
        maxAttempts: 5,
        initialDelay: 500,
        maxDelay: 5000,
      }
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

export async function handleMessage(ctx: Context): Promise<void> {
  const messageText = ctx.message?.text;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const messageId = ctx.message?.message_id;
  const chatType = ctx.chat?.type;
  const isAnonymousAdmin = ctx.from?.username === 'GroupAnonymousBot';
  
  // Create context object for logging
  const logContext = {
    type: chatType,
    chat: chatId,
    from: isAnonymousAdmin ? 'AnonymousAdmin' : username || userId,
    msgId: messageId
  };

  logger.info('Processing message', {
    ...logContext,
    text: messageText?.substring(0, 100)
  });
  
  if (!messageText || !chatId) {
    logger.warn('Skipping message due to missing text or chatId', logContext);
    return;
  }

  // Create user identifier string
  const userInfo = isAnonymousAdmin 
    ? 'Anonymous Admin' 
    : username 
      ? `@${username}` 
      : `user ${userId}`;
  const requestId = `[${chatId}:${messageId}]`;

  try {
    // Extract URLs from message
    const words = messageText.split(/\s+/);
    const urls = words.filter((word) => isValidUrl(word) && isSupportedPlatform(word));

    if (urls.length === 0) return;

    const url = urls[0];
    logger.info(`${userInfo} requested: ${url}`, { ...logContext, requestId });
    
    const downloader = MediaDownloader.getInstance();
    const actionManager = new ChatActionManager(ctx, chatId);

    try {
      await actionManager.start("typing");

      // Get media info first to determine format
      logger.info('Fetching media info...', { ...logContext, requestId });
      const mediaInfo = await withRetry(
        () => downloader.getMediaInfo(url),
        {
          maxAttempts: 5,
          initialDelay: 2000,
          maxDelay: 15000,
        }
      );

      if (!mediaInfo) {
        actionManager.stop();
        logger.warn('Failed to get media information after retries', { ...logContext, requestId });
        await ctx.reply('Failed to get media information after several attempts', {
          reply_to_message_id: messageId,
        });
        return;
      }

      // Switch to appropriate action for media type
      const action = mediaInfo.format === 'audio' ? "upload_voice" : "upload_video";
      await actionManager.start(action);

      // Download the media
      logger.info(`Downloading ${mediaInfo.format} from ${url}`, { ...logContext, requestId });
      const result = await withRetry(
        () => downloader.download(url, {
          maxFileSize: env.MAX_FILE_SIZE,
          timeout: env.DOWNLOAD_TIMEOUT,
          format: mediaInfo.format,
        }),
        {
          maxAttempts: 3,
          initialDelay: 3000,
          maxDelay: 20000,
        }
      );

      // Stop the action before processing result
      actionManager.stop();

      if (!result.success || !result.filePath || !result.mediaInfo) {
        const errorMessage = result.error || 'Unknown error';
        logger.error(`Failed to process media after retries: ${errorMessage}`, null, { ...logContext, requestId });
        await ctx.reply(`Failed to process media after several attempts: ${errorMessage}`, {
          reply_to_message_id: messageId,
        });
        return;
      }

      // Send the media with caption
      const mediaStream = new InputFile(createReadStream(result.filePath));

      // Get stream info
      const { stdout: ffprobeOutput } = await execAsync(`ffprobe -v quiet -print_format json -show_format -show_streams "${result.filePath}"`);
      const info = JSON.parse(ffprobeOutput) as FFprobeData;
      
      // Format stream info
      let videoWidth: number | undefined;
      let videoHeight: number | undefined;
      const streamInfo = info.streams.map((stream) => {
        if (stream.codec_type === 'audio') {
          // Try to get bitrate from stream, fallback to format bitrate
          const bitrate = stream.bit_rate 
            ? `${Math.round(parseInt(stream.bit_rate) / 1000)}kbps` 
            : info.format?.bit_rate 
              ? `${Math.round(parseInt(info.format.bit_rate) / 1000)}kbps` 
              : '';
          const freqNum = stream.sample_rate ? parseInt(stream.sample_rate) / 1000 : 0;
          const freq = freqNum ? `${freqNum % 1 ? freqNum.toFixed(1) : freqNum}kHz` : '';
          return `${stream.codec_name}${freq ? ` ${freq}` : ''}${bitrate ? ` ${bitrate}` : ''}`;
        }
        if (stream.codec_type === 'video') {
          const bitrate = stream.bit_rate 
            ? `${Math.round(parseInt(stream.bit_rate) / 1000)}kbps` 
            : info.format?.bit_rate 
              ? `${Math.round(parseInt(info.format.bit_rate) / 1000)}kbps` 
              : '';
          videoWidth = stream.width;
          videoHeight = stream.height;
          return `${stream.codec_name} ${stream.width}x${stream.height}${bitrate ? ` ${bitrate}` : ''}`;
        }
        return null;
      }).filter(Boolean).join(', ');

      // Get file size
      const fileSize = info.format?.size ? parseInt(info.format.size) : 0;
      const fileSizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(1) : '0';

      // Check file size before attempting to send
      if (fileSize > env.MAX_FILE_SIZE) {
        logger.warn(`File size ${fileSizeMB}MB exceeds limit of ${env.MAX_FILE_SIZE / 1024 / 1024}MB`, { ...logContext, requestId });
        await ctx.reply(
          `Sorry, this media file (${fileSizeMB}MB) exceeds Telegram's size limit (${env.MAX_FILE_SIZE / 1024 / 1024}MB). Try a shorter clip or lower quality version.`,
          { reply_to_message_id: messageId }
        );
        await downloader.cleanup(result.filePath);
        return;
      }

      // Escape special characters for MarkdownV2
      const escapedTitle = result.mediaInfo.title.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
      const escapedInfo = streamInfo.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
      const escapedSize = fileSizeMB.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

      const caption = [
        `\`${escapedTitle}\``,
        `\`${escapedInfo}${fileSize ? `, ${escapedSize}MB` : ''}\``,
      ].join('\n');

      logger.info(`Sending ${result.mediaInfo.format} to ${userInfo}`, { ...logContext, requestId });

      // Store format before the retry to ensure it's available
      const format = result.mediaInfo.format;
      
      // Send the media with retries
      await withRetry(
        async () => {
          if (format === 'audio') {
            await ctx.replyWithVoice(mediaStream, {
              caption,
              reply_to_message_id: messageId,
              parse_mode: 'MarkdownV2',
            });
          } else {
            // Download thumbnail if available
            let thumbnail: InputFile | undefined;
            if (result.mediaInfo?.thumbnail) {
              try {
                logger.info('Downloading thumbnail', { ...logContext, requestId, url: result.mediaInfo.thumbnail });
                const thumbnailPath = `${result.filePath}.thumb.jpg`;
                
                // Download and convert to JPEG in one step
                await execAsync(`ffmpeg -y -i "${result.mediaInfo.thumbnail}" "${thumbnailPath}"`);
                
                // Verify file exists and has size
                const stats = await statAsync(thumbnailPath);
                if (stats.size === 0) throw new Error('Thumbnail is empty');
                
                logger.info('Thumbnail downloaded successfully', { ...logContext, requestId, size: stats.size });
                thumbnail = new InputFile(createReadStream(thumbnailPath));
              } catch (error) {
                logger.warn('Failed to process thumbnail', { ...logContext, requestId, error });
                thumbnail = undefined;
              }
            } else {
              logger.debug('No thumbnail URL provided by yt-dlp', { ...logContext, requestId });
            }

            await ctx.replyWithVideo(mediaStream, {
              caption,
              reply_to_message_id: messageId,
              parse_mode: 'MarkdownV2',
              ...(thumbnail && { thumb: thumbnail }),
              ...(videoWidth && videoHeight && { width: videoWidth, height: videoHeight }),
            });

            // Clean up thumbnail if it was downloaded
            if (thumbnail) {
              try {
                await unlinkAsync(`${result.filePath}.thumb.jpg`);
              } catch (error) {
                logger.warn('Failed to cleanup thumbnail', { ...logContext, requestId, error });
              }
            }
          }
        },
        {
          maxAttempts: 4,
          initialDelay: 2000,
          maxDelay: 10000,
          retryableErrors: [
            'Network request',
            'ETIMEDOUT',
            'ECONNRESET',
            'ECONNREFUSED',
            'socket hang up',
            'getaddrinfo',
            // Don't retry file size errors
            /^(?!.*413: Request Entity Too Large).*$/,
          ],
        }
      );

      // Clean up
      await downloader.cleanup(result.filePath);
      logger.info(`Successfully processed media request for ${userInfo}`, { ...logContext, requestId });
    } catch (error) {
      logger.error(`Error processing message for ${userInfo}`, error, { ...logContext, requestId });
      try {
        let errorMessage = 'Sorry, something went wrong while processing your request.';
        
        // Only handle network errors now since we check file size proactively
        if (error instanceof Error && error.message.includes('Network request failed')) {
          errorMessage = 'Sorry, there was a network error. Please try again in a moment.';
        }
        
        await ctx.reply(errorMessage, {
          reply_to_message_id: messageId,
        });
      } catch (replyError) {
        logger.error('Failed to send error message', replyError, { ...logContext, requestId });
      }
    } finally {
      // Always ensure we stop any ongoing action
      actionManager.stop();
    }
  } catch (error) {
    logger.error('Error processing message', error, { ...logContext, requestId });
    try {
      let errorMessage = 'Sorry, something went wrong while processing your request.';
      
      // Only handle network errors now since we check file size proactively
      if (error instanceof Error && error.message.includes('Network request failed')) {
        errorMessage = 'Sorry, there was a network error. Please try again in a moment.';
      }
      
      await ctx.reply(errorMessage, {
        reply_to_message_id: messageId,
      });
    } catch (replyError) {
      logger.error('Failed to send error message', replyError, { ...logContext, requestId });
    }
  }
}
