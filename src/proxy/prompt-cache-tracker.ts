/**
 * Prompt Cache Tracker — monitors prompt cache hit rates per account and
 * per conversation to surface optimization opportunities.
 *
 * Tracks:
 *   - Cache hit ratio: cached_tokens / input_tokens per request
 *   - Per-account aggregate hit rate
 *   - Per-conversation cache efficiency
 *   - Optimization suggestions (e.g., "instructions changed too frequently")
 *
 * Data is in-memory with a sliding window (last 1000 requests).
 * Exposed via /health/detailed and a dedicated /admin/cache-stats endpoint.
 */

export interface CacheRequestRecord {
  timestamp: number;
  entryId: string;
  conversationId: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  hitRatio: number;
}

export interface CacheStats {
  /** Overall hit ratio across all recent requests */
  overallHitRatio: number;
  /** Total requests tracked */
  totalRequests: number;
  /** Requests with any cache hits */
  requestsWithHits: number;
  /** Total tokens saved by cache hits */
  tokensSaved: number;
  /** Per-account breakdown */
  byAccount: Array<{
    entryId: string;
    requests: number;
    hitRatio: number;
    tokensSaved: number;
  }>;
  /** Top conversations by cache efficiency */
  topConversations: Array<{
    conversationId: string;
    requests: number;
    hitRatio: number;
  }>;
  /** Optimization suggestions */
  suggestions: string[];
}

const MAX_RECORDS = 1000;
const LOW_HIT_RATIO_THRESHOLD = 0.3; // Below 30% is suboptimal

export class PromptCacheTracker {
  private records: CacheRequestRecord[] = [];
  private instructionChangeCount = new Map<string, number>(); // conversationId → changes

  /** Record a completed request with token usage. */
  record(params: {
    entryId: string;
    conversationId: string;
    model: string;
    inputTokens: number;
    cachedTokens: number;
  }): void {
    if (params.inputTokens <= 0) return;

    const record: CacheRequestRecord = {
      timestamp: Date.now(),
      entryId: params.entryId,
      conversationId: params.conversationId,
      model: params.model,
      inputTokens: params.inputTokens,
      cachedTokens: params.cachedTokens,
      hitRatio: params.cachedTokens / params.inputTokens,
    };

    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }
  }

  /** Record that instructions changed within a conversation (anti-pattern). */
  recordInstructionChange(conversationId: string): void {
    const count = this.instructionChangeCount.get(conversationId) ?? 0;
    this.instructionChangeCount.set(conversationId, count + 1);
  }

  /** Get comprehensive cache statistics. */
  getStats(): CacheStats {
    if (this.records.length === 0) {
      return {
        overallHitRatio: 0,
        totalRequests: 0,
        requestsWithHits: 0,
        tokensSaved: 0,
        byAccount: [],
        topConversations: [],
        suggestions: [],
      };
    }

    let totalInput = 0;
    let totalCached = 0;
    let requestsWithHits = 0;
    const byAccount = new Map<string, { requests: number; inputTokens: number; cachedTokens: number }>();
    const byConversation = new Map<string, { requests: number; inputTokens: number; cachedTokens: number }>();

    for (const record of this.records) {
      totalInput += record.inputTokens;
      totalCached += record.cachedTokens;
      if (record.cachedTokens > 0) requestsWithHits++;

      // Per-account
      const acct = byAccount.get(record.entryId) ?? { requests: 0, inputTokens: 0, cachedTokens: 0 };
      acct.requests++;
      acct.inputTokens += record.inputTokens;
      acct.cachedTokens += record.cachedTokens;
      byAccount.set(record.entryId, acct);

      // Per-conversation
      const conv = byConversation.get(record.conversationId) ?? { requests: 0, inputTokens: 0, cachedTokens: 0 };
      conv.requests++;
      conv.inputTokens += record.inputTokens;
      conv.cachedTokens += record.cachedTokens;
      byConversation.set(record.conversationId, conv);
    }

    const overallHitRatio = totalInput > 0 ? totalCached / totalInput : 0;

    const accountStats = [...byAccount.entries()]
      .map(([entryId, stats]) => ({
        entryId,
        requests: stats.requests,
        hitRatio: stats.inputTokens > 0 ? stats.cachedTokens / stats.inputTokens : 0,
        tokensSaved: stats.cachedTokens,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);

    const convStats = [...byConversation.entries()]
      .filter(([, stats]) => stats.requests >= 3) // Only conversations with enough data
      .map(([conversationId, stats]) => ({
        conversationId,
        requests: stats.requests,
        hitRatio: stats.inputTokens > 0 ? stats.cachedTokens / stats.inputTokens : 0,
      }))
      .sort((a, b) => b.hitRatio - a.hitRatio)
      .slice(0, 5);

    // Generate suggestions
    const suggestions: string[] = [];

    if (overallHitRatio < LOW_HIT_RATIO_THRESHOLD && this.records.length >= 20) {
      suggestions.push(
        `Low overall cache hit rate (${(overallHitRatio * 100).toFixed(1)}%). ` +
        `Ensure conversations use consistent instructions and same accounts.`,
      );
    }

    // Check for accounts with very low hit rates
    for (const acct of accountStats) {
      if (acct.requests >= 10 && acct.hitRatio < 0.1) {
        suggestions.push(
          `Account ${acct.entryId} has very low cache hit rate (${(acct.hitRatio * 100).toFixed(1)}%). ` +
          `It may be getting routed to different backends.`,
        );
      }
    }

    // Check for conversations with too many instruction changes
    for (const [convId, changes] of this.instructionChangeCount) {
      if (changes >= 3) {
        suggestions.push(
          `Conversation ${convId.slice(0, 8)} changed instructions ${changes} times. ` +
          `Stabilize instructions for better cache hits.`,
        );
      }
    }

    return {
      overallHitRatio,
      totalRequests: this.records.length,
      requestsWithHits,
      tokensSaved: totalCached,
      byAccount: accountStats,
      topConversations: convStats,
      suggestions,
    };
  }

  /** Clear all tracking data. */
  clear(): void {
    this.records = [];
    this.instructionChangeCount.clear();
  }
}

/** Singleton */
let _singleton: PromptCacheTracker | null = null;

export function getPromptCacheTracker(): PromptCacheTracker {
  if (!_singleton) _singleton = new PromptCacheTracker();
  return _singleton;
}

export function _resetPromptCacheTrackerForTests(): void {
  _singleton = null;
}
