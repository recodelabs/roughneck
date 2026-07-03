export interface SharingFlags {
  public: boolean;
  comments: boolean;
  suggestions: boolean;
}

const FLAG_KEYS = ["public", "comments", "suggestions"] as const;

/** Extract the raw text inside the leading `---`…`---` frontmatter block, or null. */
function frontmatterBlock(markdown: string): string | null {
  const match = markdown.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
  );
  return match ? match[1] : null;
}

/**
 * Cheap "does this block obviously fail to parse" guard. The app parses the
 * WHOLE frontmatter and fails closed (every flag false) on ANY YAML error, so
 * reading an individual `public: true` line out of an otherwise-broken block
 * would expose a doc the app treats as private. Unbalanced flow collections
 * (`[ ] { }`) are the most common corruption; if they don't balance we treat the
 * block as unparseable and fail closed. Balanced valid lists (`tags: [a, b]`)
 * are unaffected. This is deliberately conservative: it can only ADD false
 * negatives (server private while app public), never a false public — preserving
 * the invariant `server.public ⇒ app.public`.
 */
function hasBalancedFlowDelimiters(block: string): boolean {
  let square = 0;
  let curly = 0;
  for (const ch of block) {
    if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    if (square < 0 || curly < 0) return false;
  }
  return square === 0 && curly === 0;
}

// A top-level flag line: the exact lowercase key (case-sensitive — `Public:` is
// NOT the `public` key), no leading indentation, then whitespace REQUIRED after
// the colon so `public:true` (a plain scalar in YAML, not a mapping) never
// matches, then the rest of the line.
const FLAG_LINE = new RegExp(`^(${FLAG_KEYS.join("|")}):[ \\t]+(.*)$`);

// The captured value must be a bare YAML boolean-`true` literal, optionally
// followed by an inline `# comment` (which YAML only recognises after
// whitespace). Anything else — quotes, extra tokens, other words — is not `true`.
const BOOL_TRUE_VALUE = /^(?:true|True|TRUE)(?:[ \t]+#.*)?[ \t]*$/;

/**
 * Read the public/comments/suggestions booleans from a doc's frontmatter.
 *
 * This is the server-side twin of the app's `getSharingFlags`
 * (app/src/sharing-frontmatter.ts) and MUST stay behaviourally identical to it:
 * a value is a flag only when the app's `parseYaml(...).<key> === true` would
 * also be true. Absent, non-`true`, indented, or unparseable ⇒ false (fail
 * closed). A `key: true` that only appears in the body (not the frontmatter
 * block) is ignored. See app/src/sharing-frontmatter.parity.test.ts.
 */
export function readSharingFlags(markdown: string): SharingFlags {
  const flags: SharingFlags = {
    public: false,
    comments: false,
    suggestions: false,
  };
  const block = frontmatterBlock(markdown);
  if (block === null) return flags;
  // Mirror the app's whole-document parse: any structural breakage ⇒ all false.
  if (!hasBalancedFlowDelimiters(block)) return flags;
  for (const rawLine of block.split(/\r?\n/)) {
    const m = FLAG_LINE.exec(rawLine);
    if (!m) continue;
    const key = m[1] as (typeof FLAG_KEYS)[number];
    if (BOOL_TRUE_VALUE.test(m[2])) flags[key] = true;
  }
  return flags;
}
