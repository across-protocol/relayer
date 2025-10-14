export class Logger {
  private static formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const baseMessage = `[${timestamp}] [${level}] ${message}`;

    if (data) {
      return `${baseMessage} ${JSON.stringify(data)}`;
    }

    return baseMessage;
  }

  static info(message: string, data?: any): void {
    console.log(this.formatMessage("INFO", message, data));
  }

  static error(message: string, error?: Error | any): void {
    const errorData = error instanceof Error ? { message: error.message, stack: error.stack } : error;
    console.error(this.formatMessage("ERROR", message, errorData));
  }

  static warn(message: string, data?: any): void {
    console.warn(this.formatMessage("WARN", message, data));
  }

  static debug(message: string, data?: any): void {
    if (process.env.NODE_ENV !== "production") {
      console.debug(this.formatMessage("DEBUG", message, data));
    }
  }
}
