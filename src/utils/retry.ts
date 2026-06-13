import { CodexApiError } from "../proxy/codex-api.js";

/** Retry a function on retryable errors with exponential backoff + jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxRetries = 2,
    baseDelayMs = 1000,
    tag = "Proxy",
  }: { maxRetries?: number; baseDelayMs?: number; tag?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        (err instanceof CodexApiError && err.status >= 500 && err.status < 600) ||
        (err instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(err.message));
      if (!isRetryable || attempt === maxRetries) throw err;
      // Exponential backoff with ±25% jitter to prevent thundering herd
      const baseDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = baseDelay * (0.75 + Math.random() * 0.5);
      const delay = Math.round(jitter);
      console.warn(
        `[${tag}] Retrying after ${err instanceof CodexApiError ? err.status : "network error"} (attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
