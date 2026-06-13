/**
 * Stream Recovery — detects and handles mid-stream failures with transparent
 * retry when the response hasn't committed yet.
 *
 * A stream is "uncommitted" if no content delta has been sent to the client.
 * During this phase (reasoning/setup), if the upstream connection dies,
 * we can transparently retry on the same account without the client noticing.
 *
 * Once the first output_text.delta is sent, the stream is "committed" —
 * the client has seen partial content and we can't retry without duplication.
 * In that case, we send an error SSE event and close gracefully.
 *
 * This module provides tracking state and recovery decision logic.
 */

export type StreamPhase = "setup" | "reasoning" | "committed";

export interface StreamRecoveryState {
  phase: StreamPhase;
  bytesSentToClient: number;
  firstContentAt: number | null;
  eventsReceived: number;
  responseId: string | null;
}

/**
 * Create a new stream recovery state tracker.
 */
export function createStreamRecoveryState(): StreamRecoveryState {
  return {
    phase: "setup",
    bytesSentToClient: 0,
    firstContentAt: null,
    eventsReceived: 0,
    responseId: null,
  };
}

/**
 * Update stream state based on a forwarded SSE event type.
 */
export function updateStreamState(
  state: StreamRecoveryState,
  eventType: string,
  chunkBytes: number,
): void {
  state.eventsReceived++;
  state.bytesSentToClient += chunkBytes;

  switch (eventType) {
    case "response.created":
    case "response.in_progress":
      // Still in setup phase
      break;

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary_part.added":
      // Reasoning phase — still recoverable (reasoning is regenerated on retry)
      if (state.phase === "setup") state.phase = "reasoning";
      break;

    case "response.output_text.delta":
    case "response.content_part.delta":
    case "response.function_call_arguments.delta":
      // Content committed — no longer recoverable
      if (state.phase !== "committed") {
        state.phase = "committed";
        state.firstContentAt = Date.now();
      }
      break;

    case "response.output_item.added":
    case "response.output_item.done":
    case "response.function_call_arguments.done":
      // These are structural events but may contain committed content
      if (state.phase !== "committed") {
        state.phase = "committed";
        state.firstContentAt = Date.now();
      }
      break;
  }
}

/**
 * Determine if the stream can be transparently retried after a failure.
 * Returns true if the client hasn't seen any actual content yet.
 */
export function canRetryStream(state: StreamRecoveryState): boolean {
  return state.phase !== "committed";
}

/**
 * Maximum bytes of "setup/reasoning" content we'll allow before considering
 * the stream committed anyway (safety net for edge cases).
 */
export const MAX_RECOVERABLE_BYTES = 16_384; // 16KB

/**
 * Additional check: even if technically uncommitted, if too much data
 * has been sent, don't retry (avoids confusing clients that buffer).
 */
export function isRecoveryAdvisable(state: StreamRecoveryState): boolean {
  if (state.phase === "committed") return false;
  if (state.bytesSentToClient > MAX_RECOVERABLE_BYTES) return false;
  return true;
}
