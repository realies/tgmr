const LEVEL_RANK = new Map([
  ['debug', 0],
  ['info', 1],
  ['warn', 2],
  ['error', 3],
]);

const LEVEL_PAD: Record<string, string> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO ',
  WARN: 'WARN ',
  ERROR: 'ERROR',
};

const LEVEL_COLORS: Record<string, string> = {
  ERROR: '\x1b[31m',
  WARN: '\x1b[33m',
  INFO: '\x1b[36m',
  DEBUG: '\x1b[90m',
};

const RESET = '\x1b[0m';

class Logger {
  private static instance: Logger;
  private minRank: number;

  private constructor() {
    const envLogLevel = process.env.LOG_LEVEL?.toLowerCase();
    const validLevel = envLogLevel && LEVEL_RANK.has(envLogLevel) ? envLogLevel : 'info';
    this.minRank = LEVEL_RANK.get(validLevel) ?? 1;
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(level: string): boolean {
    return (LEVEL_RANK.get(level) ?? 0) >= this.minRank;
  }

  private formatContext(context?: Record<string, unknown>): string {
    if (!context) return '';
    const parts: string[] = [];
    if (context.chat) {
      const type = context.type === 'private' ? 'pm' : context.type === 'supergroup' ? 'sg' : 'grp';
      parts.push(`${type}:${context.chat}`);
    }
    if (context.msgId) parts.push(String(context.msgId));
    return parts.length > 0 ? ` [${parts.join(':')}]` : '';
  }

  private format(level: string, message: string, context?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const ctx = this.formatContext(context);
    return `${ts} ${LEVEL_PAD[level] || level}${ctx} ${message}`;
  }

  public info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('info')) return;
    const line = this.format('INFO', message, context);
    process.stdout.write(`${LEVEL_COLORS.INFO}${line}${RESET}\n`);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('error')) return;
    let errorDetails = '';
    const error = context?.error;
    if (error instanceof Error) {
      errorDetails = `: ${error.message}`;
    } else if (error) {
      errorDetails = `: ${String(error)}`;
    }
    const line = this.format('ERROR', `${message}${errorDetails}`, context);
    process.stderr.write(`${LEVEL_COLORS.ERROR}${line}${RESET}\n`);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('warn')) return;
    const line = this.format('WARN', message, context);
    process.stderr.write(`${LEVEL_COLORS.WARN}${line}${RESET}\n`);
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('debug')) return;
    const line = this.format('DEBUG', message, context);
    process.stdout.write(`${LEVEL_COLORS.DEBUG}${line}${RESET}\n`);
  }
}

export const logger = Logger.getInstance();
