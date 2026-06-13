/**
 * Circuit Breaker — prevents the proxy from hammering a clearly-broken
 * upstream by temporarily stopping requests to accounts/endpoints that
 * are experiencing consecutive failures.
 *
 * State machine:
 *   CLOSED (normal) → N failures in M seconds → OPEN (reject immediately)
 *   OPEN → T seconds elapsed → HALF_OPEN (allow 1 probe request)
 *   HALF_OPEN → success → CLOSED | failure → OPEN (reset timer)
 *
 * Keyed per-account (entryId). This means a single broken account doesn't
 * poison the entire pool — other accounts can still serve requests.
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures to trip the breaker. */
  failureThreshold: number;
  /** Time window (ms) within which failures are counted. */
  failureWindowMs: number;
  /** How long the circuit stays open before trying a probe (ms). */
  openDurationMs: number;
  /** Maximum consecutive open cycles before extended cooldown. */
  maxConsecutiveOpens: number;
  /** Extended cooldown multiplier when max consecutive opens reached. */
  extendedCooldownMultiplier: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 60_000, // 1 minute
  openDurationMs: 30_000, // 30 seconds
  maxConsecutiveOpens: 3,
  extendedCooldownMultiplier: 4,
};

interface BreakerState {
  state: CircuitState;
  failures: number[];
  openedAt: number | null;
  consecutiveOpens: number;
  lastProbeAt: number | null;
}

const breakers = new Map<string, BreakerState>();

function getOrCreate(key: string): BreakerState {
  let state = breakers.get(key);
  if (!state) {
    state = {
      state: "closed",
      failures: [],
      openedAt: null,
      consecutiveOpens: 0,
      lastProbeAt: null,
    };
    breakers.set(key, state);
  }
  return state;
}

function getEffectiveOpenDuration(state: BreakerState, config: CircuitBreakerConfig): number {
  if (state.consecutiveOpens >= config.maxConsecutiveOpens) {
    return config.openDurationMs * config.extendedCooldownMultiplier;
  }
  return config.openDurationMs;
}

/**
 * Check if a request should be allowed through the circuit breaker.
 * Returns true if the request can proceed, false if the circuit is open.
 */
export function canRequest(
  key: string,
  nowMs: number = Date.now(),
  config: CircuitBreakerConfig = DEFAULT_CONFIG,
): boolean {
  const state = getOrCreate(key);

  switch (state.state) {
    case "closed":
      return true;

    case "open": {
      const openDuration = getEffectiveOpenDuration(state, config);
      if (state.openedAt && nowMs - state.openedAt >= openDuration) {
        // Transition to half-open: allow one probe request
        state.state = "half_open";
        state.lastProbeAt = nowMs;
        return true;
      }
      return false;
    }

    case "half_open":
      // Only one request allowed in half-open (the probe)
      // If a probe is already in flight (recent), reject others
      if (state.lastProbeAt && nowMs - state.lastProbeAt < 5000) {
        return false;
      }
      state.lastProbeAt = nowMs;
      return true;
  }
}

/**
 * Record a successful request. Resets the circuit to closed state.
 */
export function recordSuccess(key: string): void {
  const state = getOrCreate(key);
  state.state = "closed";
  state.failures = [];
  state.openedAt = null;
  state.consecutiveOpens = 0;
  state.lastProbeAt = null;
}

/**
 * Record a failed request. May trip the circuit to open if threshold reached.
 */
export function recordFailure(
  key: string,
  nowMs: number = Date.now(),
  config: CircuitBreakerConfig = DEFAULT_CONFIG,
): CircuitState {
  const state = getOrCreate(key);

  if (state.state === "half_open") {
    // Probe failed — reopen the circuit
    state.state = "open";
    state.openedAt = nowMs;
    state.consecutiveOpens++;
    state.lastProbeAt = null;
    return "open";
  }

  // Remove failures outside the window
  state.failures = state.failures.filter((ts) => nowMs - ts < config.failureWindowMs);
  state.failures.push(nowMs);

  if (state.failures.length >= config.failureThreshold) {
    state.state = "open";
    state.openedAt = nowMs;
    state.consecutiveOpens++;
    state.failures = [];
    console.warn(
      `[CircuitBreaker] Circuit OPEN for "${key}" (${state.consecutiveOpens} consecutive opens). ` +
      `Cooldown: ${getEffectiveOpenDuration(state, config) / 1000}s`,
    );
    return "open";
  }

  return "closed";
}

/** Get the current state of a circuit breaker. */
export function getState(key: string): CircuitState {
  return getOrCreate(key).state;
}

/** Get summary info for all active breakers (for dashboard). */
export function getAllBreakerStates(): Array<{
  key: string;
  state: CircuitState;
  failures: number;
  consecutiveOpens: number;
  openedAt: number | null;
}> {
  const result: Array<{
    key: string;
    state: CircuitState;
    failures: number;
    consecutiveOpens: number;
    openedAt: number | null;
  }> = [];
  for (const [key, state] of breakers) {
    result.push({
      key,
      state: state.state,
      failures: state.failures.length,
      consecutiveOpens: state.consecutiveOpens,
      openedAt: state.openedAt,
    });
  }
  return result;
}

/** Force-reset a specific breaker. Used when an account is manually re-enabled. */
export function resetBreaker(key: string): void {
  breakers.delete(key);
}

/** Test-only: clear all breakers. */
export function _resetAllBreakers(): void {
  breakers.clear();
}
