import { Hono } from "hono";
import { getConfig, getLocalConfigPath, reloadAllConfigs } from "../../config.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import { isRecord } from "../../translation/shared-utils.js";

interface StealthSettingsBody {
  enabled?: boolean;
  min_request_interval_ms?: number;
  max_concurrent_per_account?: number;
  per_account_installation_id?: boolean;
  humanlike_jitter?: boolean;
  hourly_request_warn?: number;
  hourly_request_throttle?: number;
  hourly_request_pause?: number;
}

function validateBody(body: StealthSettingsBody): string | null {
  if (body.min_request_interval_ms !== undefined) {
    if (!Number.isInteger(body.min_request_interval_ms) || body.min_request_interval_ms < 0) {
      return "min_request_interval_ms must be a non-negative integer";
    }
  }
  if (body.max_concurrent_per_account !== undefined) {
    if (!Number.isInteger(body.max_concurrent_per_account) || body.max_concurrent_per_account < 1) {
      return "max_concurrent_per_account must be an integer >= 1";
    }
  }
  if (body.hourly_request_warn !== undefined) {
    if (!Number.isInteger(body.hourly_request_warn) || body.hourly_request_warn < 0) {
      return "hourly_request_warn must be a non-negative integer";
    }
  }
  if (body.hourly_request_throttle !== undefined) {
    if (!Number.isInteger(body.hourly_request_throttle) || body.hourly_request_throttle < 0) {
      return "hourly_request_throttle must be a non-negative integer";
    }
  }
  if (body.hourly_request_pause !== undefined) {
    if (!Number.isInteger(body.hourly_request_pause) || body.hourly_request_pause < 0) {
      return "hourly_request_pause must be a non-negative integer";
    }
  }
  return null;
}

function currentSettingsPayload() {
  const config = getConfig();
  return {
    enabled: config.stealth.enabled,
    min_request_interval_ms: config.stealth.min_request_interval_ms,
    max_concurrent_per_account: config.stealth.max_concurrent_per_account,
    per_account_installation_id: config.stealth.per_account_installation_id,
    humanlike_jitter: config.stealth.humanlike_jitter,
    hourly_request_warn: config.stealth.hourly_request_warn,
    hourly_request_throttle: config.stealth.hourly_request_throttle,
    hourly_request_pause: config.stealth.hourly_request_pause,
  };
}

export function createStealthAdminRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/stealth-settings", (c) => {
    return c.json(currentSettingsPayload());
  });

  app.post("/admin/stealth-settings", async (c) => {
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Invalid JSON body" });
    }
    if (!isRecord(parsedBody)) {
      c.status(400);
      return c.json({ error: "JSON body must be an object" });
    }

    const body = parsedBody as StealthSettingsBody;
    const validationError = validateBody(body);
    if (validationError) {
      c.status(400);
      return c.json({ error: validationError });
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.stealth) data.stealth = {};
      const stealth = data.stealth as Record<string, unknown>;
      if (body.enabled !== undefined) stealth.enabled = body.enabled;
      if (body.min_request_interval_ms !== undefined) stealth.min_request_interval_ms = body.min_request_interval_ms;
      if (body.max_concurrent_per_account !== undefined) stealth.max_concurrent_per_account = body.max_concurrent_per_account;
      if (body.per_account_installation_id !== undefined) stealth.per_account_installation_id = body.per_account_installation_id;
      if (body.humanlike_jitter !== undefined) stealth.humanlike_jitter = body.humanlike_jitter;
      if (body.hourly_request_warn !== undefined) stealth.hourly_request_warn = body.hourly_request_warn;
      if (body.hourly_request_throttle !== undefined) stealth.hourly_request_throttle = body.hourly_request_throttle;
      if (body.hourly_request_pause !== undefined) stealth.hourly_request_pause = body.hourly_request_pause;
    });
    reloadAllConfigs();

    return c.json({ success: true, ...currentSettingsPayload() });
  });

  return app;
}
