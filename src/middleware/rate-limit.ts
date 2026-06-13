import type { Context, Next } from "hono";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

const CAPACITY = 50; // max requests
const REFILL_RATE = 10; // requests per minute
const REFILL_INTERVAL_MS = 60000; // 1 minute

/** Maximum age (ms) before a stale bucket is evicted — prevents unbounded memory growth. */
const BUCKET_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
/** How often to run GC sweep. */
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUCKETS = 10_000; // hard cap to prevent OOM under attack

let gcTimer: ReturnType<typeof setInterval> | null = null;

function startGcTimer(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > BUCKET_MAX_AGE_MS) {
        buckets.delete(key);
      }
    }
  }, GC_INTERVAL_MS);
  gcTimer.unref();
}

function refill(bucket: TokenBucket): void {
  const now = Date.now();
  const timePassed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(timePassed / REFILL_INTERVAL_MS) * REFILL_RATE;
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }
}

export async function rateLimit(c: Context, next: Next): Promise<void | Response> {
  startGcTimer();

  // Rate limit by client IP or proxy_api_key (Bearer token)
  const authHeader = c.req.header("Authorization");
  const key = authHeader ? authHeader.replace("Bearer ", "").trim() : c.req.header("x-forwarded-for") || "unknown-ip";

  let bucket = buckets.get(key);
  if (!bucket) {
    // Hard cap: evict oldest if we're at limit (prevents memory exhaustion under attack)
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { tokens: CAPACITY, lastRefill: Date.now() };
    buckets.set(key, bucket);
  }

  refill(bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    await next();
  } else {
    c.status(429);
    return c.json({
      error: {
        message: "Too many requests. Proxy API Key / IP rate limit exceeded.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded"
      }
    });
  }
}
