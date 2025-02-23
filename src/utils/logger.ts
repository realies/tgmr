class Logger {
  private static instance: Logger;
  private appName = 'tgmr';
  private logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'; // Default to info level

  private constructor() {
    // Set log level from environment variable if present
    const envLogLevel = process.env.LOG_LEVEL?.toLowerCase();
    if (envLogLevel && ['debug', 'info', 'warn', 'error'].includes(envLogLevel)) {
      this.logLevel = envLogLevel as 'debug' | 'info' | 'warn' | 'error';
    }
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(level: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentLevel = levels.indexOf(this.logLevel);
    const messageLevel = levels.indexOf(level.toLowerCase());
    return messageLevel >= currentLevel;
  }

  private formatMessage(level: string, message: string, context?: Record<string, unknown>): string {
    let formattedMessage = `${this.appName} | ${level}:`;

    // Only add essential context
    if (context) {
      const essentialKeys = ['type', 'chat', 'from', 'msgId', 'requestId'];
      const essentialContext = Object.entries(context)
        .filter(([key]) => essentialKeys.includes(key))
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      if (essentialContext) {
        formattedMessage += ` [${essentialContext}]`;
      }
    }

    formattedMessage += ` ${message}`;
    return formattedMessage;
  }

  private colorize(level: string, message: string): string {
    const colors = {
      RESET: '\x1b[0m',
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m', // Yellow
      INFO: '\x1b[36m', // Cyan
      DEBUG: '\x1b[90m', // Gray
    } as const;

    const color = colors[level as keyof typeof colors] || colors.INFO;
    return `${color}${message}${colors.RESET}`;
  }

  public info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('info')) return;
    const formattedMessage = this.formatMessage('INFO', message, context);
    process.stdout.write(this.colorize('INFO', formattedMessage) + '\n');
  }

  public error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    if (!this.shouldLog('error')) return;
    let errorDetails = '';
    if (error instanceof Error) {
      errorDetails = `: ${error.message}`;
    } else if (error) {
      errorDetails = `: ${String(error)}`;
    }

    const formattedMessage = this.formatMessage('ERROR', `${message}${errorDetails}`, context);
    console.error(this.colorize('ERROR', formattedMessage));
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('warn')) return;
    const formattedMessage = this.formatMessage('WARN', message, context);
    console.warn(this.colorize('WARN', formattedMessage));
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('debug')) return;
    const formattedMessage = this.formatMessage('DEBUG', message, context);
    process.stdout.write(this.colorize('DEBUG', formattedMessage) + '\n');
  }
}

export const logger = Logger.getInstance();
