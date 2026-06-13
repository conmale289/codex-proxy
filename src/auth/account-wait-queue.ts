/**
 * Account Wait Queue — provides backpressure when all accounts are busy.
 *
 * Instead of immediately returning 503 when no accounts are available,
 * callers can wait up to a configurable timeout for an account to be released.
 * This smooths out burst traffic without dropping requests.
 *
 * Design:
 *   - FIFO queue with per-waiter timeout
 *   - Notified when any account slot is released (via `notifyRelease()`)
 *   - Waiter re-attempts acquisition after notification
 *   - Timeout results in null (caller returns 503)
 *   - Queue depth visible for monitoring
 */

export interface AccountWaitQueueOptions {
  /** Maximum time to wait for an account (ms). 0 disables queuing. */
  maxWaitMs?: number;
  /** Maximum number of waiters in the queue. Beyond this, new requests get immediate 503. */
  maxQueueSize?: number;
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_WAIT_MS = 15_000; // 15 seconds
const DEFAULT_MAX_QUEUE_SIZE = 50;

export class AccountWaitQueue {
  private queue: Waiter[] = [];
  private maxWaitMs: number;
  private maxQueueSize: number;

  constructor(options?: AccountWaitQueueOptions) {
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  /**
   * Wait for a notification that an account was released.
   * Returns true if notified (caller should re-attempt acquire),
   * or false if timed out (caller should give up).
   */
  async waitForRelease(): Promise<boolean> {
    if (this.maxWaitMs <= 0) return false;
    if (this.queue.length >= this.maxQueueSize) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        resolve(false);
      }, this.maxWaitMs);

      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        timer,
      };

      this.queue.push(waiter);
    });
  }

  /**
   * Notify the queue that an account was released. Wakes the oldest waiter.
   * Should be called from AccountPool.release() or whenever an account becomes available.
   */
  notifyRelease(): void {
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.resolve();
    }
  }

  /** Current number of waiting requests. */
  get depth(): number {
    return this.queue.length;
  }

  /** Whether the queue is accepting new waiters. */
  get isFull(): boolean {
    return this.queue.length >= this.maxQueueSize;
  }

  /** Clear all waiters (for shutdown). */
  destroy(): void {
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      waiter.resolve(); // resolve with true, but acquire will return null anyway after shutdown
    }
    this.queue = [];
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.queue.indexOf(waiter);
    if (idx !== -1) this.queue.splice(idx, 1);
  }
}

/** Singleton instance */
let _singleton: AccountWaitQueue | null = null;

export function getAccountWaitQueue(): AccountWaitQueue {
  if (!_singleton) _singleton = new AccountWaitQueue();
  return _singleton;
}

export function setAccountWaitQueueConfig(options: AccountWaitQueueOptions): void {
  if (_singleton) _singleton.destroy();
  _singleton = new AccountWaitQueue(options);
}

export function _resetAccountWaitQueueForTests(): void {
  if (_singleton) _singleton.destroy();
  _singleton = null;
}
