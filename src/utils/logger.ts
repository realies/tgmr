class Logger {
  private static instance: Logger;
  private appName = 'tgmr';

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: string, message: string, context?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    let formattedMessage = `${this.appName} | [${timestamp}] ${level}:`;

    // Add context if provided
    if (context) {
      const contextStr = Object.entries(context)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      formattedMessage += ` [${contextStr}]`;
    }

    formattedMessage += ` ${message}`;
    return formattedMessage;
  }

  private colorize(level: string, message: string): string {
    // ANSI escape codes for colors
    const colors = {
      RESET: '\x1b[0m',
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m',  // Yellow
      INFO: '\x1b[36m',  // Cyan
      DEBUG: '\x1b[90m', // Gray
    } as const;

    const color = colors[level as keyof typeof colors] || colors.INFO;
    return `${color}${message}${colors.RESET}`;
  }

  public info(message: string, context?: Record<string, unknown>): void {
    const formattedMessage = this.formatMessage('INFO', message, context);
    console.log(this.colorize('INFO', formattedMessage));
  }

  public error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    let errorDetails = '';
    if (error instanceof Error) {
      errorDetails = `: ${error.message}`;
      if (error.stack) {
        errorDetails += `\n${error.stack}`;
      }
    } else if (error) {
      errorDetails = `: ${String(error)}`;
    }

    const formattedMessage = this.formatMessage('ERROR', `${message}${errorDetails}`, context);
    console.error(this.colorize('ERROR', formattedMessage));
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    const formattedMessage = this.formatMessage('WARN', message, context);
    console.warn(this.colorize('WARN', formattedMessage));
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    const formattedMessage = this.formatMessage('DEBUG', message, context);
    console.debug(this.colorize('DEBUG', formattedMessage));
  }
}

export const logger = Logger.getInstance();
