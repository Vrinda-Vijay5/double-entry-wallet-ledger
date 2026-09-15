import pino from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export const logger = pino({
  level,
  // Never let a password, hash, or bearer token reach the log sink.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'refreshToken',
      '*.refreshToken',
      'accessToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  base: { service: 'ledger-api' },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;
