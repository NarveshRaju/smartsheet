import winston from 'winston';
import Transport from 'winston-transport';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  raw: string;
}

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

const MAX_BUFFER_SIZE = 1000;
const memoryLogBuffer: LogEntry[] = [];

class MemoryBufferTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit('logged', info));
    const timestamp = info.timestamp || new Date().toISOString().replace('T', ' ').slice(0, 19);
    const level = (info.level || 'info').toLowerCase() as LogEntry['level'];
    const message = info.stack || info.message || '';
    const raw = `${timestamp} [${level.toUpperCase()}] ${message}`;

    memoryLogBuffer.push({
      id: crypto.randomUUID(),
      timestamp,
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      raw,
    });

    if (memoryLogBuffer.length > MAX_BUFFER_SIZE) {
      memoryLogBuffer.shift();
    }

    callback();
  }
}

// Ensure logs directory exists
const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}
}

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
    new MemoryBufferTransport(),
  ],
});

export interface LogFilterOptions {
  limit?: number;
  level?: string;
  search?: string;
  configId?: string;
}

// Initialize buffer from combined.log if it exists
let fileHistoryLoaded = false;
function ensureHistoryLoaded() {
  if (fileHistoryLoaded) return;
  fileHistoryLoaded = true;
  const combinedLogPath = path.resolve(process.cwd(), 'logs/combined.log');
  if (fs.existsSync(combinedLogPath)) {
    try {
      const fileContent = fs.readFileSync(combinedLogPath, 'utf8');
      const lines = fileContent.trim().split('\n');
      const recentLines = lines.slice(-500);
      for (const line of recentLines) {
        if (!line.trim()) continue;
        const match = line.match(/^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\s\[(INFO|WARN|ERROR|DEBUG)\]\s(.*)$/i);
        if (match) {
          memoryLogBuffer.push({
            id: crypto.randomUUID(),
            timestamp: match[1],
            level: match[2].toLowerCase() as LogEntry['level'],
            message: match[3],
            raw: line,
          });
        } else {
          memoryLogBuffer.push({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
            level: 'info',
            message: line,
            raw: line,
          });
        }
      }
      if (memoryLogBuffer.length > MAX_BUFFER_SIZE) {
        memoryLogBuffer.splice(0, memoryLogBuffer.length - MAX_BUFFER_SIZE);
      }
    } catch {}
  }
}
ensureHistoryLoaded();

/**
 * Retrieve system logs from memory buffer and/or file, with search and level filters.
 */
export function getSystemLogs(options: LogFilterOptions = {}): { logs: LogEntry[]; total: number } {
  const { limit = 200, level, search, configId } = options;
  const targetLimit = Math.min(Math.max(1, limit), 1000);

  let allEntries: LogEntry[] = [...memoryLogBuffer];

  // Filter by level
  if (level && level.toLowerCase() !== 'all') {
    const lvl = level.toLowerCase();
    allEntries = allEntries.filter((e) => e.level === lvl);
  }

  // Filter by search keyword
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    allEntries = allEntries.filter(
      (e) => e.message.toLowerCase().includes(q) || e.timestamp.toLowerCase().includes(q)
    );
  }

  // Filter by configId
  if (configId && configId.trim()) {
    const cid = configId.trim();
    allEntries = allEntries.filter((e) => e.message.includes(cid));
  }

  const total = allEntries.length;
  // Return most recent first
  const logs = allEntries.slice(-targetLimit).reverse();

  return { logs, total };
}

/**
 * Clear in-memory log buffer
 */
export function clearSystemLogs(): void {
  memoryLogBuffer.length = 0;
}
