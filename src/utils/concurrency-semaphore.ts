/**
 * A lightweight concurrency Semaphore to prevent massive traffic spikes
 * from triggering upstream WAF limits or exhausting local TCP connections.
 */
export class ConcurrencySemaphore {
  private count: number = 0;
  private maxConcurrency: number;
  private queue: Array<() => void> = [];

  constructor(maxConcurrency: number = 100) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Acquire a slot in the semaphore.
   * If the semaphore is full, the returned Promise resolves when a slot becomes available.
   */
  async acquire(): Promise<void> {
    if (this.count < this.maxConcurrency) {
      this.count++;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.count++;
        resolve();
      });
    });
  }

  /**
   * Release a slot in the semaphore.
   * Must be called exactly once for each successful `acquire()`.
   */
  release(): void {
    this.count--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Update the maximum concurrency limit at runtime.
   * If lowering the limit, existing in-flight requests are not interrupted —
   * the semaphore simply won't grant new slots until count drops below the new max.
   */
  setMaxConcurrency(max: number): void {
    this.maxConcurrency = max;
    // If new max is higher, drain the queue up to the new limit
    while (this.count < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /**
   * Current number of acquired slots.
   */
  get current(): number {
    return this.count;
  }

  /**
   * Maximum concurrency limit.
   */
  get max(): number {
    return this.maxConcurrency;
  }

  /**
   * Current number of waiting tasks in the queue.
   */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Acquire a slot with a timeout. Returns true if acquired, false if timed out.
   * Prevents indefinite waits when slots are leaked or load exceeds capacity.
   */
  async acquireWithTimeout(timeoutMs: number): Promise<boolean> {
    if (this.count < this.maxConcurrency) {
      this.count++;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove from queue
        const idx = this.queue.indexOf(cb);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);

      const cb = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.count++;
        resolve(true);
      };

      this.queue.push(cb);
    });
  }
}

// Global semaphore instance — configured from quota.global_concurrency at startup
export const globalConcurrencySemaphore = new ConcurrencySemaphore(100);
