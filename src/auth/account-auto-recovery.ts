/**
 * Account Auto-Recovery — periodically probes disabled/banned accounts to
 * detect when temporary bans have been lifted.
 *
 * Many upstream bans are temporary (24h, 7d). Without auto-recovery, an
 * operator must manually re-enable accounts after the ban expires. This
 * module sends a lightweight health probe (GET /codex/usage) every N hours
 * on disabled accounts. If the probe succeeds (HTTP 200), the account is
 * automatically re-enabled.
 *
 * Safety measures:
 *   - Only probes accounts disabled by specific recoverable reasons (ban, CF block)
 *   - Minimum 6h between probes per account (avoids hammering)
 *   - Jittered scheduling to avoid burst patterns
 *   - Success triggers re-enable + dashboard-visible event
 *   - Failure is silent (account stays disabled)
 */

import { getConfig } from "../config.js";
import { CodexApi } from "../proxy/codex-api.js";
import { jitter } from "../utils/jitter.js";
import type { AccountPool } from "./account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { resetBreaker } from "../proxy/circuit-breaker.js";
import { resetAnomalyWindow } from "./usage-anomaly-detector.js";
import { resetCfPathBlock } from "./cf-path-block-tracker.js";
import { clearCfChallengeCooldown } from "./cf-challenge-cooldown.js";
import { appendErrorLog } from "../logs/error-log.js";
import { notifyAccountRecovered } from "../utils/webhook-notifier.js";

const DEFAULT_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_PROBE_GAP_MS = 6 * 60 * 60 * 1000; // 6 hours minimum between probes

export interface AccountAutoRecoveryOptions {
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool | null;
  /** Interval between recovery sweeps. Default 6 hours. */
  intervalMs?: number;
}

export class AccountAutoRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pool: AccountPool;
  private cookieJar?: CookieJar;
  private proxyPool?: ProxyPool | null;
  private intervalMs: number;
  private lastProbeAt = new Map<string, number>();

  constructor(pool: AccountPool, options?: AccountAutoRecoveryOptions) {
    this.pool = pool;
    this.cookieJar = options?.cookieJar;
    this.proxyPool = options?.proxyPool;
    this.intervalMs = options?.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
    console.log("[AutoRecovery] Account auto-recovery started");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = jitter(this.intervalMs, 0.2);
    this.timer = setTimeout(() => void this.tick(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      const entries = this.pool.getAllEntries();

      // Find disabled accounts that might be recoverable
      const candidates = entries.filter((entry) => {
        if (entry.status !== "disabled" && entry.status !== "banned") return false;
        // Only probe if enough time has passed since last probe
        const lastProbe = this.lastProbeAt.get(entry.id) ?? 0;
        return now - lastProbe >= MIN_PROBE_GAP_MS;
      });

      if (candidates.length === 0) {
        this.scheduleNext();
        return;
      }

      console.log(`[AutoRecovery] Probing ${candidates.length} disabled account(s)...`);

      for (const entry of candidates) {
        if (this.stopped) break;

        this.lastProbeAt.set(entry.id, now);

        try {
          const proxyUrl = this.proxyPool?.resolveProxyUrl(entry.id);
          const api = new CodexApi(
            entry.token,
            entry.accountId,
            this.cookieJar,
            entry.id,
            proxyUrl,
          );

          // Lightweight probe — just check if the token is still valid
          await api.getUsage();

          // If we got here without throwing, the account is accessible!
          console.log(
            `[AutoRecovery] ✅ Account ${entry.id} (${entry.email ?? "?"}) recovered! Re-enabling.`,
          );

          // Reset all tracking state for this account
          resetBreaker(entry.id);
          resetAnomalyWindow(entry.id);
          resetCfPathBlock(entry.id);
          clearCfChallengeCooldown(entry.id);

          // Re-enable the account
          this.pool.markStatus(entry.id, "active");

          notifyAccountRecovered(entry.id, entry.email ?? null);

          appendErrorLog({
            source: "server",
            error: {
              name: "AccountAutoRecovered",
              message: `Account ${entry.id} (${entry.email ?? "?"}) auto-recovered from disabled state`,
            },
            context: { entryId: entry.id, email: entry.email ?? null },
          });
        } catch (err) {
          // Expected — account is still banned. Silent failure.
          const status = (err as any)?.status;
          if (status === 401 || status === 403) {
            // Still banned — do nothing
          } else {
            // Unexpected error (network, etc.) — log but don't retry immediately
            console.warn(
              `[AutoRecovery] Probe failed for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Stagger probes to avoid burst
        await new Promise((resolve) => setTimeout(resolve, jitter(5000, 0.3)));
      }
    } catch (err) {
      console.warn("[AutoRecovery] Sweep error:", err instanceof Error ? err.message : err);
    } finally {
      this.scheduleNext();
    }
  }
}
