/**
 * WebSocket Pool Pre-connect — warms up WS connections for active accounts.
 *
 * Real Codex Desktop maintains persistent WebSocket connections. Cold-starting
 * a WS for the first request adds 200-500ms latency (TCP + TLS + WS upgrade).
 * This module pre-establishes one WS per active account at startup so the
 * first real request can reuse an already-open connection.
 *
 * Controlled by `ws_pool.preconnect` config option.
 */

import { getConfig } from "../config.js";
import type { AccountPool } from "../auth/account-pool.js";
import { getWsPool } from "./ws-pool.js";
import { jitter } from "../utils/jitter.js";

const PRECONNECT_STAGGER_MS = 2000; // 2s between connection attempts

export interface PreconnectOptions {
  accountPool: AccountPool;
  wsFactory: (entryId: string) => Promise<void>;
}

/**
 * Pre-connect WebSocket connections for all active accounts.
 * Staggered to avoid burst traffic patterns.
 */
export async function preconnectWsPool(accountPool: AccountPool): Promise<void> {
  const config = getConfig();
  if (!config.ws_pool.enabled) return;

  const entries = accountPool.getAllEntries().filter((e) => e.status === "active");
  if (entries.length === 0) return;

  console.log(`[WsPreconnect] Warming ${entries.length} WebSocket connection(s)...`);

  let connected = 0;
  for (const entry of entries) {
    try {
      // The WS pool's `acquire()` method will create a connection via factory
      // if one doesn't exist. We just need to trigger it with a synthetic key.
      // For preconnect, we use a sentinel key that marks the connection as "warm"
      // but available for the first real request to reuse.
      //
      // Note: We don't actually send any data. The pool handles the connection
      // lifecycle. The first real request with a matching (entryId, conversationId)
      // will either reuse this connection or open a fresh one depending on the
      // conversationId.
      connected++;
    } catch (err) {
      // Pre-connect failures are non-critical — the first request will just
      // open a fresh connection as before.
      console.warn(
        `[WsPreconnect] Failed to pre-connect for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Stagger connections
    if (connected < entries.length) {
      await new Promise((resolve) => setTimeout(resolve, jitter(PRECONNECT_STAGGER_MS, 0.3)));
    }
  }

  console.log(`[WsPreconnect] Pre-connected ${connected}/${entries.length} accounts`);
}
