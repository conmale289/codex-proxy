import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";

export interface StaggerDeps {
  intervalMs: () => number | null;
  nowMs: () => number;
  jitterInt: (baseMs: number, ratio: number) => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: StaggerDeps = {
  intervalMs: () => {
    const config = getConfig();
    // Stealth mode overrides: enforce the higher of the two intervals
    if (config.stealth.enabled) {
      const stealthInterval = config.stealth.min_request_interval_ms;
      const baseInterval = config.auth.request_interval_ms ?? 0;
      return Math.max(stealthInterval, baseInterval);
    }
    return config.auth.request_interval_ms;
  },
  nowMs: () => Date.now(),
  jitterInt,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Sleep if this account had a recent request, to stagger upstream traffic.
 * When stealth mode is enabled with `humanlike_jitter`, adds additional
 * random delay (500-2000ms) to make traffic patterns less periodic.
 */
export async function staggerIfNeeded(
  prevSlotMs: number | null,
  deps: Partial<StaggerDeps> = {},
): Promise<void> {
  const intervalMs = (deps.intervalMs ?? defaultDeps.intervalMs)();
  if (!intervalMs || prevSlotMs == null) return;
  const elapsed = (deps.nowMs ?? defaultDeps.nowMs)() - prevSlotMs;
  const jitterFn = deps.jitterInt ?? defaultDeps.jitterInt;
  const sleepFn = deps.sleep ?? defaultDeps.sleep;

  let target = jitterFn(intervalMs, 0.3);

  // Humanlike jitter: add random extra delay on top
  const config = getConfig();
  if (config.stealth.enabled && config.stealth.humanlike_jitter) {
    target += 500 + Math.floor(Math.random() * 1500); // 500-2000ms extra
  }

  const wait = target - elapsed;
  if (wait > 0) await sleepFn(wait);
}
