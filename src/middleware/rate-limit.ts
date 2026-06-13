import type { Context, Next } from "hono";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

const CAPACITY = 50; // max requests
const REFILL_RATE = 10; // requests per minute
const REFILL_INTERVAL_MS = 60000; // 1 minute

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
  // Rate limit by client IP or proxy_api_key (Bearer token)
  const authHeader = c.req.header("Authorization");
  const key = authHeader ? authHeader.replace("Bearer ", "").trim() : c.req.header("x-forwarded-for") || "unknown-ip";

  let bucket = buckets.get(key);
  if (!bucket) {
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
