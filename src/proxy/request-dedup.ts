/**
 * Request Deduplication — prevents duplicate non-streaming requests from
 * hitting upstream when the same request arrives within a short window.
 *
 * Use case: client retries, double-clicks, or network layer retransmissions.
 * Only applies to non-streaming requests (streaming requires independent
 * connections and cannot be shared).
 *
 * Design:
 *   - In-flight requests are tracked by a content hash (model + input)
 *   - If a duplicate arrives while the first is still in-flight, the
 *     duplicate piggybacks on the first result (shares the Promise)
 *   - Window: requests are only deduped while the first is in-flight
 *     (no TTL-based cache — this isn't response caching)
 *   - After the first completes, the slot is cleared immediately
 */

import { createHash } from "crypto";

interface InFlightEntry {
  promise: Promise<unknown>;
  startedAt: number;
}

const inFlight = new Map<string, InFlightEntry>();

/** Generate a dedup key from model + input. Returns null if not dedupable. */
export function generateDedupKey(
  model: string,
  input: unknown,
  isStreaming: boolean,
): string | null {
  // Only dedup non-streaming requests
  if (isStreaming) return null;
  // Skip requests with tools or function outputs (side-effectful)
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "object" && item !== null) {
        const type = (item as Record<string, unknown>).type;
        if (type === "function_call_output") return null;
      }
    }
  }

  try {
    const payload = JSON.stringify({ model, input });
    return createHash("sha256").update(payload).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * Check if a request is already in-flight and return the shared Promise.
 * Returns null if this is the first request with this key.
 */
export function getDedupInFlight(key: string): Promise<unknown> | null {
  const entry = inFlight.get(key);
  if (!entry) return null;
  // Safety: if entry has been in-flight for more than 5 minutes, assume it's stale
  if (Date.now() - entry.startedAt > 5 * 60 * 1000) {
    inFlight.delete(key);
    return null;
  }
  return entry.promise;
}

/**
 * Register an in-flight request. Returns a function to call when the request completes.
 * The provided promise should resolve with the response body (JSON).
 */
export function registerDedupInFlight(key: string, promise: Promise<unknown>): void {
  inFlight.set(key, { promise, startedAt: Date.now() });
  // Auto-cleanup when promise settles
  void promise.finally(() => {
    inFlight.delete(key);
  });
}

/** Current number of in-flight dedup entries. For monitoring. */
export function getDedupInFlightCount(): number {
  return inFlight.size;
}

/** Test-only: clear all entries. */
export function _resetDedupForTests(): void {
  inFlight.clear();
}
