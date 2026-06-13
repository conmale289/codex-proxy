/**
 * Context Compressor — reduces input array size for long conversations
 * to save tokens and improve latency.
 *
 * Strategy (conservative):
 *   1. Count approximate tokens in the input array
 *   2. If below threshold, pass through unchanged
 *   3. If above threshold, apply smart truncation:
 *      - Keep the first message (system/instructions context)
 *      - Keep the most recent N turns verbatim (preserves immediate context)
 *      - Middle section: keep only assistant messages (drop tool outputs, keep summaries)
 *      - Add a "[context truncated]" marker so the model knows history was compressed
 *
 * This is NOT summarization (no LLM call). It's deterministic structural
 * compression that preserves the most relevant context while staying within
 * token budgets.
 *
 * Controlled by `model.context_compression` config section.
 */

import { getConfig } from "../config.js";

export interface ContextCompressionOptions {
  /** Maximum approximate character count before compression kicks in.
   *  Rough heuristic: 4 chars ≈ 1 token. Default 200,000 chars (≈50K tokens). */
  maxChars?: number;
  /** Number of recent items to preserve verbatim. Default 20. */
  keepRecentItems?: number;
  /** Number of initial items to preserve (system context). Default 2. */
  keepInitialItems?: number;
}

const DEFAULT_MAX_CHARS = 200_000; // ~50K tokens
const DEFAULT_KEEP_RECENT = 20;
const DEFAULT_KEEP_INITIAL = 2;

interface InputItem {
  type?: string;
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimateItemChars(item: unknown): number {
  if (typeof item === "string") return item.length;
  if (!isRecord(item)) return JSON.stringify(item).length;

  let chars = 0;
  const content = (item as InputItem).content;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && typeof part.text === "string") {
        chars += (part.text as string).length;
      } else {
        chars += JSON.stringify(part).length;
      }
    }
  } else if (content !== undefined) {
    chars += JSON.stringify(content).length;
  }

  // Add overhead for other fields
  const args = (item as InputItem).arguments;
  if (typeof args === "string") chars += args.length;
  const output = (item as InputItem).output;
  if (typeof output === "string") chars += output.length;

  return chars + 50; // base overhead for metadata
}

function estimateTotalChars(input: unknown[]): number {
  let total = 0;
  for (const item of input) {
    total += estimateItemChars(item);
  }
  return total;
}

/**
 * Types that are safe to drop from middle section (verbose, reconstructible).
 * We keep: message, reasoning, function_call (essential for context)
 * We drop: function_call_output (tool results — usually bulky and least-needed for context)
 */
function isDroppableInMiddle(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const type = (item as InputItem).type;
  return type === "function_call_output";
}

/**
 * Create a truncation marker item that tells the model context was compressed.
 */
function createTruncationMarker(droppedCount: number, droppedChars: number): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: `[Context compressed: ${droppedCount} items (≈${Math.round(droppedChars / 4)} tokens) removed from middle of conversation. Recent context preserved below.]`,
  };
}

/**
 * Compress a conversation input array if it exceeds the configured threshold.
 * Returns the input unchanged if compression is not needed.
 *
 * @param input - The Codex request input array
 * @param options - Override default thresholds (for testing or per-request config)
 * @returns Compressed input array (or original if under threshold)
 */
export function compressContext(
  input: unknown[],
  options?: ContextCompressionOptions,
): unknown[] {
  if (!input || input.length === 0) return input;

  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const keepRecent = options?.keepRecentItems ?? DEFAULT_KEEP_RECENT;
  const keepInitial = options?.keepInitialItems ?? DEFAULT_KEEP_INITIAL;

  const totalChars = estimateTotalChars(input);
  if (totalChars <= maxChars) return input;

  // Not enough items to compress meaningfully
  const minItems = keepInitial + keepRecent + 1;
  if (input.length <= minItems) return input;

  // Split into: initial + middle + recent
  const initial = input.slice(0, keepInitial);
  const recent = input.slice(-keepRecent);
  const middle = input.slice(keepInitial, input.length - keepRecent);

  // First pass: drop function_call_output from middle
  const filteredMiddle: unknown[] = [];
  let droppedCount = 0;
  let droppedChars = 0;

  for (const item of middle) {
    if (isDroppableInMiddle(item)) {
      droppedCount++;
      droppedChars += estimateItemChars(item);
    } else {
      filteredMiddle.push(item);
    }
  }

  // Check if first pass was enough
  const afterFirstPass = estimateTotalChars([...initial, ...filteredMiddle, ...recent]);
  if (afterFirstPass <= maxChars) {
    if (droppedCount > 0) {
      return [...initial, createTruncationMarker(droppedCount, droppedChars), ...filteredMiddle, ...recent];
    }
    return input; // Shouldn't happen, but be safe
  }

  // Second pass: aggressively truncate middle — keep only assistant messages and reasoning
  const essentialMiddle: unknown[] = [];
  for (const item of filteredMiddle) {
    if (!isRecord(item)) continue;
    const type = (item as InputItem).type;
    const role = (item as InputItem).role;
    // Keep: reasoning items, assistant messages (conversation turns)
    if (type === "reasoning" || role === "assistant" || type === "message" && role === "assistant") {
      essentialMiddle.push(item);
    } else {
      droppedCount++;
      droppedChars += estimateItemChars(item);
    }
  }

  // Check if second pass is enough
  const afterSecondPass = estimateTotalChars([...initial, ...essentialMiddle, ...recent]);
  if (afterSecondPass <= maxChars || essentialMiddle.length === 0) {
    return [
      ...initial,
      createTruncationMarker(droppedCount, droppedChars),
      ...essentialMiddle,
      ...recent,
    ];
  }

  // Third pass (nuclear): just keep initial + truncation marker + recent
  const finalDropped = middle.length;
  const finalDroppedChars = estimateTotalChars(middle);
  return [
    ...initial,
    createTruncationMarker(finalDropped, finalDroppedChars),
    ...recent,
  ];
}

/**
 * Check if context compression should be applied to this request.
 * Returns false for requests that shouldn't be compressed:
 *   - Requests with explicit previous_response_id (server has history)
 *   - Very short inputs
 */
export function shouldCompressContext(
  input: unknown[] | undefined,
  previousResponseId: string | undefined | null,
): boolean {
  // Don't compress if server-side history is being used
  if (previousResponseId) return false;
  if (!input || input.length < 10) return false;
  return true;
}
