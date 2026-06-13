/**
 * Batch Request Queue — processes latency-tolerant requests in the background
 * when accounts have spare quota capacity.
 *
 * Clients can submit batch requests via:
 *   POST /v1/chat/completions with header X-Processing-Mode: batch
 *   POST /v1/batch/submit (dedicated endpoint)
 *
 * Batch jobs are:
 *   - Queued and processed asynchronously
 *   - Only executed when account quota usage is below a configurable threshold
 *   - Results stored and retrievable via GET /v1/batch/{id}
 *   - Lower priority than real-time requests (never starves interactive use)
 *
 * Use cases: code review, documentation generation, bulk analysis.
 */

import { randomUUID } from "crypto";

export type BatchJobStatus = "pending" | "processing" | "completed" | "failed" | "expired";

export interface BatchJob {
  id: string;
  /** Original request body */
  request: {
    model: string;
    messages?: unknown[];
    input?: unknown[];
    stream?: boolean;
    [key: string]: unknown;
  };
  /** Job metadata */
  status: BatchJobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** The response body when completed */
  result: unknown | null;
  /** Error message if failed */
  error: string | null;
  /** Client identifier (from API key or request ID) */
  clientId: string | null;
  /** Priority within the batch queue */
  priority: number;
}

const MAX_QUEUE_SIZE = 100;
const MAX_RESULT_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROCESS_INTERVAL_MS = 30_000; // Check queue every 30s

export class BatchQueue {
  private jobs = new Map<string, BatchJob>();
  private pendingQueue: string[] = []; // job IDs in priority order
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private processor: ((job: BatchJob) => Promise<unknown>) | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  /** Register the job processor function (called by server startup). */
  setProcessor(fn: (job: BatchJob) => Promise<unknown>): void {
    this.processor = fn;
  }

  /** Submit a new batch job. Returns the job ID. */
  submit(request: BatchJob["request"], clientId?: string | null): BatchJob | null {
    if (this.pendingQueue.length >= MAX_QUEUE_SIZE) {
      return null; // Queue full
    }

    const job: BatchJob = {
      id: `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      request: { ...request, stream: false }, // Force non-streaming for batch
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      clientId: clientId ?? null,
      priority: 0,
    };

    this.jobs.set(job.id, job);
    this.pendingQueue.push(job.id);
    return job;
  }

  /** Get a job by ID. */
  get(jobId: string): BatchJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** List jobs (optionally filtered by status). */
  list(status?: BatchJobStatus, limit = 50): BatchJob[] {
    const all = [...this.jobs.values()];
    const filtered = status ? all.filter((j) => j.status === status) : all;
    return filtered
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  /** Cancel a pending job. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return false;
    job.status = "expired";
    this.pendingQueue = this.pendingQueue.filter((id) => id !== jobId);
    return true;
  }

  /** Get queue depth for monitoring. */
  get depth(): number {
    return this.pendingQueue.length;
  }

  /** Process the next pending job. Called by the background timer or on-demand. */
  async processNext(): Promise<boolean> {
    if (!this.processor) return false;
    if (this.pendingQueue.length === 0) return false;

    const jobId = this.pendingQueue.shift();
    if (!jobId) return false;

    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return false;

    job.status = "processing";
    job.startedAt = new Date().toISOString();

    try {
      const result = await this.processor(job);
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.result = result;
      return true;
    } catch (err) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Start the background processing timer. */
  startProcessing(): void {
    if (this.processTimer) return;
    this.processTimer = setInterval(() => {
      void this.processNext();
    }, PROCESS_INTERVAL_MS);
    if (this.processTimer.unref) this.processTimer.unref();
  }

  /** Stop background processing. */
  stop(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  /** Remove expired results to bound memory. */
  private startCleanupTimer(): void {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [id, job] of this.jobs) {
        if (job.status === "completed" || job.status === "failed" || job.status === "expired") {
          const completedTime = job.completedAt ? new Date(job.completedAt).getTime() : new Date(job.createdAt).getTime();
          if (now - completedTime > MAX_RESULT_AGE_MS) {
            this.jobs.delete(id);
          }
        }
      }
    }, 60 * 60 * 1000); // Cleanup every hour
    if (timer.unref) timer.unref();
  }

  destroy(): void {
    this.stop();
  }
}

/** Singleton */
let _singleton: BatchQueue | null = null;

export function getBatchQueue(): BatchQueue {
  if (!_singleton) _singleton = new BatchQueue();
  return _singleton;
}

export function _resetBatchQueueForTests(): void {
  if (_singleton) _singleton.destroy();
  _singleton = null;
}
