class Logger {
  private static instance: Logger;
  private static readonly LEVEL_RANK = new Map([
    ['debug', 0],
    ['info', 1],
    ['warn', 2],
    ['error', 3],
  ]);
  private appName = 'tgmr';
  private minRank: number;
  private logLevel: string;

  private constructor() {
    const envLogLevel = process.env.LOG_LEVEL?.toLowerCase();
    this.logLevel = envLogLevel && Logger.LEVEL_RANK.has(envLogLevel) ? envLogLevel : 'info';
    this.minRank = Logger.LEVEL_RANK.get(this.logLevel) ?? 1;
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(level: string): boolean {
    return (Logger.LEVEL_RANK.get(level.toLowerCase()) ?? 0) >= this.minRank;
  }

  private formatMessage(level: string, message: string, context?: Record<string, unknown>): string {
    let formatted = `${this.appName} | ${level}:`;
    if (context) {
      const essentialKeys = ['type', 'chat', 'from', 'msgId', 'requestId'];
      const essentialContext = Object.entries(context)
        .filter(([key]) => essentialKeys.includes(key))
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
    const formatted = this.formatMessage('INFO', message, context);
    process.stdout.write(this.colorize('INFO', formatted) + '\n');
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
    const formatted = this.formatMessage('ERROR', `${message}${errorDetails}`, context);
    process.stderr.write(this.colorize('ERROR', formatted) + '\n');
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('warn')) return;
    const formatted = this.formatMessage('WARN', message, context);
    process.stderr.write(this.colorize('WARN', formatted) + '\n');
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('debug')) return;
    const formatted = this.formatMessage('DEBUG', message, context);
    process.stdout.write(this.colorize('DEBUG', formatted) + '\n');
  }
}

export const logger = Logger.getInstance();
