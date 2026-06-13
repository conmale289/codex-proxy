/**
 * Intelligent Model Fallback — automatic fallback when a model is unavailable
 * or performing poorly.
 *
 * Tracks per-model error rates and latency. When thresholds are exceeded,
 * transparently routes requests to fallback models defined in config.
 *
 * Config example (in local.yaml):
 *   model_fallback:
 *     gpt-5.5:
 *       fallbacks: ["gpt-5.4", "gpt-5.4-mini"]
 *       error_threshold: 3          # consecutive errors to trigger fallback
 *       latency_threshold_ms: 30000 # TTFT above this triggers fallback
 *       recovery_probe_interval_ms: 120000  # try primary again every 2 min
 */

export interface ModelFallbackConfig {
  fallbacks: string[];
  /** Consecutive error count to trigger fallback (default 3). */
  errorThreshold: number;
  /** TTFT in ms above which to consider model degraded (default 30000). */
  latencyThresholdMs: number;
  /** How often to try the primary model again after fallback (default 120000). */
  recoveryProbeIntervalMs: number;
}

interface ModelHealthState {
  consecutiveErrors: number;
  lastErrorAt: number;
  lastSuccessAt: number;
  isFallingBack: boolean;
  fallbackActivatedAt: number;
  currentFallbackIndex: number;
}

const DEFAULT_ERROR_THRESHOLD = 3;
const DEFAULT_LATENCY_THRESHOLD_MS = 30_000;
const DEFAULT_RECOVERY_PROBE_INTERVAL_MS = 120_000;

const modelStates = new Map<string, ModelHealthState>();

function getOrCreateState(model: string): ModelHealthState {
  let state = modelStates.get(model);
  if (!state) {
    state = {
      consecutiveErrors: 0,
      lastErrorAt: 0,
      lastSuccessAt: 0,
      isFallingBack: false,
      fallbackActivatedAt: 0,
      currentFallbackIndex: 0,
    };
    modelStates.set(model, state);
  }
  return state;
}

/**
 * Resolve the effective model to use, applying fallback logic.
 * Returns the original model if no fallback is needed.
 */
export function resolveModelWithFallback(
  requestedModel: string,
  fallbackConfig?: ModelFallbackConfig | null,
  nowMs: number = Date.now(),
): string {
  if (!fallbackConfig || fallbackConfig.fallbacks.length === 0) {
    return requestedModel;
  }

  const state = getOrCreateState(requestedModel);
  const config = {
    errorThreshold: fallbackConfig.errorThreshold || DEFAULT_ERROR_THRESHOLD,
    latencyThresholdMs: fallbackConfig.latencyThresholdMs || DEFAULT_LATENCY_THRESHOLD_MS,
    recoveryProbeIntervalMs: fallbackConfig.recoveryProbeIntervalMs || DEFAULT_RECOVERY_PROBE_INTERVAL_MS,
  };

  if (!state.isFallingBack) {
    return requestedModel;
  }

  // Check if it's time for a recovery probe
  if (nowMs - state.fallbackActivatedAt >= config.recoveryProbeIntervalMs) {
    // Allow one probe request through to the primary model
    state.isFallingBack = false;
    state.consecutiveErrors = 0;
    return requestedModel;
  }

  // Return current fallback
  const fallbackIdx = Math.min(state.currentFallbackIndex, fallbackConfig.fallbacks.length - 1);
  return fallbackConfig.fallbacks[fallbackIdx];
}

/**
 * Record a successful request for a model. Resets error count and fallback state.
 */
export function recordModelSuccess(model: string): void {
  const state = getOrCreateState(model);
  state.consecutiveErrors = 0;
  state.lastSuccessAt = Date.now();
  // If this was a recovery probe that succeeded, clear fallback
  if (!state.isFallingBack) {
    state.currentFallbackIndex = 0;
  }
}

/**
 * Record a failed request for a model. May trigger fallback if threshold reached.
 */
export function recordModelFailure(
  model: string,
  fallbackConfig?: ModelFallbackConfig | null,
  nowMs: number = Date.now(),
): void {
  if (!fallbackConfig || fallbackConfig.fallbacks.length === 0) return;

  const state = getOrCreateState(model);
  const threshold = fallbackConfig.errorThreshold || DEFAULT_ERROR_THRESHOLD;

  state.consecutiveErrors++;
  state.lastErrorAt = nowMs;

  if (state.consecutiveErrors >= threshold && !state.isFallingBack) {
    state.isFallingBack = true;
    state.fallbackActivatedAt = nowMs;
    state.currentFallbackIndex = 0;
    console.warn(
      `[ModelFallback] Model "${model}" degraded (${state.consecutiveErrors} consecutive errors). ` +
      `Falling back to "${fallbackConfig.fallbacks[0]}".`,
    );
  }
}

/**
 * Record high latency for a model (may trigger proactive fallback).
 */
export function recordModelHighLatency(
  model: string,
  ttftMs: number,
  fallbackConfig?: ModelFallbackConfig | null,
  nowMs: number = Date.now(),
): void {
  if (!fallbackConfig || fallbackConfig.fallbacks.length === 0) return;
  const threshold = fallbackConfig.latencyThresholdMs || DEFAULT_LATENCY_THRESHOLD_MS;

  if (ttftMs < threshold) return;

  const state = getOrCreateState(model);
  // Only count latency toward fallback when it's consistent (2 slow in a row)
  state.consecutiveErrors++;
  state.lastErrorAt = nowMs;

  if (state.consecutiveErrors >= 2 && !state.isFallingBack) {
    state.isFallingBack = true;
    state.fallbackActivatedAt = nowMs;
    state.currentFallbackIndex = 0;
    console.warn(
      `[ModelFallback] Model "${model}" slow (TTFT ${ttftMs}ms > ${threshold}ms). ` +
      `Falling back to "${fallbackConfig.fallbacks[0]}".`,
    );
  }
}

/** Get fallback status for all tracked models (for dashboard). */
export function getAllModelFallbackStates(): Array<{
  model: string;
  isFallingBack: boolean;
  consecutiveErrors: number;
  lastErrorAt: number;
}> {
  const result: Array<{
    model: string;
    isFallingBack: boolean;
    consecutiveErrors: number;
    lastErrorAt: number;
  }> = [];
  for (const [model, state] of modelStates) {
    if (state.consecutiveErrors > 0 || state.isFallingBack) {
      result.push({
        model,
        isFallingBack: state.isFallingBack,
        consecutiveErrors: state.consecutiveErrors,
        lastErrorAt: state.lastErrorAt,
      });
    }
  }
  return result;
}

/** Force-reset fallback state for a model. */
export function resetModelFallback(model: string): void {
  modelStates.delete(model);
}

/** Test-only: clear all model states. */
export function _resetAllModelFallbacks(): void {
  modelStates.clear();
}
