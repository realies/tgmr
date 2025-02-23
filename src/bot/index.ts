import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { handleMessage } from '../handlers/message.js';
import { mkdir } from 'fs/promises';
import { logger } from '../utils/logger.js';
import { getSupportedPlatforms } from '../utils/url.js';

export async function createBot(): Promise<Bot> {
  // Create tmp directory if it doesn't exist
  try {
    await mkdir('./tmp', { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  // Initialize bot
  const bot = new Bot(env.BOT_TOKEN);

  // Set up command handlers
  bot.command('start', (ctx) =>
    ctx.reply(
      "Hello! I can help you download media from various platforms. Just send me a link, and I'll reply with the media."
    )
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      `Send me a link from ${getSupportedPlatforms()}, and I'll download and send you the media.\n\n` +
        "For audio-only content, I'll send it as a voice message. For videos, I'll send them as video files. " +
        "For images, I'll send them in the highest quality available."
    )
  );

  // Handle all messages
  bot.on('message:text', async (ctx) => {
    try {
      const chatType = ctx.chat?.type;
      const messageText = ctx.message?.text;
      const chatId = ctx.chat?.id;

      // For group chats, check if bot can send messages
      if (chatType === 'group' || chatType === 'supergroup') {
        try {
          const botMember = await ctx.api.getChatMember(chatId!, ctx.me.id);
          const canSendMessages =
            botMember.status === 'administrator' ||
            ('can_send_messages' in botMember && botMember.can_send_messages);

          if (!canSendMessages) {
            logger.error(`Bot lacks message permissions in chat ${chatId}`);
            return;
          }
        } catch (permError) {
          logger.error('Failed to check bot permissions:', permError);
          return;
        }
      }

      // Process URLs
      if (messageText?.includes('http')) {
        try {
          await handleMessage(ctx);
        } catch (error) {
          logger.error('Error in handleMessage:', error);
          try {
            await ctx.reply('Sorry, there was an error processing your request. Please try again.');
          } catch (replyError) {
            logger.error('Failed to send error message:', replyError);
          }
        }
      }
    } catch (error) {
      logger.error('Error in message handler:', error);
    }
  });

  // Error handling
  bot.catch((err) => {
    logger.error('Unhandled error in bot:', err);
  });

  return bot;
}
