// lib/insert-public-comment.ts
import { bodyStart as computeBodyStart, criticRegions as computeCriticRegions } from "./comment-anchor";

export interface NewCommentInput {
  mode: "new";
  quote: string;
  occurrence: number;
  text: string;
  authorName: string;
  id: string;
  atIso: string;
}
export interface ReplyCommentInput {
  mode: "reply";
  parentId: string;
  text: string;
  authorName: string;
  id: string;
  atIso: string;
}
export type InsertInput = NewCommentInput | ReplyCommentInput;

export class AnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorError";
  }
}

const escapeAttr = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Shared guards so the new/reply branches can't drift.
// Guest comment text must never contain CriticMarkup comment delimiters,
// or a guest could break out of the {>>…<<} wrapper and forge markup.
function rejectCriticDelimiters(text: string): void {
  if (text.includes("<<}") || text.includes("{>>")) {
    throw new AnchorError("text contains CriticMarkup delimiters");
  }
}

// A CR/LF (or other control char) in authorName would corrupt the single-line
// meta block (`by="…"`), so strip control chars rather than reject — a display
// name should be sanitized, not cause the guest's comment to fail. Length is
// bounded by callers (MAX_NAME_LEN in lib/public-comment.ts).
function sanitizeAuthorName(authorName: string): string {
  // eslint-disable-next-line no-control-regex
  return authorName.replace(/[\x00-\x1F\x7F]/g, "");
}

function metaBlock(
  id: string,
  by: string,
  atIso: string,
  parentId?: string,
): string {
  let s = `{id="${escapeAttr(id)}" by="${escapeAttr(by)}" at="${escapeAttr(atIso)}"`;
  if (parentId) s += ` re="${escapeAttr(parentId)}"`;
  s += ` guest="true"}`;
  return s;
}

function commentBlock(
  text: string,
  id: string,
  by: string,
  atIso: string,
  parentId?: string,
): string {
  return `{>>${text}<<}${metaBlock(id, by, atIso, parentId)}`;
}

export function insertPublicComment(
  markdown: string,
  input: InsertInput,
): string {
  // Guard shared by both branches: guest text must not contain CriticMarkup
  // delimiters, and authorName must not contain control chars.
  rejectCriticDelimiters(input.text);
  const authorName = sanitizeAuthorName(input.authorName);

  if (input.mode === "new") {
    // Defense in depth: occurrence must be a positive integer (≤ 0 would leave `at` at -1,
    // causing absoluteAt to land inside the frontmatter and overwrite the --- delimiter)
    if (!Number.isInteger(input.occurrence) || input.occurrence < 1) {
      throw new AnchorError("occurrence must be an integer ≥ 1");
    }

    if (input.quote.includes("==}") || input.quote.includes("{==")) {
      throw new AnchorError("quote contains CriticMarkup delimiters");
    }

    const bodyStart = computeBodyStart(markdown);
    const body = markdown.slice(bodyStart);

    // Shared region scan — same logic as comment-anchor.ts so the two can't drift
    const regions = computeCriticRegions(body);

    // Finding 1: Find the occurrence-th PLAIN-TEXT match of quote within the body,
    // skipping any candidate index that falls inside a pre-scanned critic markup region
    let count = 0;
    let searchFrom = 0;
    let at = -1;
    while (count < input.occurrence) {
      const idx = body.indexOf(input.quote, searchFrom);
      if (idx === -1) throw new AnchorError("quote occurrence not found");
      const matchEnd = idx + input.quote.length;
      // Skip this candidate if it overlaps any existing critic markup region
      const insideMarkup = regions.some(
        (region) => idx < region.end && matchEnd > region.start,
      );
      if (!insideMarkup) {
        count++;
        at = idx;
      }
      searchFrom = idx + input.quote.length;
    }

    // Reject if the match overlaps any existing critic markup region
    const matchEnd = at + input.quote.length;
    for (const region of regions) {
      if (at < region.end && matchEnd > region.start) {
        throw new AnchorError("match overlaps existing critic markup");
      }
    }

    const absoluteAt = bodyStart + at;
    const absoluteEnd = bodyStart + matchEnd;
    const wrapped = `{==${input.quote}==}${commentBlock(input.text, input.id, authorName, input.atIso)}`;
    return (
      markdown.slice(0, absoluteAt) + wrapped + markdown.slice(absoluteEnd)
    );
  }

  // reply: insert a block immediately after the parent's metadata block
  const escaped = input.parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parentMeta = new RegExp(`\\{id="${escaped}"[^}]*\\}`);
  const m = markdown.match(parentMeta);
  if (!m || m.index === undefined)
    throw new AnchorError("parent comment not found");
  const insertAt = m.index + m[0].length;
  const block = commentBlock(
    input.text,
    input.id,
    authorName,
    input.atIso,
    input.parentId,
  );
  return markdown.slice(0, insertAt) + block + markdown.slice(insertAt);
}
