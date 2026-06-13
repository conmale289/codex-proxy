/**
 * Rotation strategy — stateless selection logic for AccountPool.
 * Strategies do not mutate input arrays or read config.
 *
 * Strategies available:
 *   - least_used: multi-signal scoring (quota headroom, health, recency, load)
 *   - round_robin: simple cyclic rotation (for homogeneous pools)
 *   - sticky: most-recently-used first (maximize single-conversation cache)
 *   - adaptive: weighted scoring combining quota headroom, health, and load
 */

import type { AccountEntry } from "./types.js";

export type RotationStrategyName = "least_used" | "round_robin" | "sticky" | "adaptive";

export interface RotationState {
  roundRobinIndex: number;
}

export interface RotationStrategy {
  select(candidates: AccountEntry[], state: RotationState): AccountEntry;
}

// ── Shared Scoring Utilities ───────────────────────────────────────

/**
 * Estimate remaining quota headroom as a 0-1 score.
 * 1.0 = fully available, 0.0 = exhausted.
 * Accounts without quota data get 0.5 (unknown = neutral).
 */
function quotaHeadroomScore(entry: AccountEntry): number {
  const quota = entry.cachedQuota;
  if (!quota) return 0.5; // Unknown — neutral score

  // Primary bucket
  if (quota.rate_limit.limit_reached) return 0;
  const primaryUsed = quota.rate_limit.used_percent ?? 0;

  // Secondary bucket (if present)
  const secondaryUsed = quota.secondary_rate_limit?.used_percent ?? 0;
  if (quota.secondary_rate_limit?.limit_reached) return 0;

  // Take the worse of the two buckets
  const worstUsed = Math.max(primaryUsed, secondaryUsed);
  return Math.max(0, (100 - worstUsed) / 100);
}

/**
 * Score based on how soon the quota window resets.
 * Accounts resetting sooner are slightly preferred — use them before they reset
 * (waste not). Returns 0-1 where 1 = resets very soon (prefer).
 */
function resetProximityScore(entry: AccountEntry): number {
  const resetAt = entry.usage.window_reset_at;
  if (resetAt == null) return 0.5; // Unknown — neutral

  const nowSec = Date.now() / 1000;
  const secondsUntilReset = resetAt - nowSec;

  if (secondsUntilReset <= 0) return 1.0; // Already past reset — account is fresh
  if (secondsUntilReset > 3600) return 0.0; // More than 1h away — low priority

  // Linear decay: closer to reset = higher score
  return 1 - (secondsUntilReset / 3600);
}

/**
 * Load score: how many concurrent slots are already occupied.
 * Lower load = higher score.
 * Note: this uses the per-window request count as a proxy for current load
 * since actual slot count isn't accessible to strategies (they're stateless).
 */
function loadScore(entry: AccountEntry, candidates: AccountEntry[]): number {
  // Use per-window request count relative to the busiest candidate
  const windowReqs = entry.usage.window_request_count ?? 0;
  let maxWindowReqs = 0;
  for (const c of candidates) {
    const r = c.usage.window_request_count ?? 0;
    if (r > maxWindowReqs) maxWindowReqs = r;
  }
  if (maxWindowReqs === 0) return 1.0; // All equal — max score for all
  return 1 - (windowReqs / maxWindowReqs);
}

/**
 * Recency score: prefer accounts not used recently (spread traffic).
 * Returns 0-1 where 1 = least recently used (prefer).
 */
function recencyScore(entry: AccountEntry, candidates: AccountEntry[]): number {
  const lastUsed = entry.usage.last_used ? new Date(entry.usage.last_used).getTime() : 0;
  if (lastUsed === 0) return 1.0; // Never used — most preferable

  let oldest = Infinity;
  let newest = 0;
  for (const c of candidates) {
    const t = c.usage.last_used ? new Date(c.usage.last_used).getTime() : 0;
    if (t > 0 && t < oldest) oldest = t;
    if (t > newest) newest = t;
  }

  if (oldest === newest) return 0.5; // All same — neutral
  const range = newest - oldest;
  if (range === 0) return 0.5;

  // Older = higher score (prefer less recently used)
  return 1 - ((lastUsed - oldest) / range);
}

// ── Strategy Implementations ───────────────────────────────────────

