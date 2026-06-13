/**
 * Analytics — lightweight time-series request/usage tracking for dashboard.
 *
 * Tracks:
 *   - Requests per minute (RPM) over a sliding window
 *   - Tokens consumed per model
 *   - Latency percentiles (p50, p95, p99)
 *   - Error rate over time
 *   - Per-model breakdown
 *
 * In-memory only (no disk persistence). Retains last 60 minutes of data
 * at per-minute granularity for dashboard display.
 */

export interface MinuteBucket {
  timestamp: number; // minute boundary (ms)
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencies: number[]; // TTFT in ms (capped at 100 samples per minute)
  models: Map<string, { requests: number; tokens: number }>;
}

export interface AnalyticsSummary {
  /** Requests in last N minutes */
  rpm_1m: number;
  rpm_5m: number;
  rpm_60m: number;
  /** Error rate (0-1) */
  error_rate_5m: number;
  /** Token totals in last 60 minutes */
  tokens_60m: { input: number; output: number; cached: number };
  /** Latency percentiles from last 5 minutes (ms) */
  latency_p50: number | null;
  latency_p95: number | null;
  latency_p99: number | null;
  /** Top models by request count (last 60 minutes) */
  top_models: Array<{ model: string; requests: number; tokens: number }>;
  /** Current minute timestamp */
  current_minute: number;
}

const RETENTION_MINUTES = 60;
const MAX_LATENCY_SAMPLES_PER_MINUTE = 100;

export class Analytics {
  private buckets: Map<number, MinuteBucket> = new Map();

  /** Get or create a minute bucket for the given timestamp. */
  private getBucket(nowMs: number = Date.now()): MinuteBucket {
    const minute = Math.floor(nowMs / 60_000) * 60_000;
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      bucket = {
        timestamp: minute,
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        latencies: [],
        models: new Map(),
      };
      this.buckets.set(minute, bucket);
      this.cleanup(nowMs);
    }
    return bucket;
  }

  /** Record a completed request. */
  recordRequest(params: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    latencyMs?: number;
    isError?: boolean;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    const bucket = this.getBucket(nowMs);

    bucket.requests++;
    if (params.isError) bucket.errors++;
    if (params.inputTokens) bucket.inputTokens += params.inputTokens;
    if (params.outputTokens) bucket.outputTokens += params.outputTokens;
    if (params.cachedTokens) bucket.cachedTokens += params.cachedTokens;

    if (params.latencyMs !== undefined && bucket.latencies.length < MAX_LATENCY_SAMPLES_PER_MINUTE) {
      bucket.latencies.push(params.latencyMs);
    }

    const modelStats = bucket.models.get(params.model) ?? { requests: 0, tokens: 0 };
    modelStats.requests++;
    modelStats.tokens += (params.inputTokens ?? 0) + (params.outputTokens ?? 0);
    bucket.models.set(params.model, modelStats);
  }

  /** Get summary analytics for the dashboard. */
  getSummary(nowMs: number = Date.now()): AnalyticsSummary {
    const currentMinute = Math.floor(nowMs / 60_000) * 60_000;

    // Collect buckets for different windows
    let rpm_1m = 0;
    let requests_5m = 0;
    let errors_5m = 0;
    let requests_60m = 0;
    let tokens_60m = { input: 0, output: 0, cached: 0 };
    const latencies_5m: number[] = [];
    const modelAgg = new Map<string, { requests: number; tokens: number }>();

    for (const [ts, bucket] of this.buckets) {
      const ageMinutes = (currentMinute - ts) / 60_000;
      if (ageMinutes > RETENTION_MINUTES) continue;

      if (ageMinutes <= 1) rpm_1m += bucket.requests;
      if (ageMinutes <= 5) {
        requests_5m += bucket.requests;
        errors_5m += bucket.errors;
        latencies_5m.push(...bucket.latencies);
      }
      requests_60m += bucket.requests;
      tokens_60m.input += bucket.inputTokens;
      tokens_60m.output += bucket.outputTokens;
      tokens_60m.cached += bucket.cachedTokens;

      for (const [model, stats] of bucket.models) {
        const agg = modelAgg.get(model) ?? { requests: 0, tokens: 0 };
        agg.requests += stats.requests;
        agg.tokens += stats.tokens;
        modelAgg.set(model, agg);
      }
    }

    // Calculate latency percentiles
    latencies_5m.sort((a, b) => a - b);
    const p = (pct: number): number | null => {
      if (latencies_5m.length === 0) return null;
      const idx = Math.min(Math.floor(latencies_5m.length * pct), latencies_5m.length - 1);
      return latencies_5m[idx];
    };

    // Top models by request count
    const topModels = [...modelAgg.entries()]
      .sort((a, b) => b[1].requests - a[1].requests)
      .slice(0, 10)
      .map(([model, stats]) => ({ model, ...stats }));

    return {
      rpm_1m,
      rpm_5m: Math.round(requests_5m / 5),
      rpm_60m: Math.round(requests_60m / 60),
      error_rate_5m: requests_5m > 0 ? errors_5m / requests_5m : 0,
      tokens_60m,
      latency_p50: p(0.5),
      latency_p95: p(0.95),
      latency_p99: p(0.99),
      top_models: topModels,
      current_minute: currentMinute,
    };
  }

  /** Get per-minute time series for charting (last N minutes). */
  getTimeSeries(minutes: number = 60, nowMs: number = Date.now()): Array<{
    timestamp: number;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
  }> {
    const currentMinute = Math.floor(nowMs / 60_000) * 60_000;
    const result: Array<{
      timestamp: number;
      requests: number;
      errors: number;
      inputTokens: number;
      outputTokens: number;
    }> = [];

    for (let i = minutes - 1; i >= 0; i--) {
      const ts = currentMinute - i * 60_000;
      const bucket = this.buckets.get(ts);
      result.push({
        timestamp: ts,
        requests: bucket?.requests ?? 0,
        errors: bucket?.errors ?? 0,
        inputTokens: bucket?.inputTokens ?? 0,
        outputTokens: bucket?.outputTokens ?? 0,
      });
    }

    return result;
  }

  /** Remove expired buckets. */
  private cleanup(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MINUTES * 60_000;
    for (const [ts] of this.buckets) {
      if (ts < cutoff) this.buckets.delete(ts);
    }
  }

  /** Clear all data. */
  clear(): void {
    this.buckets.clear();
  }
}

/** Singleton */
let _singleton: Analytics | null = null;

export function getAnalytics(): Analytics {
  if (!_singleton) _singleton = new Analytics();
  return _singleton;
}

export function _resetAnalyticsForTests(): void {
  _singleton = null;
}
