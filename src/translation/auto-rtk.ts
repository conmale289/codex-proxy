export interface AutoRtkOptions {
  enabled: boolean;
  maxCharsPerMessage: number;
}

/**
 * Removes ANSI escape codes from the input string.
 */
function stripAnsi(text: string): string {
  // Matches standard ANSI color and formatting codes
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1B\[\d+;?\d*m/g;
  return text.replace(ansiRegex, "");
}

/**
 * Deduplicates adjacent identical lines, adding a multiplier suffix.
 */
function deduplicateLines(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  
  const result: string[] = [];
  let currentLine = lines[0];
  let count = 1;

  for (let i = 1; i <= lines.length; i++) {
    const line = lines[i];
    if (line === currentLine) {
      count++;
    } else {
      if (count > 1) {
        result.push(`... [Repeated ${count} times] ...`);
      }
      if (currentLine !== undefined) {
        result.push(currentLine);
      }
      currentLine = line;
      count = 1;
    }
  }

  return result;
}

/**
 * Compresses tool/function outputs to save tokens and prevent runaway loops.
 */
export function compressWithAutoRtk(text: string, options: AutoRtkOptions): string {
  if (!options.enabled || !text) return text;

  // 1. Strip ANSI codes
  let processed = stripAnsi(text);

  // 2. Quick length check before heavy line processing
  if (processed.length <= options.maxCharsPerMessage) {
    // If it's short enough, we just return the ansi-stripped version
    // (We could deduplicate, but it's usually not necessary for short texts)
    return processed;
  }

  // 3. Deduplicate
  const lines = processed.split("\n");
  const dedupedLines = deduplicateLines(lines);

  // Re-check length
  processed = dedupedLines.join("\n");
  if (processed.length <= options.maxCharsPerMessage) {
    return processed;
  }

  // 4. Smart Truncation (Keep head and tail)
  // Assume an average line length of 80 characters for estimation
  const targetChars = options.maxCharsPerMessage;
  const headChars = Math.floor(targetChars * 0.4); // 40% head
  const tailChars = Math.floor(targetChars * 0.4); // 40% tail
  
  let headLines = [];
  let currentHeadChars = 0;
  for (let i = 0; i < dedupedLines.length; i++) {
    const len = dedupedLines[i].length + 1; // +1 for newline
    if (currentHeadChars + len > headChars) break;
    headLines.push(dedupedLines[i]);
    currentHeadChars += len;
  }

  let tailLines = [];
  let currentTailChars = 0;
  for (let i = dedupedLines.length - 1; i >= 0; i--) {
    const len = dedupedLines[i].length + 1;
    if (currentTailChars + len > tailChars) break;
    tailLines.unshift(dedupedLines[i]);
    currentTailChars += len;
  }

  const truncatedCount = dedupedLines.length - headLines.length - tailLines.length;
  if (truncatedCount > 0) {
    return [
      ...headLines,
      `\n... [${truncatedCount} lines truncated by Auto-RTK] ...\n`,
      ...tailLines
    ].join("\n");
  }

  return processed;
}
