import { Context } from 'grammy';
import { logger } from './logger.js';
import { withRetry } from './retry.js';

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'upload_video'
  | 'upload_voice'
  | 'upload_document';

/**
 * Manages Telegram chat action indicators (typing, uploading, etc.)
 * with automatic periodic refresh using setTimeout recursion to
 * prevent overlapping retry chains.
 */
export class ChatActionManager {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(
    private ctx: Context,
    private chatId: number,
  ) {}

  async start(action: ChatAction): Promise<void> {
    this.stop();
    this.stopped = false;
    try {
      await this.sendAction(action);
    } catch (error) {
      logger.error('Failed to start chat action', { error });
      return;
    }
    this.scheduleNext(action);
  }

  private scheduleNext(action: ChatAction): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      if (this.inFlight || this.stopped) return;
      this.inFlight = true;
      try {
        await this.sendAction(action);
      } catch (error) {
        if (!(error instanceof Error) || !error.message?.includes('Network request')) {
          logger.error('Failed to send chat action', { error });
        }
      } finally {
        this.inFlight = false;
        if (!this.stopped) this.scheduleNext(action);
      }
    }, 1000);
  }

  private async sendAction(action: ChatAction): Promise<void> {
    await withRetry(() => this.ctx.api.sendChatAction(this.chatId, action), {
      maxAttempts: 5,
      initialDelay: 500,
      maxDelay: 3000,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
