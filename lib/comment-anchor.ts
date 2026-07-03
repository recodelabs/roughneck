// lib/comment-anchor.ts
// Framework-free helpers shared between insert-public-comment.ts (server) and
// the client (DocumentWorkspace).  Both sides must agree on which occurrence of
// a quote is the "plain-text Nth" — this module is the single source of truth.

/** Returns the byte offset in `markdown` where the document body begins
 *  (i.e. the character immediately after the closing `---` of the YAML
 *  frontmatter fence, or 0 when no frontmatter is present).
 */
export function bodyStart(markdown: string): number {
  const m = markdown.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? m[0].length : 0;
}

/** Returns an array of `{start, end}` byte ranges (relative to the start of
 *  `body`, the slice after frontmatter) that are occupied by CriticMarkup
 *  tokens.  Any plain-text match that overlaps one of these ranges must be
 *  skipped when counting occurrences.
 */
export function criticRegions(
  body: string,
): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  const re = /\{==[\s\S]*?==\}|\{>>[\s\S]*?<<\}(\{[^{}]*\})?/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = re.exec(body)) !== null) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }
  return regions;
}

/**
 * Given the full markdown source, the selected `quote` string, and the
 * character offset in `markdown` where the user's selection starts (i.e. the
 * index of the first character of the selected range within `markdown`),
 * returns the 1-based occurrence number that `insertPublicComment` should
 * receive so it wraps the intended plain-text match.
 *
 * Logic mirrors the server's `insert-public-comment.ts` exactly:
 *  1. Ignore everything before the frontmatter end.
 *  2. Ignore any match that overlaps a CriticMarkup region.
 *  3. Count plain-text matches whose start offset (relative to start of
 *     `markdown`) is **strictly less than** `selectionStart`.
 *  4. Return that count + 1  (so the result is ≥ 1 even when selectionStart
 *     is before or at the first plain-text occurrence).
 */
export function selectionOccurrence(
  markdown: string,
  quote: string,
  selectionStart: number,
): number {
  const start = bodyStart(markdown);
  const body = markdown.slice(start);
  const regions = criticRegions(body);

  // Walk all plain-text matches in the body, in document order.
  // Count those whose absolute start offset (bodyStart + bodyOffset) is
  // strictly less than selectionStart.  That count is "how many plain-text
  // occurrences come before the selection", so occurrence = count + 1.
  let count = 0;
  let searchFrom = 0;

  while (true) {
    const bodyIdx = body.indexOf(quote, searchFrom);
    if (bodyIdx === -1) break;

    const absIdx = start + bodyIdx; // absolute offset in markdown
    const matchEnd = bodyIdx + quote.length;

    // Skip matches that overlap existing markup regions
    const inMarkup = regions.some((r) => bodyIdx < r.end && matchEnd > r.start);

    if (!inMarkup) {
      if (absIdx < selectionStart) {
        count++;
      } else {
        // We've reached or passed the selection — stop counting
        break;
      }
    }

    searchFrom = bodyIdx + quote.length;
  }

  return count + 1;
}
