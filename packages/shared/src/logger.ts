import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export function createLogger(opts: Partial<LoggerOptions> = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';
  const options: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        '*.password',
        '*.apiKey',
        '*.token',
        '*.refreshToken',
        '*.refresh_token',
        '*.access_token',
        '*.clientSecret',
        'headers.authorization',
      ],
      censor: '[redacted]',
    },
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: false, ignore: 'pid,hostname' },
          },
        }
      : {}),
    ...opts,
  };
  return pino(options);
}

export const logger = createLogger();
