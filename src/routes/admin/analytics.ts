/**
 * Analytics admin routes — expose request/usage time-series data for dashboard.
 */

import { Hono } from "hono";
import { getAnalytics } from "../../logs/analytics.js";
import { getPromptCacheTracker } from "../../proxy/prompt-cache-tracker.js";
import { getAllModelFallbackStates } from "../../proxy/model-fallback.js";
import { getDedupInFlightCount } from "../../proxy/request-dedup.js";
import { getBatchQueue } from "../../proxy/batch-queue.js";

export function createAnalyticsRoutes(): Hono {
  const app = new Hono();

  /** Summary analytics — RPM, error rate, latency percentiles, top models. */
  app.get("/admin/analytics", (c) => {
    const summary = getAnalytics().getSummary();
    return c.json(summary);
  });

  /** Time-series data for charts (per-minute buckets). */
  app.get("/admin/analytics/timeseries", (c) => {
    const minutesRaw = c.req.query("minutes");
    const minutes = minutesRaw ? Math.min(parseInt(minutesRaw, 10) || 60, 60) : 60;
    const timeSeries = getAnalytics().getTimeSeries(minutes);
    return c.json(timeSeries);
  });

  /** Prompt cache statistics and optimization suggestions. */
  app.get("/admin/analytics/cache", (c) => {
    const stats = getPromptCacheTracker().getStats();
    return c.json(stats);
  });

  /** Model fallback states — shows which models are degraded. */
  app.get("/admin/analytics/model-fallback", (c) => {
    const states = getAllModelFallbackStates();
    return c.json({ models: states });
  });

  /** Request dedup and batch queue status. */
  app.get("/admin/analytics/queues", (c) => {
    const batchQueue = getBatchQueue();
    return c.json({
      dedup_in_flight: getDedupInFlightCount(),
      batch_queue: {
        pending: batchQueue.depth,
        jobs: batchQueue.list(undefined, 20).map((j) => ({
          id: j.id,
          status: j.status,
          model: j.request.model,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        })),
      },
    });
  });

  return app;
}
