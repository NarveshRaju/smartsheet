import { logger } from './logger.js';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000 } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status ?? error?.code;

      // Don't retry 4xx errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw error;
      }

      if (attempt === maxRetries) break;

      // Check for Retry-After header
      let delayMs: number;
      const retryAfter = error?.response?.headers?.['retry-after'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (!Number.isFinite(delayMs)) delayMs = baseDelayMs;
        if (delayMs > maxDelayMs) throw error; // Let the next scheduled sync retry instead of holding the lease.
        delayMs = Math.max(0, delayMs);
      } else {
        delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      }

      // Add jitter
      delayMs += Math.random() * 1000;

      logger.warn(`API call failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delayMs)}ms: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
