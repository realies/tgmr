class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] ${level}: ${message}`;
  }

  private colorize(level: string, message: string): string {
    // ANSI escape codes for colors
    const colors = {
      RESET: '\x1b[0m',
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m',  // Yellow
      INFO: '\x1b[36m',  // Cyan
    } as const;

    const color = colors[level as keyof typeof colors] || colors.INFO;
    return `${color}${message}${colors.RESET}`;
  }

  public info(message: string): void {
    const formattedMessage = this.formatMessage('INFO', message);
    console.log(this.colorize('INFO', formattedMessage));
  }

  public error(message: string, error?: unknown): void {
    const errorDetails = error instanceof Error ? `: ${error.message}\n${error.stack}` : '';
    const formattedMessage = this.formatMessage('ERROR', `${message}${errorDetails}`);
    console.error(this.colorize('ERROR', formattedMessage));
  }

  public warn(message: string): void {
    const formattedMessage = this.formatMessage('WARN', message);
    console.warn(this.colorize('WARN', formattedMessage));
  }
}

export const logger = Logger.getInstance();
