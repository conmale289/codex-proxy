import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../../auth/account-pool.js";
import { getConfig, getFingerprint } from "../../config.js";
import { getConfigDir, getDataDir, getBinDir, isEmbedded } from "../../paths.js";
import { getTransportInfo } from "../../tls/transport.js";
import { getProxyUrl } from "../../tls/proxy.js";
import { isLocalhostRequest } from "../../utils/is-localhost.js";
import { globalConcurrencySemaphore } from "../../utils/concurrency-semaphore.js";
import { getWsPool } from "../../proxy/ws-pool.js";
import { getAllBreakerStates } from "../../proxy/circuit-breaker.js";
import { getAllHourlyCounts } from "../../auth/usage-anomaly-detector.js";
import { responseCache } from "../../proxy/response-cache.js";
import { getModelRequestCounters } from "../../proxy/model-request-counters.js";

const startedAt = Date.now();

export function createHealthRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const poolSummary = accountPool.getPoolSummary();
    const capacitySummary = accountPool.getCapacitySummary();
    return c.json({
      status: "ok",
      authenticated,
      pool: {
        total: poolSummary.total,
        active: poolSummary.active,
        ...capacitySummary,
      },
      timestamp: new Date().toISOString(),
    });
  });

  /** Detailed health endpoint for monitoring and Docker health checks.
   *  Surfaces upstream connectivity, account health, memory, and semaphore status. */
  app.get("/health/detailed", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const poolSummary = accountPool.getPoolSummary();
    const capacitySummary = accountPool.getCapacitySummary();
    const memoryUsage = process.memoryUsage();
    const wsPool = getWsPool();
    const circuitBreakers = getAllBreakerStates();
    const anomalyCounts = getAllHourlyCounts();
    const config = getConfig();

    const openCircuits = circuitBreakers.filter((b) => b.state === "open");

    return c.json({
      status: authenticated ? "healthy" : "degraded",
      authenticated,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      pool: {
        total: poolSummary.total,
        active: poolSummary.active,
        ...capacitySummary,
      },
      concurrency: {
        current: globalConcurrencySemaphore.current,
        max: globalConcurrencySemaphore.max,
        waiting: globalConcurrencySemaphore.waiting,
      },
      ws_pool: {
        size: wsPool.size(),
      },
      memory: {
        rss_mb: Math.round(memoryUsage.rss / 1024 / 1024),
        heap_used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external_mb: Math.round(memoryUsage.external / 1024 / 1024),
      },
      circuit_breakers: {
        total: circuitBreakers.length,
        open: openCircuits.length,
        open_keys: openCircuits.map((b) => b.key),
      },
      response_cache: {
        entries: responseCache.size,
        bytes_mb: Math.round(responseCache.bytes / 1024 / 1024 * 100) / 100,
      },
      model_requests: getModelRequestCounters(),
      stealth: {
        enabled: config.stealth.enabled,
        anomaly_counts: anomalyCounts.length > 0
          ? anomalyCounts.sort((a, b) => b.count - a.count).slice(0, 5)
          : [],
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/debug/fingerprint", (c) => {
    const isProduction = process.env.NODE_ENV === "production";
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = isLocalhostRequest(remoteAddr);
    if (isProduction && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const config = getConfig();
    const fp = getFingerprint();

    const ua = fp.user_agent_template
      .replace("{version}", config.client.app_version)
      .replace("{platform}", config.client.platform)
      .replace("{arch}", config.client.arch);

    const promptsDir = resolve(getConfigDir(), "prompts");
    const prompts: Record<string, boolean> = {
      "desktop-context.md": existsSync(resolve(promptsDir, "desktop-context.md")),
      "title-generation.md": existsSync(resolve(promptsDir, "title-generation.md")),
      "pr-generation.md": existsSync(resolve(promptsDir, "pr-generation.md")),
      "automation-response.md": existsSync(resolve(promptsDir, "automation-response.md")),
    };

    let updateState = null;
    const statePath = resolve(getDataDir(), "update-state.json");
    if (existsSync(statePath)) {
      try {
        updateState = JSON.parse(readFileSync(statePath, "utf-8"));
      } catch {}
    }

    return c.json({
      headers: {
        "User-Agent": ua,
        originator: config.client.originator,
      },
      client: {
        app_version: config.client.app_version,
        build_number: config.client.build_number,
        platform: config.client.platform,
        arch: config.client.arch,
      },
      api: {
        base_url: config.api.base_url,
      },
      model: {
        default: config.model.default,
      },
      codex_fields: {
        developer_instructions: "loaded from config/prompts/desktop-context.md",
        approval_policy: "never",
        sandbox: "workspace-write",
        personality: null,
        ephemeral: null,
      },
      prompts_loaded: prompts,
      update_state: updateState,
    });
  });

  app.get("/debug/diagnostics", (c) => {
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = isLocalhostRequest(remoteAddr);
    if (process.env.NODE_ENV === "production" && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const transport = getTransportInfo();
    const poolSummary = accountPool.getPoolSummary();

    return c.json({
      transport: {
        type: transport.type,
        initialized: transport.initialized,
        impersonate: transport.impersonate,
      },
      proxy: { url: getProxyUrl() },
      accounts: {
        total: poolSummary.total,
        active: poolSummary.active,
        authenticated: accountPool.isAuthenticated(),
      },
      paths: {
        bin: getBinDir(),
        config: getConfigDir(),
        data: getDataDir(),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        embedded: isEmbedded(),
      },
    });
  });

  return app;
}
