import winston from 'winston';

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'google-scanner' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Service-specific logger creators
export function createServiceLogger(serviceName: string) {
  return {
    info: (message: string, metadata?: any) => {
      const enriched = { service: serviceName, ...metadata };
      logger.info(message, enriched);
    },
    warn: (message: string, metadata?: any) => {
      const enriched = { service: serviceName, ...metadata };
      logger.warn(message, enriched);
    },
    error: (message: string, error?: Error | any, metadata?: any) => {
      logger.error(message, {
        service: serviceName,
        error: error?.message || error,
        stack: error?.stack,
        ...metadata
      });
    },
    debug: (message: string, metadata?: any) => {
      const enriched = { service: serviceName, ...metadata };
      logger.debug(message, enriched);
    },
  };
}

// Pre-configured service loggers
export const driveLogger = createServiceLogger('drive-scanner');
export const sheetsLogger = createServiceLogger('sheets-scanner');
export const inviteLogger = createServiceLogger('auto-invite');
export const backgroundLogger = createServiceLogger('background-processor');

// Progress logger for long-running operations
export class ProgressLogger {
  private startTime: Date;
  private serviceName: string;
  private operation: string;
  private total?: number;

  constructor(serviceName: string, operation: string, total?: number) {
    this.serviceName = serviceName;
    this.operation = operation;
    this.total = total;
    this.startTime = new Date();

    const serviceLogger = createServiceLogger(serviceName);
    serviceLogger.info(`Starting ${operation}`, {
      total: this.total,
      startTime: this.startTime
    });
  }

  progress(current: number, message?: string): void {
    const serviceLogger = createServiceLogger(this.serviceName);
    const elapsed = Date.now() - this.startTime.getTime();
    const percentage = this.total ? Math.round((current / this.total) * 100) : undefined;

    serviceLogger.info(`${this.operation} progress`, {
      current,
      total: this.total,
      percentage,
      elapsed,
      message,
    });
  }

  complete(message?: string): void {
    const serviceLogger = createServiceLogger(this.serviceName);
    const elapsed = Date.now() - this.startTime.getTime();

    serviceLogger.info(`${this.operation} completed`, {
      elapsed,
      endTime: new Date(),
      message,
    });
  }

  error(error: Error, message?: string): void {
    const serviceLogger = createServiceLogger(this.serviceName);
    const elapsed = Date.now() - this.startTime.getTime();

    serviceLogger.error(`${this.operation} failed`, error, {
      elapsed,
      endTime: new Date(),
      message,
    });
  }
}

// Export the main logger for direct use
export { logger };
