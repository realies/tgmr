const LEVEL_RANK = new Map([
  ['debug', 0],
  ['info', 1],
  ['warn', 2],
  ['error', 3],
]);

const ESSENTIAL_KEYS = new Set(['type', 'chat', 'from', 'msgId', 'requestId']);

class Logger {
  private static instance: Logger;
  private appName = 'tgmr';
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

  private formatMessage(level: string, message: string, context?: Record<string, unknown>): string {
    let formatted = `${this.appName} | ${level}:`;
    if (context) {
      const essentialContext = Object.entries(context)
        .filter(([key]) => ESSENTIAL_KEYS.has(key))
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      if (essentialContext) {
        formatted += ` [${essentialContext}]`;
      }
    }
    formatted += ` ${message}`;
    return formatted;
  }

  private colorize(level: string, message: string): string {
    const colors: Record<string, string> = {
      ERROR: '\x1b[31m',
      WARN: '\x1b[33m',
      INFO: '\x1b[36m',
      DEBUG: '\x1b[90m',
    };
    const color = colors[level] || colors.INFO;
    return `${color}${message}\x1b[0m`;
  }

  public info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('info')) return;
    process.stdout.write(
      this.colorize('INFO', this.formatMessage('INFO', message, context)) + '\n',
    );
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
    process.stderr.write(
      this.colorize('ERROR', this.formatMessage('ERROR', `${message}${errorDetails}`, context)) +
        '\n',
    );
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('warn')) return;
    process.stderr.write(
      this.colorize('WARN', this.formatMessage('WARN', message, context)) + '\n',
    );
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('debug')) return;
    process.stdout.write(
      this.colorize('DEBUG', this.formatMessage('DEBUG', message, context)) + '\n',
    );
  }
}

export const logger = Logger.getInstance();
