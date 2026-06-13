/**
 * Client Diversity — generates per-account variations of client fingerprint
 * parameters to reduce correlation signals.
 *
 * When stealth mode is enabled, each account gets slightly different:
 *   - Platform (darwin/linux/win32) — deterministic from entryId
 *   - Architecture (arm64/x64)
 *   - Chromium version (minor variation within ±2 of configured version)
 *
 * This prevents the obvious signal of 24 accounts all reporting identical
 * client fingerprints from the same installation.
 *
 * Design decisions:
 *   - Deterministic: same entryId always produces same fingerprint (no drift)
 *   - Realistic: only produces values that real Codex Desktop actually sends
 *   - Opt-in: only active when stealth.enabled = true
 *   - Non-breaking: falls back to global config values when disabled
 */

import { createHash } from "crypto";
import { getConfig } from "../config.js";

export interface ClientFingerprint {
  platform: string;
  arch: string;
  chromiumVersion: string;
}

/** Realistic platform + arch combinations that real Codex Desktop supports. */
const PLATFORM_COMBOS: Array<{ platform: string; arch: string }> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "win32", arch: "x64" },
];

/**
 * Derive a deterministic numeric index from an entryId string.
 * Uses SHA-256 and takes the first 4 bytes as a uint32.
 */
function deterministicIndex(entryId: string, salt: string): number {
  const hash = createHash("sha256").update(`${entryId}:${salt}`).digest();
  return hash.readUInt32BE(0);
}

/**
 * Get the client fingerprint for a specific account.
 * When stealth mode is disabled, returns the global config values.
 * When enabled, returns a deterministic per-account variation.
 */
export function getAccountClientFingerprint(entryId: string): ClientFingerprint {
  const config = getConfig();

  if (!config.stealth.enabled) {
    return {
      platform: config.client.platform,
      arch: config.client.arch,
      chromiumVersion: config.client.chromium_version,
    };
  }

  // Deterministically select a platform/arch combo for this account
  const platformIdx = deterministicIndex(entryId, "platform") % PLATFORM_COMBOS.length;
  const combo = PLATFORM_COMBOS[platformIdx];

  // Vary chromium version by ±2 (e.g., 146 → 144-148)
  const baseChromium = parseInt(config.client.chromium_version, 10) || 146;
  const chromiumOffset = (deterministicIndex(entryId, "chromium") % 5) - 2; // -2 to +2
  const chromiumVersion = String(baseChromium + chromiumOffset);

  return {
    platform: combo.platform,
    arch: combo.arch,
    chromiumVersion,
  };
}

/**
 * Build the sec-ch-ua-platform value for a platform string.
 */
export function secChUaPlatformForPlatform(platform: string): string {
  switch (platform) {
    case "darwin": return '"macOS"';
    case "linux": return '"Linux"';
    case "win32": return '"Windows"';
    default: return '"macOS"';
  }
}

/**
 * Build the User-Agent template replacement for per-account diversity.
 * The template uses {platform} and {arch} placeholders.
 */
export function buildDiverseUserAgent(
  template: string,
  appVersion: string,
  fingerprint: ClientFingerprint,
): string {
  return template
    .replace("{version}", appVersion)
    .replace("{platform}", fingerprint.platform)
    .replace("{arch}", fingerprint.arch);
}
