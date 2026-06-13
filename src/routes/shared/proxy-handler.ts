/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-egress-log.ts     — upstream request audit log entries
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - proxy-error-retry-transition.ts — CodexApiError retry/release/fallback transition
 *   - proxy-fallback-account-retry.ts — fallback account acquire / API rebuild
 *   - proxy-implicit-resume-lifecycle.ts — implicit-resume state machine / rollback
 *   - proxy-implicit-resume-request.ts — implicit-resume request apply/restore state
 *   - proxy-request-preparation.ts — request input/default forwarding fields
 *   - proxy-session-context.ts — prompt cache / affinity / implicit-resume derived state
 *   - proxy-retry-recovery.ts — same-account retry recovery decision/application
 *   - proxy-upstream-attempt.ts — one upstream request attempt + egress/rate-limit capture
 *   - proxy-debug-dump.ts     — opt-in request payload diagnostics
 *   - proxy-request-diagnostics.ts — request summary / large payload logs
 *   - proxy-stagger.ts        — request interval staggering
 *   - proxy-ws-context.ts     — WebSocket pool context construction
 *   - streaming-handler.ts    — streaming (SSE) response lifecycle
 *   - non-streaming-handler.ts — collect / retry response lifecycle
 */

import { CodexApi, CodexApiError } from "../../proxy/codex-api.js";
import { toQuota } from "../../auth/quota-utils.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import { handleStreaming } from "./streaming-handler.js";
import { handleNonStreaming } from "./non-streaming-handler.js";
import { recordRequestAndCheckAnomaly, peekHourlyCount } from "../../auth/usage-anomaly-detector.js";
import { canRequest as circuitBreakerCanRequest, recordSuccess as circuitBreakerSuccess, recordFailure as circuitBreakerFailure } from "../../proxy/circuit-breaker.js";
import { notifyStealthPause } from "../../utils/webhook-notifier.js";
import { annotateImageGenOutcome, buildCodexApi } from "./proxy-handler-utils.js";
import type {
  FormatAdapter,
  HandleProxyRequestOptions,
  ProxyRequest,
} from "./proxy-handler-types.js";
import { getSessionAffinityMap } from "../../auth/session-affinity.js";
import { randomUUID } from "crypto";
import {
  respondWithNoAccount,
  respondWithProxyError,
} from "./proxy-error-response.js";
import { applyProxyErrorRetryTransition } from "./proxy-error-retry-transition.js";
import { createImplicitResumeLifecycle } from "./proxy-implicit-resume-lifecycle.js";
import { captureImplicitResumeRequestState } from "./proxy-implicit-resume-request.js";
import {
  applyProxyRequestForwardingDefaults,
  ensureProxyRequestInputArray,
} from "./proxy-request-preparation.js";
import { logRequestDiagnostics } from "./proxy-request-diagnostics.js";
import {
  applyProxyRetryRecoveryDecision,
  applyCascadingBanDefense,
  buildProxyRetryRecoveryDecision,
} from "./proxy-retry-recovery.js";
import { classifyRetryAction } from "./proxy-retry-classifier.js";
import { buildProxySessionContext } from "./proxy-session-context.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { sendProxyUpstreamAttempt } from "./proxy-upstream-attempt.js";
import { buildWsPoolContext } from "./proxy-ws-context.js";
import {
  containsInvalidEncryptedContentSignal,
  getReasoningReplayCache,
} from "../../proxy/reasoning-replay-cache.js";
import { responseCache } from "../../proxy/response-cache.js";
import { globalConcurrencySemaphore } from "../../utils/concurrency-semaphore.js";
import { getAccountWaitQueue } from "../../auth/account-wait-queue.js";
import { generateDedupKey, getDedupInFlight, registerDedupInFlight } from "../../proxy/request-dedup.js";
import { getAnalytics } from "../../logs/analytics.js";
import { getPromptCacheTracker } from "../../proxy/prompt-cache-tracker.js";
import { compressContext, shouldCompressContext } from "../../translation/context-compressor.js";
import { recordModelRequest } from "../../proxy/model-request-counters.js";

