/**
 * Webhook Notifier — sends event notifications to a configurable webhook URL.
 *
 * Supports ntfy, Slack, Discord, and generic HTTP POST targets.
 * Events are fire-and-forget with basic retry on failure.
 *
 * Events:
 *   - account_disabled: An account was disabled (banned, CF-blocked, auto-paused)
 *   - account_recovered: An account was auto-recovered from disabled state
 *   - quota_warning: An account's quota usage crossed a warning threshold
 *   - quota_exhausted: All accounts are rate-limited / exhausted
 *   - all_accounts_down: No active accounts available
 *   - stealth_pause: An account was auto-paused by stealth anomaly detection
 *   - circuit_open: A circuit breaker tripped open
 */

import { getConfig } from "../config.js";

export type WebhookEventType =
  | "account_disabled"
  | "account_recovered"
  | "quota_warning"
  | "quota_exhausted"
  | "all_accounts_down"
  | "stealth_pause"
  | "circuit_open";

export interface WebhookEvent {
  type: WebhookEventType;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

/**
 * Send a webhook notification. Fire-and-forget — errors are logged but never thrown.
 */
export async function sendWebhookNotification(event: WebhookEvent): Promise<void> {
  let webhookUrl: string | null = null;
  try {
    const config = getConfig() as { notifications?: { webhook_url?: string | null } };
    webhookUrl = config.notifications?.webhook_url ?? null;
  } catch {
    return; // Config not loaded
  }

  if (!webhookUrl) return;

  // Also check environment variable as override
  const envUrl = process.env.CODEX_PROXY_WEBHOOK_URL;
  const targetUrl = envUrl || webhookUrl;
  if (!targetUrl) return;

  const payload = {
    ...event,
    source: "codex-proxy",
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const isNtfy = targetUrl.includes("ntfy.sh") || targetUrl.includes("/ntfy");
      const isSlack = targetUrl.includes("hooks.slack.com");
      const isDiscord = targetUrl.includes("discord.com/api/webhooks");

      let body: string;
      let headers: Record<string, string>;

      if (isNtfy) {
        // ntfy uses plain text body with title header
        headers = {
          "Title": `Codex Proxy: ${event.type}`,
          "Priority": event.type === "all_accounts_down" ? "urgent" : "default",
          "Tags": event.type,
        };
        body = event.message;
      } else if (isSlack) {
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify({
          text: `*${event.type}*: ${event.message}`,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*${event.type}*\n${event.message}` },
            },
          ],
        });
      } else if (isDiscord) {
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify({
          content: `**${event.type}**: ${event.message}`,
          embeds: [{
            title: event.type,
            description: event.message,
            timestamp: event.timestamp,
            color: event.type === "all_accounts_down" ? 0xff0000 : 0xffa500,
          }],
        });
      } else {
        // Generic JSON webhook
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify(payload);
      }

      const response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return; // Success

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      // Client error or final retry — give up silently
      console.warn(
        `[Webhook] Failed to deliver ${event.type}: HTTP ${response.status}`,
      );
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      console.warn(
        `[Webhook] Failed to deliver ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
}

/**
 * Convenience helpers for common events.
 */
export function notifyAccountDisabled(entryId: string, email: string | null, reason: string): void {
  void sendWebhookNotification({
    type: "account_disabled",
    message: `Account ${email ?? entryId} was disabled: ${reason}`,
    details: { entryId, email, reason },
    timestamp: new Date().toISOString(),
  });
}

export function notifyAccountRecovered(entryId: string, email: string | null): void {
  void sendWebhookNotification({
    type: "account_recovered",
    message: `Account ${email ?? entryId} recovered from disabled state`,
    details: { entryId, email },
    timestamp: new Date().toISOString(),
  });
}

export function notifyAllAccountsDown(): void {
  void sendWebhookNotification({
    type: "all_accounts_down",
    message: "No active accounts available. All accounts are disabled, banned, or rate-limited.",
    timestamp: new Date().toISOString(),
  });
}

export function notifyQuotaExhausted(entryId: string, email: string | null): void {
  void sendWebhookNotification({
    type: "quota_exhausted",
    message: `Account ${email ?? entryId} quota exhausted`,
    details: { entryId, email },
    timestamp: new Date().toISOString(),
  });
}

export function notifyStealthPause(entryId: string, email: string | null, hourlyCount: number): void {
  void sendWebhookNotification({
    type: "stealth_pause",
    message: `Account ${email ?? entryId} auto-paused: ${hourlyCount} requests this hour`,
    details: { entryId, email, hourlyCount },
    timestamp: new Date().toISOString(),
  });
}

export function notifyCircuitOpen(entryId: string, consecutiveOpens: number): void {
  void sendWebhookNotification({
    type: "circuit_open",
    message: `Circuit breaker opened for account ${entryId} (${consecutiveOpens} consecutive opens)`,
    details: { entryId, consecutiveOpens },
    timestamp: new Date().toISOString(),
  });
}
