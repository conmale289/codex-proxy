import crypto from "crypto";

export interface CachedResponse {
  data: any;
  timestamp: number;
  byteSize: number;
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB

export class ResponseCache {
  private cache = new Map<string, CachedResponse>();
  private readonly maxAgeMs = 1000 * 60 * 60; // 1 hour
  private readonly maxSize = 500;
  private totalBytes = 0;

  get(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.maxAgeMs) {
      this.totalBytes -= cached.byteSize;
      this.cache.delete(key);
      return null;
    }
    return cached.data;
  }

  set(key: string, data: any): void {
    const byteSize = estimateBytes(data);
    // Skip caching excessively large individual responses (>5MB)
    if (byteSize > 5 * 1024 * 1024) return;

    // Evict until under byte cap
    while (this.totalBytes + byteSize > MAX_TOTAL_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const evicted = this.cache.get(oldestKey);
      if (evicted) this.totalBytes -= evicted.byteSize;
      this.cache.delete(oldestKey);
    }

    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const evicted = this.cache.get(oldestKey);
        if (evicted) this.totalBytes -= evicted.byteSize;
        this.cache.delete(oldestKey);
      }
    }
    this.totalBytes += byteSize;
    this.cache.set(key, { data, timestamp: Date.now(), byteSize });
  }

  generateKey(model: string, messages: any[]): string | null {
    try {
      const payload = JSON.stringify({ model, messages });
      return crypto.createHash("sha256").update(payload).digest("hex");
    } catch {
      return null;
    }
  }

  /** Current total cached bytes (for monitoring). */
  get bytes(): number { return this.totalBytes; }
  get size(): number { return this.cache.size; }
}

function estimateBytes(data: unknown): number {
  try {
    return JSON.stringify(data).length * 2; // rough UTF-16 estimate
  } catch {
    return 1024; // fallback
  }
}

export const responseCache = new ResponseCache();