export async function handleProxyRequest(options: HandleProxyRequestOptions): Promise<Response> {
  const { c, accountPool, cookieJar, req, fmt, proxyPool } = options;
  c.set("logForwarded", true);

  const affinityMap = getSessionAffinityMap();
  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  ensureProxyRequestInputArray(req);
  const originalRequestState = captureImplicitResumeRequestState(req);
  const sessionContext = buildProxySessionContext({ request: req, affinityMap });

  // Turn state: sticky routing token from upstream, echoed back on subsequent requests
  applyProxyRequestForwardingDefaults({
    request: req,
    promptCacheKey: sessionContext.promptCacheKey,
    explicitTurnState: sessionContext.explicitTurnState,
  });

  // Check if we have a cached response
  const cacheKey = !req.isStreaming && !req.expectsImageGen 
    ? responseCache.generateKey(req.model, req.codexRequest.input ?? [])
    : null;

  if (cacheKey) {
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      console.log(`[${fmt.tag}] ⚡ Cache hit for non-streaming request`);
      c.set("logCacheHit", true);
      return c.json(cachedResponse);
    }
  }

  // ── Request Deduplication ──
  // If the exact same non-streaming request is already in-flight, piggyback
  // on its result instead of hitting upstream twice (double-click protection).
  const dedupKey = generateDedupKey(req.model, req.codexRequest.input, req.isStreaming);
  if (dedupKey) {
    const inFlight = getDedupInFlight(dedupKey);
    if (inFlight) {
      console.log(`[${fmt.tag}] ⚡ Dedup hit — piggybacking on in-flight request`);
      const result = await inFlight;
      return c.json(result as object);
    }
  }

  // ── Context Compression ──
  // For long conversations without server-side history, compress middle turns
  // to save tokens and reduce latency.
  if (shouldCompressContext(req.codexRequest.input as unknown[] | undefined, req.codexRequest.previous_response_id)) {
    const input = req.codexRequest.input as unknown[];
    const compressed = compressContext(input);
    if (compressed !== input) {
      console.log(`[${fmt.tag}] 📦 Context compressed: ${input.length} → ${compressed.length} items`);
      req.codexRequest.input = compressed as typeof req.codexRequest.input;
    }
  }

  const released = new Set<string>();
  const verifiedExcludeIds: string[] = [];

  // Single acquire call — preferredEntryId is a hint, not a hard requirement
  let acquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag, sessionContext.preferredEntryId ?? undefined);

  // ── Graceful Degradation: Wait Queue ──
  // If no account is immediately available, wait briefly for one to be released
  // instead of returning 503 instantly.
  if (!acquired) {
    const waitQueue = getAccountWaitQueue();
    const gotRelease = await waitQueue.waitForRelease();
    if (gotRelease) {
      acquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag, sessionContext.preferredEntryId ?? undefined);
    }
  }
  if (!acquired) {
    return respondWithNoAccount({ c, req, fmt });
  }

  // ── Usage Anomaly Check ──
  // When stealth mode is enabled, check if this account is hitting anomalous
  // request volumes that could trigger upstream detection.
  const anomalyAction = recordRequestAndCheckAnomaly(acquired.entryId);
  if (anomalyAction === "pause") {
    console.warn(
      `[${fmt.tag}] ⚠️ Stealth: Account ${acquired.entryId} hit hourly request pause threshold. ` +
      `Auto-pausing to avoid detection.`,
    );
    notifyStealthPause(acquired.entryId, null, peekHourlyCount(acquired.entryId));
    releaseAccount(accountPool, acquired.entryId, undefined, released);
    // Try another account
    verifiedExcludeIds.push(acquired.entryId);
    acquired = acquireAccount(accountPool, req.codexRequest.model, [acquired.entryId], fmt.tag, undefined);
    if (!acquired) {
      return respondWithProxyError({
        c, req, fmt,
        status: 429,
        message: "All accounts paused due to high request volume. Retry in a few minutes.",
      });
    }
  } else if (anomalyAction === "throttle") {
    console.warn(
      `[${fmt.tag}] ⚠️ Stealth: Account ${acquired.entryId} exceeded hourly throttle threshold. Adding extra delay.`,
    );
    // Add significant extra delay to slow down request rate
    await new Promise((resolve) => setTimeout(resolve, 3000 + Math.floor(Math.random() * 4000)));
  } else if (anomalyAction === "warn") {
    console.warn(
      `[${fmt.tag}] ⚠️ Stealth: Account ${acquired.entryId} approaching hourly request limit.`,
    );
  }

  // ── Circuit Breaker Check ──
  // If this account's circuit is open (too many consecutive upstream failures),
  // skip it and try another account to avoid hammering a broken path.
  if (!circuitBreakerCanRequest(acquired.entryId)) {
    releaseAccount(accountPool, acquired.entryId, undefined, released);
    acquired = acquireAccount(accountPool, req.codexRequest.model, [acquired.entryId, ...verifiedExcludeIds], fmt.tag, undefined);
    if (!acquired) {
      return respondWithNoAccount({ c, req, fmt });
    }
  }

  // ── Drift-Defense & Verification Loop ──
  // Caps the number of upstream /usage checks per request to avoid amplification
  // when many accounts are simultaneously dirty.
  const MAX_VERIFY_ATTEMPTS = 5;
  let verifyAttempts = 0;
  for (;;) {
    if (!acquired) return respondWithNoAccount({ c, req, fmt });
    const entry = accountPool.getEntry(acquired.entryId);
    if (entry?.quotaVerifyRequired) {
      const verifyingEntryId = acquired.entryId;
      console.log(`[${fmt.tag}] 🔍 Account ${verifyingEntryId} (${entry.email ?? "?"}) requires quota verification due to local reset. Syncing with upstream...`);
      try {
        const usage = await new CodexApi(
          acquired.token,
          acquired.accountId,
          cookieJar,
          acquired.entryId,
          proxyPool?.resolveProxyUrl(acquired.entryId),
        ).getUsage();
        
        const quota = toQuota(usage);
        accountPool.updateCachedQuota(acquired.entryId, quota);

        if (quota.rate_limit.limit_reached) {
          console.warn(`[${fmt.tag}] 🚫 Upstream reports account ${acquired.entryId} is still limit_reached. Releasing and retrying another...`);
          releaseAccount(accountPool, acquired.entryId, undefined, released);
          verifiedExcludeIds.push(acquired.entryId);

          verifyAttempts++;
          if (verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
            console.warn(`[${fmt.tag}] ⚠️ Drift-defense hit MAX_VERIFY_ATTEMPTS (${MAX_VERIFY_ATTEMPTS}). Giving up to avoid excess upstream calls.`);
            return respondWithNoAccount({ c, req, fmt });
          }

          acquired = acquireAccount(accountPool, req.codexRequest.model, verifiedExcludeIds, fmt.tag, sessionContext.preferredEntryId ?? undefined);
          if (!acquired) {
            return respondWithNoAccount({ c, req, fmt });
          }
          continue; // Loop back to check the newly acquired account
        }
      } catch (err) {
        console.warn(`[${fmt.tag}] ⚠️ Failed to verify dirty quota for ${verifyingEntryId}:`, err);
        // Keep quotaVerifyRequired=true so the flag isn't silently cleared on transient network errors.
        // The ActiveQuotaRefresher or the next request will retry. This avoids promoting a still-limited
        // account to "clean" just because the upstream check temporarily failed.
      }
    }
    break; // Verified or no verification required, proceed!
  }

  if (!acquired) return respondWithNoAccount({ c, req, fmt });
  let { entryId } = acquired;

  // Expose account + model info to the log-capture middleware
  c.set("logAccountId", entryId);
  c.set("logModel", req.model);

  // ── Session Affinity Fallback Defense (Cascading Ban Prevention) ──
  // Only strip session identifiers when the preferred account is banned/disabled.
  // Quota exhaustion is normal rotation — no ban propagation risk.
  if (sessionContext.preferredEntryId && sessionContext.preferredEntryId !== entryId) {
    const preferredEntry = accountPool.getEntry(sessionContext.preferredEntryId);
    applyCascadingBanDefense({
      request: req,
      affinityMap,
      preferredEntryId: sessionContext.preferredEntryId,
      acquiredEntryId: entryId,
      preferredStatus: preferredEntry?.status,
      explicitPrevRespId: sessionContext.explicitPrevRespId,
      tag: fmt.tag,
    });
  }
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  const triedEntryIds: string[] = [entryId];
  let modelRetried = false;
  let stripAndRetryDone = false;
  const reasoningReplayCache = getReasoningReplayCache();
  const reasoningReplayItems = sessionContext.implicitPrevRespId
    ? reasoningReplayCache.lookup({
        responseId: sessionContext.implicitPrevRespId,
        entryId,
        conversationId: sessionContext.chainConversationId,
        variantHash: sessionContext.variantHash,
      })
    : [];

  const implicitResume = createImplicitResumeLifecycle({
    request: req,
    snapshot: originalRequestState,
    affinityMap,
    tag: fmt.tag,
    implicitPrevRespId: sessionContext.implicitPrevRespId,
    continuationInputStart: sessionContext.continuationInputStart,
    reasoningReplayItems,
    resumeEvaluationInput: sessionContext.resumeEvaluationInput,
    acquiredEntryId: entryId,
  });
  implicitResume.logSkippedWarnings();
  implicitResume.activate();

  const diagnostics = logRequestDiagnostics({
    tag: fmt.tag,
    entryId,
    requestId,
    request: req,
    chainConversationId: sessionContext.chainConversationId,
    promptCacheKey: sessionContext.promptCacheKey,
    variantHash: sessionContext.variantHash,
    explicitPrevRespId: sessionContext.explicitPrevRespId,
    implicitPrevRespId: sessionContext.implicitPrevRespId,
    prevRespId: sessionContext.prevRespId,
    resumeActive: implicitResume.evaluation.active,
    resumeReason: implicitResume.evaluation.reason,
    preferredEntryId: sessionContext.preferredEntryId,
  });

  // Guard: when implicit resume fails due to missing tool calls, block runaway
  // full-history replays that would burn massive token budgets silently.
  // Relaxed thresholds: legitimate client-driven full replays (e.g. after
  // Codex CLI /compact) regularly hit 300-800KB / 100-800 items, and the
  // previous 250KB / 80-item gate was 413'ing them. Real runaway loops
  // typically blow past several MB before the issue becomes obvious.
  const PAYLOAD_GUARD_BYTES = 2_000_000;
  const PAYLOAD_GUARD_ITEMS = 1000;
  if (
    implicitResume.evaluation.reason === "missing_tool_calls" ||
    implicitResume.evaluation.reason === "unanswered_tool_calls"
  ) {
    const inputItemCount = req.codexRequest.input?.length ?? 0;
    if (diagnostics.payloadBytes > PAYLOAD_GUARD_BYTES || inputItemCount > PAYLOAD_GUARD_ITEMS) {
      console.warn(
        `[${fmt.tag}] ⛔ Payload guard: blocking ${(diagnostics.payloadBytes / 1024).toFixed(0)}KB / ${inputItemCount} items ` +
        `full-history replay (resume=${implicitResume.evaluation.reason}). ` +
        `Client should compact the conversation.`,
      );
      releaseAccount(accountPool, entryId, undefined, released);
      return respondWithProxyError({
        c, req, fmt,
        status: 413,
        message:
          `Context too large for full-history replay ` +
          `(${(diagnostics.payloadBytes / 1024).toFixed(0)}KB, ${inputItemCount} items). ` +
          `Implicit resume failed: ${implicitResume.evaluation.reason}. ` +
          `Please compact or restart the conversation.`,
      });
    }
  }

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  await staggerIfNeeded(acquired.prevSlotMs);

  // Track request start time for duration header
  const requestStartMs = Date.now();
  c.header("X-Provider-Used", "codex");

  const buildPoolCtx = (forEntryId: string = entryId) =>
    buildWsPoolContext({
      useWebSocket: req.codexRequest.useWebSocket,
      conversationId: sessionContext.chainConversationId,
      entryId: forEntryId,
      variantHash: sessionContext.variantHash,
      requestId,
      tag: fmt.tag,
    });

  const MAX_RETRY_ITERATIONS = 10;
  let retryIteration = 0;
  for (;;) {
    if (++retryIteration > MAX_RETRY_ITERATIONS) {
      releaseAccount(accountPool, entryId, undefined, released);
      console.error(`[${fmt.tag}] ⛔ Hit MAX_RETRY_ITERATIONS (${MAX_RETRY_ITERATIONS}) for request ${requestId}. Aborting.`);
      return respondWithProxyError({
        c, req, fmt,
        status: 502,
        message: `Request failed after ${MAX_RETRY_ITERATIONS} retry attempts. All upstream attempts exhausted.`,
      });
    }
    await globalConcurrencySemaphore.acquire();
    let semaphoreReleased = false;
    const releaseSemaphore = () => {
      if (!semaphoreReleased) {
        semaphoreReleased = true;
        globalConcurrencySemaphore.release();
      }
    };

    try {
      // Ensure semaphore is released if client disconnects early or network drops
      const abortListener = () => releaseSemaphore();
      c.req.raw.signal.addEventListener("abort", abortListener, { once: true });

      const { rawResponse, upstreamTurnState } = await sendProxyUpstreamAttempt({
        accountPool,
        api: codexApi,
        request: req,
        entryId,
        abortSignal: abortController.signal,
        buildPoolCtx,
        requestId,
        tag: fmt.tag,
        conversationId: sessionContext.chainConversationId,
        implicitResumeActive: implicitResume.isActive(),
        resumeReason: implicitResume.resumeReasonForAttempt(),
      });

      // Circuit breaker: record successful upstream connection
      circuitBreakerSuccess(entryId);
      recordModelRequest(req.model);

      // ── Streaming path ──
      if (req.isStreaming) {
        c.header("X-Request-Duration-Ms", String(Date.now() - requestStartMs));
        // Hono streams execute asynchronously. The `handleStreaming` response is
        // returned instantly. We release the semaphore when the stream finishes or errors.
        const originalOnResponseCompleted = fmt.streamTranslator;
        return handleStreaming({
          c,
          accountPool,
          req,
          fmt: {
             ...fmt,
             streamTranslator: (...args: Parameters<typeof fmt.streamTranslator>) => {
               const gen = fmt.streamTranslator(...args);
               return (async function* () {
                 try {
                   yield* gen;
                 } finally {
                   releaseSemaphore();
                 }
               })();
             }
          },
          api: codexApi,
          response: rawResponse,
          entryId,
          abortController,
          released,
          requestId,
          affinityMap,
          conversationId: sessionContext.chainConversationId,
          turnState: upstreamTurnState,
          usageHint: implicitResume.getUsageHint(),
          variantHash: sessionContext.variantHash,
        });
      }

      // ── Non-streaming path (with empty-response retry) ──
      const nonStreamingResponse = await handleNonStreaming({
        c,
        accountPool,
        cookieJar,
        req,
        fmt,
        proxyPool,
        initialApi: codexApi,
        initialResponse: rawResponse,
        initialEntryId: entryId,
        abortController,
        released,
        requestId,
        affinityMap,
        conversationId: sessionContext.chainConversationId,
        turnState: upstreamTurnState,
        getUsageHint: () => implicitResume.getUsageHint(),
        restoreImplicitResumeRequest: implicitResume.restore,
        buildPoolCtx,
        setActiveAccount: (nextEntryId, nextApi) => {
          entryId = nextEntryId;
          codexApi = nextApi;
          if (!triedEntryIds.includes(nextEntryId)) triedEntryIds.push(nextEntryId);
        },
        variantHash: sessionContext.variantHash,
      });

      // If we got a successful non-streaming response and we have a cache key, store it.
      if (cacheKey && nonStreamingResponse.status === 200) {
        // We need to clone it because we consume the body here
        const clonedResponse = nonStreamingResponse.clone();
        try {
          const jsonBody = await clonedResponse.json();
          // We only cache valid successful JSON responses
          if (jsonBody && !jsonBody.error) {
            responseCache.set(cacheKey, jsonBody);
            // Register with dedup so concurrent identical requests can share
            if (dedupKey) {
              registerDedupInFlight(dedupKey, Promise.resolve(jsonBody));
            }
          }
          // Record analytics
          const usage = (jsonBody as any)?.usage;
          if (usage) {
            getAnalytics().recordRequest({
              model: req.model,
              inputTokens: usage.prompt_tokens ?? usage.input_tokens,
              outputTokens: usage.completion_tokens ?? usage.output_tokens,
              cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens,
              isError: false,
            });
            // Track prompt cache
            const inputTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
            const cachedTok = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
            if (inputTok > 0) {
              getPromptCacheTracker().record({
                entryId,
                conversationId: sessionContext.chainConversationId,
                model: req.model,
                inputTokens: inputTok,
                cachedTokens: cachedTok,
              });
            }
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      releaseSemaphore();
      c.header("X-Request-Duration-Ms", String(Date.now() - requestStartMs));
      return nonStreamingResponse;
    } catch (err) {
      releaseSemaphore(); // Ensure semaphore is released before we sleep/retry or abort
      if (containsInvalidEncryptedContentSignal(err)) {
        reasoningReplayCache.evictByIdentity({
          entryId,
          conversationId: sessionContext.chainConversationId,
          variantHash: sessionContext.variantHash,
        });
      }
      const retryAction = classifyRetryAction(
        err,
        { stripAndRetryDone, modelRetried, implicitResumeActive: implicitResume.isActive(), previousResponseId: req.codexRequest.previous_response_id },
        (e) => implicitResume.canReplayAfterError(e),
      );

      switch (retryAction.type) {
        case "not_codex_error":
          releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
          throw err;

        case "implicit_resume_replay":
          implicitResume.replayFullInputAfterError(err);
          continue;

        case "strip_and_retry": {
          stripAndRetryDone = true;
          const decision = buildProxyRetryRecoveryDecision({
            err, tag: fmt.tag, entryId, stripAndRetryDone: false,
            previousResponseId: req.codexRequest.previous_response_id,
          });
          applyProxyRetryRecoveryDecision({
            decision,
            request: req,
            affinityMap,
            restoreImplicitResumeRequest: implicitResume.restore,
          });
          continue;
        }

        case "error_handler_decides": {
          // Record failure for circuit breaker
          circuitBreakerFailure(entryId);
          recordModelRequest(req.model, true);

          const decision = handleCodexApiError(
            err as CodexApiError, accountPool, entryId, req.codexRequest.model, fmt.tag, modelRetried, cookieJar, proxyPool
          );

          const errorRetryTransition = applyProxyErrorRetryTransition({
            accountPool, entryId,
            model: req.codexRequest.model,
            triedEntryIds, tag: fmt.tag,
            decision, released,
            restoreImplicitResumeRequest: implicitResume.restore,
            modelRetried,
            expectsImageGen: req.expectsImageGen,
            cookieJar, proxyPool,
          });
          if (errorRetryTransition.action === "respond") {
            return respondWithProxyError({
              c, req, fmt,
              status: errorRetryTransition.status,
              message: errorRetryTransition.message,
              ...(errorRetryTransition.useFormat429 ? { useFormat429: true } : {}),
            });
          }

          modelRetried = errorRetryTransition.modelRetried;
          entryId = errorRetryTransition.entryId;
          triedEntryIds.push(errorRetryTransition.entryId);
          codexApi = errorRetryTransition.api;
          await staggerIfNeeded(errorRetryTransition.prevSlotMs);
          continue;
        }
      }
    }
  }
}
