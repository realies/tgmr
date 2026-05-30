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
  private stopped = false;
  // Bumped on every start()/stop() so a tick scheduled by a previous run bails
  // instead of orphaning a parallel timer chain when start() is called again.
  private generation = 0;

  constructor(
    private ctx: Context,
    private chatId: number,
  ) {}

  async start(action: ChatAction): Promise<void> {
    this.stop();
    this.stopped = false;
    const gen = ++this.generation;
    try {
      await this.ctx.api.sendChatAction(this.chatId, action);
    } catch (error) {
      logger.debug('Failed to start chat action', { error });
      return;
    }
    this.scheduleNext(action, gen);
  }

  private scheduleNext(action: ChatAction, gen: number): void {
    if (this.stopped || gen !== this.generation) return;
    this.timer = setTimeout(async () => {
      if (this.stopped || gen !== this.generation) return;
      try {
        await this.ctx.api.sendChatAction(this.chatId, action);
      } catch {
        // Best-effort cosmetic signal — failures are non-critical
      } finally {
        if (!this.stopped && gen === this.generation) this.scheduleNext(action, gen);
      }
      // 4s — Telegram displays chat actions for ~5s, so this refreshes
      // just before expiry while using 5x fewer API calls than 1s ticks
    }, 4000);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
