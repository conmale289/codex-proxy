/**
 * Utilities for handling Cloudflare Relay proxies.
 * Format: cf-relay://<worker-domain>
 */

export const CF_RELAY_SCHEME = "cf-relay://";

export interface CfRelayConfig {
  isRelay: boolean;
  relayUrl: string;
}

/**
 * Checks if a given proxy URL is a Cloudflare Relay.
 */
export function parseCfRelayUrl(proxyUrl: string | null | undefined): CfRelayConfig {
  if (!proxyUrl || !proxyUrl.startsWith(CF_RELAY_SCHEME)) {
    return { isRelay: false, relayUrl: "" };
  }

  // Remove the custom scheme and reconstruct as https
  const host = proxyUrl.slice(CF_RELAY_SCHEME.length);
  // Optional: strip trailing slash if present
  const cleanHost = host.replace(/\/$/, "");

  return {
    isRelay: true,
    relayUrl: `https://${cleanHost}`,
  };
}

/**
 * Mutates headers and returns the new target URL for HTTP requests.
 */
export function applyCfRelayToHttp(
  targetUrl: string,
  headers: Record<string, string>,
  relayUrl: string
): string {
  const urlObj = new URL(targetUrl);
  headers["x-relay-target"] = urlObj.origin;
  headers["x-relay-path"] = urlObj.pathname + urlObj.search;
  
  // The actual request goes to the CF worker
  return relayUrl;
}

/**
 * Mutates headers and returns the new target URL for WebSocket requests.
 */
export function applyCfRelayToWs(
  targetWsUrl: string,
  headers: Record<string, string>,
  relayUrl: string
): string {
  const urlObj = new URL(targetWsUrl);
  // HTTP equivalent of the WS origin
  const httpOrigin = urlObj.protocol === "wss:" ? `https://${urlObj.host}` : `http://${urlObj.host}`;
  headers["x-relay-target"] = httpOrigin;
  headers["x-relay-path"] = urlObj.pathname + urlObj.search;
  
  // Cloudflare worker URLs must be wss:// to upgrade correctly
  return relayUrl.replace(/^https?:/, "wss:");
}
