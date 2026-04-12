import { Context } from 'grammy';
import { logger } from './logger.js';

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'upload_video'
  | 'upload_voice'
  | 'upload_document';

/**
 * Manages Telegram chat action indicators (typing, uploading, etc.)
 * with automatic periodic refresh. Uses best-effort sends for ticks
 * since chat actions are cosmetic signals.
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
      await this.ctx.api.sendChatAction(this.chatId, action);
    } catch (error) {
      logger.debug('Failed to start chat action', { error });
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
        await this.ctx.api.sendChatAction(this.chatId, action);
      } catch {
        // Best-effort cosmetic signal — failures are non-critical
      } finally {
        this.inFlight = false;
        if (!this.stopped) this.scheduleNext(action);
      }
    }, 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
