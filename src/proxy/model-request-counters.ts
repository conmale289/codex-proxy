/**
 * Per-model request counters — lightweight in-memory analytics.
 * Tracks total requests and errors per model for the health endpoint.
 */

interface ModelCounter {
  requests: number;
  errors: number;
  lastRequestAt: number;
}

const counters = new Map<string, ModelCounter>();

export function recordModelRequest(model: string, isError: boolean = false): void {
  let counter = counters.get(model);
  if (!counter) {
    counter = { requests: 0, errors: 0, lastRequestAt: 0 };
    counters.set(model, counter);
  }
  counter.requests++;
  if (isError) counter.errors++;
  counter.lastRequestAt = Date.now();
}

export function getModelRequestCounters(): Record<string, { requests: number; errors: number; last_request_at: string }> {
  const result: Record<string, { requests: number; errors: number; last_request_at: string }> = {};
  for (const [model, counter] of counters) {
    result[model] = {
      requests: counter.requests,
      errors: counter.errors,
      last_request_at: new Date(counter.lastRequestAt).toISOString(),
    };
  }
  return result;
}

export function _resetModelCountersForTests(): void {
  counters.clear();
}
