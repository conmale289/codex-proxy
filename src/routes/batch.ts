/**
 * Batch request routes — submit and retrieve background batch jobs.
 *
 * POST /v1/batch/submit  — submit a batch job
 * GET  /v1/batch/:id     — check batch job status/result
 * GET  /v1/batch         — list batch jobs
 * DELETE /v1/batch/:id   — cancel a pending batch job
 */

import { Hono } from "hono";
import { getBatchQueue } from "../proxy/batch-queue.js";
import type { AccountPool } from "../auth/account-pool.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";

export function createBatchRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  app.post("/v1/batch/submit", apiKeyAuth(accountPool), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } });
    }

    if (!body || typeof body !== "object" || !("model" in body)) {
      c.status(400);
      return c.json({ error: { message: "model is required", type: "invalid_request_error" } });
    }

    const queue = getBatchQueue();
    const job = queue.submit(body as any);

    if (!job) {
      c.status(429);
      return c.json({
        error: {
          message: "Batch queue is full. Try again later.",
          type: "rate_limit_error",
        },
      });
    }

    c.status(202);
    return c.json({
      id: job.id,
      status: job.status,
      created_at: job.createdAt,
    });
  });

  app.get("/v1/batch/:id", apiKeyAuth(accountPool), (c) => {
    const jobId = c.req.param("id");
    const queue = getBatchQueue();
    const job = queue.get(jobId);

    if (!job) {
      c.status(404);
      return c.json({ error: { message: "Batch job not found", type: "invalid_request_error" } });
    }

    const response: Record<string, unknown> = {
      id: job.id,
      status: job.status,
      model: job.request.model,
      created_at: job.createdAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
    };

    if (job.status === "completed") {
      response.result = job.result;
    } else if (job.status === "failed") {
      response.error = { message: job.error };
    }

    return c.json(response);
  });

  app.get("/v1/batch", apiKeyAuth(accountPool), (c) => {
    const statusFilter = c.req.query("status") as any;
    const queue = getBatchQueue();
    const jobs = queue.list(statusFilter, 50);

    return c.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        model: j.request.model,
        created_at: j.createdAt,
        completed_at: j.completedAt,
      })),
      queue_depth: queue.depth,
    });
  });

  app.delete("/v1/batch/:id", apiKeyAuth(accountPool), (c) => {
    const jobId = c.req.param("id");
    const queue = getBatchQueue();
    const cancelled = queue.cancel(jobId);

    if (!cancelled) {
      c.status(400);
      return c.json({
        error: { message: "Cannot cancel job (not pending or not found)", type: "invalid_request_error" },
      });
    }

    return c.json({ id: jobId, status: "cancelled" });
  });

  return app;
}