const leastUsed: RotationStrategy = {
  select(candidates, state) {
    const cmp = (a: AccountEntry, b: AccountEntry): number => {
      // Primary: deprioritize quota-exhausted accounts
      const aExhausted = a.cachedQuota?.rate_limit?.limit_reached ? 1 : 0;
      const bExhausted = b.cachedQuota?.rate_limit?.limit_reached ? 1 : 0;
      if (aExhausted !== bExhausted) return aExhausted - bExhausted;

      // Secondary: prefer account with more quota headroom (used_percent aware)
      const aHeadroom = quotaHeadroomScore(a);
      const bHeadroom = quotaHeadroomScore(b);
      const headroomDiff = bHeadroom - aHeadroom; // Higher headroom = better
      if (Math.abs(headroomDiff) > 0.1) return headroomDiff > 0 ? 1 : -1;

      // Tertiary: prefer account whose quota resets soonest (use it before it resets).
      const aReset = a.usage.window_reset_at;
      const bReset = b.usage.window_reset_at;
      if (aReset != null && bReset != null && aReset !== bReset) return aReset - bReset;

      // Quaternary: fewer window requests = more remaining quota in current window
      const aWindowReq = a.usage.window_request_count ?? 0;
      const bWindowReq = b.usage.window_request_count ?? 0;
      if (aWindowReq !== bWindowReq) return aWindowReq - bWindowReq;

      // Quinary: fewer total requests = less overall wear
      const diff = a.usage.request_count - b.usage.request_count;
      if (diff !== 0) return diff;

      // Senary: LRU
      const aTime = a.usage.last_used ? new Date(a.usage.last_used).getTime() : 0;
      const bTime = b.usage.last_used ? new Date(b.usage.last_used).getTime() : 0;
      return aTime - bTime;
    };
    const sorted = [...candidates].sort(cmp);
    // Rotate among tied front-runners to avoid thundering herd on cold start
    let tiedCount = 1;
    while (tiedCount < sorted.length && cmp(sorted[0], sorted[tiedCount]) === 0) {
      tiedCount++;
    }
    const pick = state.roundRobinIndex % tiedCount;
    state.roundRobinIndex++;
    return sorted[pick];
  },
};

/**
 * Adaptive strategy — uses weighted scoring instead of multi-key sort.
 * Combines multiple signals into a single composite score per account.
 *
 * Weights (tuned for balanced multi-account deployment):
 *   - Quota headroom: 40% (primary driver — avoid exhausting any single account)
 *   - Load balance:   25% (spread traffic evenly across pool)
 *   - Recency:        20% (LRU — prevent staleness / timing patterns)
 *   - Reset proximity: 15% (use accounts about to reset — waste not)
 */
const adaptive: RotationStrategy = {
  select(candidates, state) {
    const W_QUOTA = 0.40;
    const W_LOAD = 0.25;
    const W_RECENCY = 0.20;
    const W_RESET = 0.15;

    let bestScore = -Infinity;
    let bestCandidates: AccountEntry[] = [];

    for (const candidate of candidates) {
      const score =
        W_QUOTA * quotaHeadroomScore(candidate) +
        W_LOAD * loadScore(candidate, candidates) +
        W_RECENCY * recencyScore(candidate, candidates) +
        W_RESET * resetProximityScore(candidate);

      if (score > bestScore + 0.001) {
        bestScore = score;
        bestCandidates = [candidate];
      } else if (Math.abs(score - bestScore) <= 0.001) {
        bestCandidates.push(candidate);
      }
    }

    // Among tied top scorers, use round-robin to break ties deterministically
    if (bestCandidates.length === 0) return candidates[0]; // Should never happen
    const pick = state.roundRobinIndex % bestCandidates.length;
    state.roundRobinIndex++;
    return bestCandidates[pick];
  },
};

const roundRobin: RotationStrategy = {
  select(candidates, state) {
    state.roundRobinIndex = state.roundRobinIndex % candidates.length;
    const selected = candidates[state.roundRobinIndex];
    state.roundRobinIndex++;
    return selected;
  },
};

const sticky: RotationStrategy = {
  select(candidates) {
    const sorted = [...candidates].sort((a, b) => {
      const aTime = a.usage.last_used ? new Date(a.usage.last_used).getTime() : 0;
      const bTime = b.usage.last_used ? new Date(b.usage.last_used).getTime() : 0;
      return bTime - aTime;
    });
    return sorted[0];
  },
};

const strategies: Record<RotationStrategyName, RotationStrategy> = {
  least_used: leastUsed,
  round_robin: roundRobin,
  sticky,
  adaptive,
};

export function getRotationStrategy(name: RotationStrategyName): RotationStrategy {
  return strategies[name] ?? strategies.least_used;
}

/** @deprecated Use getRotationStrategy instead */
export const createRotationStrategy = getRotationStrategy;

// ── Exported scoring utilities (for dashboard/diagnostics) ──────────

export { quotaHeadroomScore, resetProximityScore, loadScore, recencyScore };
