/**
 * Multi-Client API Key Manager — supports multiple proxy API keys with
 * per-key rate limits, model restrictions, and usage tracking.
 *
 * This enables multi-tenant deployments where different clients/users
 * get isolated keys with independent rate limits and permissions.
 *
 * Features:
 *   - Multiple proxy API keys (beyond the single `proxy_api_key`)
 *   - Per-key rate limiting (requests per minute / per day)
 *   - Per-key model restrictions (allowlist)
 *   - Per-key account pool pinning (optional)
 *   - Per-key usage tracking (request count, tokens)
 *   - Key creation, revocation, and listing via admin API
 *
 * Storage: `data/proxy-keys.json` (SQLite migration deferred to v2)
 */

import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { getDataDir } from "../paths.js";

export interface ProxyKeyEntry {
  id: string;
  /** The actual bearer token (sk-proxy-...) */
  key: string;
  /** Human-readable label */
  name: string;
  /** Creation timestamp */
  createdAt: string;
  /** Whether the key is active */
  enabled: boolean;
  /** Rate limit: max requests per minute. 0 = unlimited. */
  rateLimit_rpm: number;
  /** Rate limit: max requests per day. 0 = unlimited. */
  rateLimit_rpd: number;
  /** Allowed models (empty = all models allowed) */
  allowedModels: string[];
  /** Account pool subset (empty = all accounts) */
  accountPool: string[];
  /** Priority level for request scheduling */
  priority: "high" | "normal" | "low";
  /** Usage counters */
  usage: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    todayRequests: number;
    todayDate: string;
    minuteRequests: number;
    minuteTimestamp: number;
  };
}

interface ProxyKeysFile {
  _version: 1;
  keys: ProxyKeyEntry[];
}

const KEYS_FILE = "proxy-keys.json";

function getKeysFile(): string {
  return resolve(getDataDir(), KEYS_FILE);
}

function generateKeyToken(): string {
  return `sk-proxy-${randomBytes(24).toString("hex")}`;
}

function generateKeyId(): string {
  return randomBytes(8).toString("hex");
}

export class MultiKeyManager {
  private keys: Map<string, ProxyKeyEntry> = new Map(); // id → entry
  private keyIndex: Map<string, string> = new Map(); // key → id (for fast lookup)
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  /** Create a new proxy key. Returns the full key entry. */
  create(options: {
    name: string;
    rateLimit_rpm?: number;
    rateLimit_rpd?: number;
    allowedModels?: string[];
    accountPool?: string[];
    priority?: "high" | "normal" | "low";
  }): ProxyKeyEntry {
    const entry: ProxyKeyEntry = {
      id: generateKeyId(),
      key: generateKeyToken(),
      name: options.name,
      createdAt: new Date().toISOString(),
      enabled: true,
      rateLimit_rpm: options.rateLimit_rpm ?? 0,
      rateLimit_rpd: options.rateLimit_rpd ?? 0,
      allowedModels: options.allowedModels ?? [],
      accountPool: options.accountPool ?? [],
      priority: options.priority ?? "normal",
      usage: {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        todayRequests: 0,
        todayDate: new Date().toISOString().slice(0, 10),
        minuteRequests: 0,
        minuteTimestamp: 0,
      },
    };

    this.keys.set(entry.id, entry);
    this.keyIndex.set(entry.key, entry.id);
    this.schedulePersist();
    return entry;
  }

  /** Validate a key and return its entry (or null if invalid/disabled/rate-limited). */
  validate(key: string): ProxyKeyEntry | null {
    const id = this.keyIndex.get(key);
    if (!id) return null;
    const entry = this.keys.get(id);
    if (!entry || !entry.enabled) return null;
    return entry;
  }

  /** Check if a key is allowed to use a specific model. */
  isModelAllowed(entry: ProxyKeyEntry, model: string): boolean {
    if (entry.allowedModels.length === 0) return true; // all allowed
    return entry.allowedModels.some((allowed) => {
      if (allowed === model) return true;
      // Support wildcard patterns: "gpt-5.*" matches "gpt-5.4", "gpt-5.4-mini"
      if (allowed.includes("*")) {
        const regex = new RegExp("^" + allowed.replace(/\*/g, ".*") + "$");
        return regex.test(model);
      }
      return false;
    });
  }

