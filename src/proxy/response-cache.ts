import crypto from "crypto";

export interface CachedResponse {
  data: any;
  timestamp: number;
}

export class ResponseCache {
  private cache = new Map<string, CachedResponse>();
  private readonly maxAgeMs = 1000 * 60 * 60; // 1 hour
  private readonly maxSize = 500;

  get(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.maxAgeMs) {
      this.cache.delete(key);
      return null;
    }
    return cached.data;
  }

  set(key: string, data: any): void {
    if (this.cache.size >= this.maxSize) {
      // LRU eviction (Map preserves insertion order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  generateKey(model: string, messages: any[]): string | null {
    try {
      const payload = JSON.stringify({ model, messages });
      return crypto.createHash("sha256").update(payload).digest("hex");
    } catch {
      return null;
    }
  }
}

export const responseCache = new ResponseCache();
