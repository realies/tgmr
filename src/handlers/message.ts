import { Context, InputFile } from 'grammy';
import { isValidUrl, isSupportedPlatform } from '../utils/url.js';
import { MediaDownloader } from '../services/downloader.js';
import { env } from '../config/env.js';
import { createReadStream, stat } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const execAsync = promisify(exec);
const statAsync = promisify(stat);

type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note';

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
        this.sendActionWithRetry(action).catch((error) => {
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
    await withRetry(() => this.ctx.api.sendChatAction(this.chatId, action), {
      maxAttempts: 5,
      initialDelay: 500,
      maxDelay: 5000,
    });
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
    msgId: messageId,
  };

  /**
   * Normalizes line breaks in text to have at most one empty line between content
   */
  function normalizeLineBreaks(text: string): string {
    return text
      .replace(/\r\n/g, '\n') // Normalize Windows line endings
      .replace(/^\s*(.)\s*$/gm, (match, _) => {
        // Keep lines that aren't just a single character with optional whitespace
        return match.trim().length > 1 ? match : '';
      }) // Remove lines containing only a single character
      .replace(/(\n\s*(.)\s*\n\s*\2\s*\n\s*)+/g, '\n') // Replace repeating single-character lines with single newline
      .replace(/\n\s*\n+/g, '\n') // Replace multiple newlines with single newline
      .trim();
  }

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
      await actionManager.start('typing');

      // Get media info first to determine format
      logger.info('Fetching media info...', { ...logContext, requestId });
      const mediaInfo = await withRetry(() => downloader.getMediaInfo(url), {
        maxAttempts: 5,
        initialDelay: 2000,
        maxDelay: 15000,
      });

      if (!mediaInfo) {
        actionManager.stop();
        logger.warn('Failed to get media information after retries', { ...logContext, requestId });
        await ctx.reply('Failed to get media information after several attempts', {
          reply_to_message_id: messageId,
        });
        return;
      }

      // Switch to appropriate action for media type
      const action =
        mediaInfo.format === 'audio'
          ? 'upload_voice'
          : mediaInfo.format === 'image'
            ? 'upload_photo'
            : 'upload_video';
      await actionManager.start(action);

      // Download the media
      logger.info(`Downloading ${mediaInfo.format} from ${url}`, { ...logContext, requestId });
      const result = await withRetry(
        () =>
          downloader.download(url, {
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

      if (!result.success || result.filePaths.length === 0 || !result.mediaInfo) {
        const errorMessage = result.error || 'Unknown error';
        logger.error(`Failed to process media after retries: ${errorMessage}`, null, {
          ...logContext,
          requestId,
        });
        await ctx.reply(`Failed to process media after several attempts: ${errorMessage}`, {
          reply_to_message_id: messageId,
        });
        return;
      }

      // Get stream info for each file
      const mediaInfos = await Promise.all(
        result.filePaths.map(async (path) => {
          const { stdout: ffprobeOutput } = await execAsync(
            `ffprobe -v quiet -print_format json -show_format -show_streams "${path}"`
          );
          return JSON.parse(ffprobeOutput) as FFprobeData;
        })
      );

      // Format stream info for each file
      const mediaItems = await Promise.all(
        result.filePaths.map(async (path, index) => {
          const info = mediaInfos[index];
          const isVideo = path.endsWith('.mp4');
          let thumbnail: InputFile | undefined;

          if (isVideo) {
            try {
              logger.debug('Creating thumbnail for video', { ...logContext, requestId, path });
              const thumbnailPath = `${path}.thumb.jpg`;

              // Extract first frame as thumbnail
              await execAsync(`ffmpeg -y -i "${path}" -vframes 1 "${thumbnailPath}"`);

              // Verify file exists and has size
              const stats = await statAsync(thumbnailPath);
              if (stats.size === 0) throw new Error('Thumbnail is empty');

              logger.debug('Thumbnail created successfully', {
                ...logContext,
                requestId,
                size: stats.size,
              });
              thumbnail = new InputFile(createReadStream(thumbnailPath));
            } catch (error) {
              logger.warn('Failed to create thumbnail', { ...logContext, requestId, error });
            }
          }

          let videoWidth: number | undefined;
          let videoHeight: number | undefined;
          const streamInfo = info.streams
            .map((stream) => {
              if (stream.codec_type === 'video') {
                videoWidth = stream.width;
                videoHeight = stream.height;
                // For images, only show codec and dimensions
                if (!isVideo) {
                  return `${stream.codec_name} ${stream.width}x${stream.height}`;
                }
                // For videos, include bitrate
                const bitrate = stream.bit_rate
                  ? `${Math.round(parseInt(stream.bit_rate) / 1000)}kbps`
                  : info.format?.bit_rate
                    ? `${Math.round(parseInt(info.format.bit_rate) / 1000)}kbps`
                    : '';
                return `${stream.codec_name} ${stream.width}x${stream.height}${bitrate ? ` ${bitrate}` : ''}`;
              } else if (stream.codec_type === 'audio') {
                const bitrate = stream.bit_rate
                  ? `${Math.round(parseInt(stream.bit_rate) / 1000)}kbps`
                  : info.format?.bit_rate
                    ? `${Math.round(parseInt(info.format.bit_rate) / 1000)}kbps`
                    : '';
                const sampleRate = stream.sample_rate
                  ? `${Math.round(parseInt(stream.sample_rate) / 1000)}kHz`
                  : '';
                return `${stream.codec_name}${bitrate ? ` ${bitrate}` : ''}${sampleRate ? ` ${sampleRate}` : ''}`;
              }
              return null;
            })
            .filter(Boolean)
            .join(', ');

          // Get file size
          const fileSize = info.format?.size ? parseInt(info.format.size) : 0;
          const fileSizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(1) : '0';

          // Check file size before attempting to send
          if (fileSize > env.MAX_FILE_SIZE) {
            logger.warn(
              `File size ${fileSizeMB}MB exceeds limit of ${env.MAX_FILE_SIZE / 1024 / 1024}MB`,
              { ...logContext, requestId }
            );
            throw new Error(
              `Media file (${fileSizeMB}MB) exceeds Telegram's size limit (${env.MAX_FILE_SIZE / 1024 / 1024}MB)`
            );
          }

          return {
            path,
            isVideo,
            thumbnail,
            videoWidth,
            videoHeight,
            streamInfo,
            fileSizeMB,
          };
        })
      );

      // Escape special characters for MarkdownV2
      const escapedTitle = normalizeLineBreaks(result.mediaInfo.title).replace(
        /[_*[\]()~`>#+\-=|{}.!]/g,
        '\\$&'
      );
      const escapedUrl = url.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

      // Create a summary for multiple files
      let caption: string;
      if (mediaItems.length > 1) {
        // Split into chunks of 10 (Telegram's limit)
        const chunkSize = 10;
        for (let i = 0; i < mediaItems.length; i += chunkSize) {
          const chunk = mediaItems.slice(i, i + chunkSize);

          // Group files by type and format
          const imageFormats = new Map<string, { count: number; dimensions: string }>();
          const videoFormats = new Map<
            string,
            { count: number; dimensions: string; codec: string }
          >();
          let chunkTotalSize = 0;

          chunk.forEach((item) => {
            if (item.isVideo) {
              const [codec, dimensions] = item.streamInfo.split(' ');
              const key = `${dimensions}`; // Use dimensions as key to group by resolution
              const existing = videoFormats.get(key) || { count: 0, dimensions, codec };
              videoFormats.set(key, { ...existing, count: existing.count + 1 });
            } else {
              const dimensions = item.streamInfo;
              const key = dimensions;
              const existing = imageFormats.get(key) || { count: 0, dimensions };
              imageFormats.set(key, { ...existing, count: existing.count + 1 });
            }
            chunkTotalSize += parseFloat(item.fileSizeMB);
          });

          const formatSummary = [];
          if (imageFormats.size > 0) {
            const imageSummary = Array.from(imageFormats.entries())
              .map(([_, info]) => {
                const [codec, dimensions] = info.dimensions.split(' ');
                return `${info.count} ${codec} image${info.count > 1 ? 's' : ''} at ${dimensions}`;
              })
              .join(', ');
            formatSummary.push(imageSummary);
          }
          if (videoFormats.size > 0) {
            const videoSummary = Array.from(videoFormats.entries())
              .map(
                ([_, info]) =>
                  `${info.count} ${info.codec} video${info.count > 1 ? 's' : ''} at ${info.dimensions}`
              )
              .join(', ');
            formatSummary.push(videoSummary);
          }

          const escapedSummary = formatSummary
            .join(', ')
            .replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
          const escapedSize = chunkTotalSize.toFixed(1).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

          // Create chunk-specific caption
          const chunkCaption =
            i === 0
              ? `[${escapedTitle}](${escapedUrl})\n` +
                `\`${escapedSummary}, ${escapedSize}MB total\``
              : `\`${escapedSummary}, ${escapedSize}MB total\``;

          // Send as media group for multiple items
          const mediaGroup = chunk.map((item, index) => {
            if (item.isVideo) {
              return {
                type: 'video' as const,
                media: new InputFile(createReadStream(item.path)),
                ...(index === 0
                  ? {
                      caption: chunkCaption,
                      parse_mode: 'MarkdownV2' as const,
                    }
                  : {}),
                ...(item.thumbnail && { thumb: item.thumbnail }),
                ...(item.videoWidth &&
                  item.videoHeight && {
                    width: item.videoWidth,
                    height: item.videoHeight,
                  }),
              };
            } else {
              return {
                type: 'photo' as const,
                media: new InputFile(createReadStream(item.path)),
                ...(index === 0
                  ? {
                      caption: chunkCaption,
                      parse_mode: 'MarkdownV2' as const,
                    }
                  : {}),
              };
            }
          });
          await ctx.replyWithMediaGroup(mediaGroup, {
            reply_to_message_id: messageId,
          });
        }
      } else {
        // Single file - use detailed info
        const escapedInfo = mediaItems[0].streamInfo.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
        const escapedSize = mediaItems[0].fileSizeMB.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

        caption = [`[${escapedTitle}](${escapedUrl})`, `\`${escapedInfo}, ${escapedSize}MB\``].join(
          '\n'
        );

        const item = mediaItems[0];
        if (result.mediaInfo.format === 'audio') {
          await ctx.replyWithVoice(new InputFile(createReadStream(item.path)), {
            caption,
            reply_to_message_id: messageId,
            parse_mode: 'MarkdownV2',
          });
        } else if (item.isVideo) {
          await ctx.replyWithVideo(new InputFile(createReadStream(item.path)), {
            caption,
            reply_to_message_id: messageId,
            parse_mode: 'MarkdownV2',
            ...(item.thumbnail && { thumb: item.thumbnail }),
            ...(item.videoWidth &&
              item.videoHeight && {
                width: item.videoWidth,
                height: item.videoHeight,
              }),
          });
        } else {
          await ctx.replyWithPhoto(new InputFile(createReadStream(item.path)), {
            caption,
            reply_to_message_id: messageId,
            parse_mode: 'MarkdownV2',
          });
        }
      }

      // Clean up all files including thumbnails
      await Promise.all(
        mediaItems.flatMap(async (item) => {
          const files = [item.path];
          if (item.isVideo) {
            files.push(`${item.path}.thumb.jpg`);
          }
          return Promise.all(
            files.map((file) =>
              downloader
                .cleanup(file)
                .catch((error) =>
                  logger.warn('Failed to cleanup file', { ...logContext, requestId, file, error })
                )
            )
          );
        })
      );
      logger.debug(`Successfully processed media request for ${userInfo}`, {
        ...logContext,
        requestId,
      });
    } catch (error) {
      logger.error('Failed to process media request', error);
      await ctx.reply('Failed to process media request', {
        reply_to_message_id: messageId,
      });
    }
  } catch (error) {
    logger.error('Failed to process message', error);
    await ctx.reply('Failed to process message');
  }
}
