import winston from 'winston';

const sensitiveKeys = ['accessToken', 'refreshToken', 'password', 'secret', 'authorization', 'cookie'];

const redactSecrets = winston.format((info) => {
  const message = typeof info.message === 'string' ? info.message : '';
  let redacted = message;
  for (const key of sensitiveKeys) {
    const regex = new RegExp(`(${key}[\\s]*[:=][\\s]*)([^\\s,;}"']+)`, 'gi');
    redacted = redacted.replace(regex, '$1[REDACTED]');
  }
  info.message = redacted;
  return info;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    redactSecrets(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level.toUpperCase()}] ${stack || message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});
