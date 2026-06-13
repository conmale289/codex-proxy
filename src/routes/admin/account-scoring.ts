/**
 * Account Scoring diagnostics endpoint — shows the real-time scoring of each
 * account as the rotation strategy sees it.
 *
 * GET /admin/account-scoring returns each account's score breakdown so
 * operators can understand why specific accounts are being selected or skipped.
 */

import { Hono } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import { getConfig } from "../../config.js";
import { quotaHeadroomScore, resetProximityScore, loadScore, recencyScore } from "../../auth/rotation-strategy.js";
import { hasReachedCachedQuota } from "../../auth/quota-skip.js";
import { isCfChallengeCooldownActive, getCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import { peekHourlyCount } from "../../auth/usage-anomaly-detector.js";
import { getState as getCircuitState } from "../../proxy/circuit-breaker.js";

export function createAccountScoringRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  app.get("/admin/account-scoring", (c) => {
    const entries = accountPool.getAllEntries();
    const config = getConfig();
    const maxConcurrent = config.stealth.enabled
      ? Math.min(config.stealth.max_concurrent_per_account, config.auth.max_concurrent_per_account ?? 3)
      : (config.auth.max_concurrent_per_account ?? 3);
    const skipExhausted = config.quota?.skip_exhausted === true;

    const activeEntries = entries.filter((e) => e.status === "active");

    const scored = entries.map((entry) => {
      const isActive = entry.status === "active";
      const isExhausted = hasReachedCachedQuota(entry);
      const isCfCooled = isCfChallengeCooldownActive(entry.id);
      const cfCooldown = getCfChallengeCooldown(entry.id);
      const circuitState = getCircuitState(entry.id);
      const hourlyCount = peekHourlyCount(entry.id);

      // Eligibility check
      const eligible = isActive && !isCfCooled && (!skipExhausted || !isExhausted);

      // Scoring (only meaningful for eligible accounts)
      const headroom = quotaHeadroomScore(entry);
      const reset = resetProximityScore(entry);
      const load = eligible ? loadScore(entry, activeEntries) : 0;
      const recency = eligible ? recencyScore(entry, activeEntries) : 0;

      // Composite adaptive score
      const adaptiveScore = eligible
        ? 0.40 * headroom + 0.25 * load + 0.20 * recency + 0.15 * reset
        : 0;

      return {
        id: entry.id,
        email: entry.email,
        planType: entry.planType,
        status: entry.status,
        eligible,
        eligibility_reasons: {
          active: isActive,
          not_exhausted: !isExhausted,
          not_cf_cooled: !isCfCooled,
          circuit_state: circuitState,
        },
        scores: {
          quota_headroom: Math.round(headroom * 1000) / 1000,
          reset_proximity: Math.round(reset * 1000) / 1000,
          load_balance: Math.round(load * 1000) / 1000,
          recency: Math.round(recency * 1000) / 1000,
          adaptive_composite: Math.round(adaptiveScore * 1000) / 1000,
        },
        metrics: {
          request_count: entry.usage.request_count,
          window_request_count: entry.usage.window_request_count ?? 0,
          hourly_request_count: hourlyCount,
          used_percent: entry.cachedQuota?.rate_limit?.used_percent ?? null,
          secondary_used_percent: entry.cachedQuota?.secondary_rate_limit?.used_percent ?? null,
          window_reset_at: entry.usage.window_reset_at ?? null,
          last_used: entry.usage.last_used,
        },
        config: {
          max_concurrent: maxConcurrent,
          skip_exhausted: skipExhausted,
          stealth_enabled: config.stealth.enabled,
        },
        ...(cfCooldown ? {
          cf_cooldown: {
            challenge_count: cfCooldown.challengeCount,
            cooldown_until: new Date(cfCooldown.cooldownUntilMs).toISOString(),
          },
        } : {}),
      };
    });

    // Sort by adaptive score descending (best candidates first)
    scored.sort((a, b) => b.scores.adaptive_composite - a.scores.adaptive_composite);

    return c.json({
      strategy: config.auth.rotation_strategy,
      pool_size: entries.length,
      eligible_count: scored.filter((s) => s.eligible).length,
      accounts: scored,
    });
  });

  return app;
}
