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
   * Current number of acquired slots.
   */
  get current(): number {
    return this.count;
  }

  /**
   * Current number of waiting tasks in the queue.
   */
  get waiting(): number {
    return this.queue.length;
  }
}

// Global semaphore instance (max 100 concurrent requests across the proxy)
export const globalConcurrencySemaphore = new ConcurrencySemaphore(100);