  /** Check rate limits. Returns null if OK, or error message if exceeded. */
  checkRateLimit(entry: ProxyKeyEntry): string | null {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // Reset daily counter if day changed
    if (entry.usage.todayDate !== today) {
      entry.usage.todayDate = today;
      entry.usage.todayRequests = 0;
    }

    // Reset minute counter if minute changed
    const currentMinute = Math.floor(now / 60000);
    if (entry.usage.minuteTimestamp !== currentMinute) {
      entry.usage.minuteTimestamp = currentMinute;
      entry.usage.minuteRequests = 0;
    }

    if (entry.rateLimit_rpm > 0 && entry.usage.minuteRequests >= entry.rateLimit_rpm) {
      return `Rate limit exceeded: ${entry.rateLimit_rpm} requests per minute`;
    }

    if (entry.rateLimit_rpd > 0 && entry.usage.todayRequests >= entry.rateLimit_rpd) {
      return `Rate limit exceeded: ${entry.rateLimit_rpd} requests per day`;
    }

    return null;
  }

  /** Record a request against a key's usage counters. */
  recordUsage(
    keyId: string,
    tokens?: { inputTokens?: number; outputTokens?: number },
  ): void {
    const entry = this.keys.get(keyId);
    if (!entry) return;

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const currentMinute = Math.floor(now / 60000);

    if (entry.usage.todayDate !== today) {
      entry.usage.todayDate = today;
      entry.usage.todayRequests = 0;
    }
    if (entry.usage.minuteTimestamp !== currentMinute) {
      entry.usage.minuteTimestamp = currentMinute;
      entry.usage.minuteRequests = 0;
    }

    entry.usage.totalRequests++;
    entry.usage.todayRequests++;
    entry.usage.minuteRequests++;

    if (tokens?.inputTokens) entry.usage.totalInputTokens += tokens.inputTokens;
    if (tokens?.outputTokens) entry.usage.totalOutputTokens += tokens.outputTokens;

    this.schedulePersist();
  }

  /** List all keys (with key values masked for non-admin display). */
  listAll(maskKeys = true): Array<ProxyKeyEntry & { maskedKey?: string }> {
    return [...this.keys.values()].map((entry) => ({
      ...entry,
      ...(maskKeys ? { key: `${entry.key.slice(0, 12)}...${entry.key.slice(-4)}`, maskedKey: entry.key.slice(0, 12) } : {}),
    }));
  }

  /** Revoke a key by ID. */
  revoke(keyId: string): boolean {
    const entry = this.keys.get(keyId);
    if (!entry) return false;
    entry.enabled = false;
    this.schedulePersist();
    return true;
  }

  /** Delete a key entirely. */
  delete(keyId: string): boolean {
    const entry = this.keys.get(keyId);
    if (!entry) return false;
    this.keys.delete(keyId);
    this.keyIndex.delete(entry.key);
    this.schedulePersist();
    return true;
  }

  /** Re-enable a revoked key. */
  enable(keyId: string): boolean {
    const entry = this.keys.get(keyId);
    if (!entry) return false;
    entry.enabled = true;
    this.schedulePersist();
    return true;
  }

  /** Get count of active keys. */
  get activeCount(): number {
    let count = 0;
    for (const entry of this.keys.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  // ── Persistence ──

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistSync();
    }, 2000);
  }

  private persistSync(): void {
    try {
      const file = getKeysFile();
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data: ProxyKeysFile = {
        _version: 1,
        keys: [...this.keys.values()],
      };
      writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn("[MultiKeyManager] Persist failed:", err instanceof Error ? err.message : err);
    }
  }

  private load(): void {
    try {
      const file = getKeysFile();
      if (!existsSync(file)) return;
      const raw = readFileSync(file, "utf-8");
      const data = JSON.parse(raw) as ProxyKeysFile;
      if (data._version !== 1 || !Array.isArray(data.keys)) return;

      for (const entry of data.keys) {
        this.keys.set(entry.id, entry);
        this.keyIndex.set(entry.key, entry.id);
      }

      if (this.keys.size > 0) {
        console.log(`[MultiKeyManager] Loaded ${this.keys.size} proxy key(s)`);
      }
    } catch (err) {
      console.warn("[MultiKeyManager] Load failed:", err instanceof Error ? err.message : err);
    }
  }

  destroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistSync();
  }
}

/** Singleton */
let _singleton: MultiKeyManager | null = null;

export function getMultiKeyManager(): MultiKeyManager {
  if (!_singleton) _singleton = new MultiKeyManager();
  return _singleton;
}

export function _resetMultiKeyManagerForTests(): void {
  _singleton = null;
}
