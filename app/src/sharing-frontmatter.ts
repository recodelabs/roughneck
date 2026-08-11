import { parse as parseYaml } from "yaml";
import { prependYamlFrontmatter, splitYamlFrontmatter } from "./markdown";

export type SharingFlagKey = "public" | "comments" | "suggestions";
export interface SharingFlags {
  public: boolean;
  comments: boolean;
  suggestions: boolean;
}

function parseFrontmatterObject(
  frontmatter: string | null,
): Record<string, unknown> {
  if (!frontmatter) return {};
  const inner = frontmatter
    .replace(/^---[ \t]*\r?\n/, "")
    .replace(/\r?\n---[ \t]*\r?\n?\s*$/, "\n");
  try {
    const parsed = parseYaml(inner);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getSharingFlags(markdown: string): SharingFlags {
  const { frontmatter } = splitYamlFrontmatter(markdown);
  const obj = parseFrontmatterObject(frontmatter);
  return {
    public: obj.public === true,
    comments: obj.comments === true,
    suggestions: obj.suggestions === true,
  };
}

const FRONTMATTER_DELIMITER = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Set (or clear) one sharing flag, preserving the body and ALL other frontmatter
 * verbatim — including unrelated keys, comments, key order and formatting.
 *
 * This operates at the raw line level rather than round-tripping the parsed YAML
 * object, so it never rewrites (or, on a parse error, destroys) user frontmatter.
 * `value === true` writes/updates only the target key's line; `value === false`
 * removes only that line (absent ⇒ false is the documented default).
 */
export function setSharingFlag(
  markdown: string,
  key: SharingFlagKey,
  value: boolean,
): string {
  const { frontmatter, body } = splitYamlFrontmatter(markdown);

  // No frontmatter block: clearing is a no-op; setting creates a minimal block.
  if (!frontmatter) {
    if (!value) return markdown;
    return prependYamlFrontmatter(body, `---\n${key}: true\n---\n\n`);
  }

  const eol = /\r\n/.test(frontmatter) ? "\r\n" : "\n";
  const lines = frontmatter.split(/\r?\n/);

  // `splitYamlFrontmatter` guarantees the block opens with a delimiter on line 0
  // and closes with a later delimiter line; everything between is content.
  const closeIndex = lines.findIndex(
    (line, i) => i > 0 && FRONTMATTER_DELIMITER.test(line),
  );
  if (closeIndex === -1) {
    // Malformed block with no closing delimiter — leave it untouched.
    return markdown;
  }

  // Match a top-level `key:` line only: no leading indentation (so nested keys
  // are skipped) and a colon immediately after the key name (so prefix-sharing
  // keys like `publicity:` and value substrings like `title: public` are not
  // matched). `key` is a fixed literal with no regex-special characters.
  const keyLineRe = new RegExp(`^${key}[ \\t]*:`);
  const keyIndex = lines.findIndex(
    (line, i) => i > 0 && i < closeIndex && keyLineRe.test(line),
  );

  if (value) {
    if (keyIndex !== -1) lines[keyIndex] = `${key}: true`;
    else lines.splice(closeIndex, 0, `${key}: true`);
    return prependYamlFrontmatter(body, lines.join(eol));
  }

  // Clearing: if the key is absent there is nothing to remove.
  if (keyIndex === -1) return markdown;
  lines.splice(keyIndex, 1);

  // If removing the key left no non-blank content, drop the now-empty block.
  const newCloseIndex = closeIndex - 1;
  const hasRemainingContent = lines.some(
    (line, i) => i > 0 && i < newCloseIndex && line.trim() !== "",
  );
  if (!hasRemainingContent) return body;

  return prependYamlFrontmatter(body, lines.join(eol));
}
