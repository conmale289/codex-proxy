/**
 * Usage Anomaly Detector — monitors per-account request rates and triggers
 * warnings, throttling, or auto-pause when patterns become machine-like.
 *
 * Integrates with the stealth config to enforce hourly rate limits per account.
 * This protects accounts from being flagged for unusual activity by upstream
 * WAF / abuse detection systems.
 */

import { getConfig } from "../config.js";

interface HourlyWindow {
  count: number;
  windowStart: number;
}

export type AnomalyAction = "allow" | "warn" | "throttle" | "pause";

const hourlyWindows = new Map<string, HourlyWindow>();

const HOUR_MS = 60 * 60 * 1000;

function getOrCreateWindow(entryId: string, nowMs: number): HourlyWindow {
  const existing = hourlyWindows.get(entryId);
  if (existing && nowMs - existing.windowStart < HOUR_MS) {
    return existing;
  }
  // Window expired or doesn't exist — create new
  const fresh: HourlyWindow = { count: 0, windowStart: nowMs };
  hourlyWindows.set(entryId, fresh);
  return fresh;
}

/**
 * Record a request for the given account and return the appropriate action.
 * The caller should:
 *   - "allow": proceed normally
 *   - "warn": proceed but log a warning
 *   - "throttle": proceed after adding extra delay
 *   - "pause": reject the request and temporarily disable the account
 */
export function recordRequestAndCheckAnomaly(
  entryId: string,
  nowMs: number = Date.now(),
): AnomalyAction {
  const config = getConfig();
  if (!config.stealth.enabled) return "allow";

  const { hourly_request_warn, hourly_request_throttle, hourly_request_pause } = config.stealth;

  const window = getOrCreateWindow(entryId, nowMs);
  window.count++;

  if (hourly_request_pause > 0 && window.count >= hourly_request_pause) {
    return "pause";
  }
  if (hourly_request_throttle > 0 && window.count >= hourly_request_throttle) {
    return "throttle";
  }
  if (hourly_request_warn > 0 && window.count >= hourly_request_warn) {
    return "warn";
  }
  return "allow";
}

/** Get current hourly count for an account without incrementing. */
export function peekHourlyCount(entryId: string, nowMs: number = Date.now()): number {
  const existing = hourlyWindows.get(entryId);
  if (!existing || nowMs - existing.windowStart >= HOUR_MS) return 0;
  return existing.count;
}

/** Get all accounts with their current hourly request counts. */
export function getAllHourlyCounts(nowMs: number = Date.now()): Array<{ entryId: string; count: number }> {
  const result: Array<{ entryId: string; count: number }> = [];
  for (const [entryId, window] of hourlyWindows) {
    if (nowMs - window.windowStart >= HOUR_MS) continue;
    result.push({ entryId, count: window.count });
  }
  return result;
}

/** Reset the window for an account. Used when re-enabling a paused account. */
export function resetAnomalyWindow(entryId: string): void {
  hourlyWindows.delete(entryId);
}

/** Test-only: clear all windows. */
export function _resetAllAnomalyWindows(): void {
  hourlyWindows.clear();
}
