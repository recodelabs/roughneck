import { describe, expect, it } from "vitest";
import { readSharingFlags } from "./sharing-flags";

describe("readSharingFlags", () => {
  it("defaults every flag to false when there is no frontmatter", () => {
    expect(readSharingFlags("# Just a body\n")).toEqual({
      public: false,
      comments: false,
      suggestions: false,
    });
  });

  it("reads true flags from the leading frontmatter block", () => {
    const md = "---\npublic: true\ncomments: true\n---\n\n# Body\n";
    expect(readSharingFlags(md)).toEqual({
      public: true,
      comments: true,
      suggestions: false,
    });
  });

  it("treats any non-true value as false", () => {
    const md = "---\npublic: false\ncomments: yes\nsuggestions:\n---\n";
    expect(readSharingFlags(md)).toEqual({
      public: false,
      comments: false,
      suggestions: false,
    });
  });

  it("ignores a 'public: true' that appears only in the body, not frontmatter", () => {
    const md = "# Heading\n\npublic: true\n";
    expect(readSharingFlags(md).public).toBe(false);
  });

  it("accepts YAML boolean-true spellings and tolerates trailing spaces/comments", () => {
    // `true`/`True`/`TRUE` are the only core-schema booleans; a trailing `#`
    // comment (after whitespace) is fine.
    expect(
      readSharingFlags("---\npublic:   TRUE  # opt in\n---\n").public,
    ).toBe(true);
    expect(readSharingFlags("---\npublic: True\n---\n").public).toBe(true);
  });

  it("does NOT treat a capitalized `Public:` key as the public flag (fail closed)", () => {
    // The reported divergence: a case-insensitive server would serve this
    // publicly while the app (exact-key YAML) shows it private.
    expect(readSharingFlags("---\nPublic: true\n---\n").public).toBe(false);
  });

  it("treats quoted, mistyped, or run-together values as not-true", () => {
    // `"true"` is a YAML string, `yes` is a string in YAML 1.2, and
    // `public:true` (no space) is a plain scalar, not a mapping.
    expect(readSharingFlags('---\npublic: "true"\n---\n').public).toBe(false);
    expect(readSharingFlags("---\npublic: yes\n---\n").public).toBe(false);
    expect(readSharingFlags("---\npublic:true\n---\n").public).toBe(false);
  });

  it("ignores an indented (non-top-level) key", () => {
    expect(readSharingFlags("---\nmeta:\n  public: true\n---\n").public).toBe(
      false,
    );
  });

  it("fails closed when the frontmatter block is unparseable (unbalanced flow)", () => {
    // The app's whole-document parse throws here, yielding all-false; the server
    // must not read `public: true` out of the broken block.
    const md = "---\npublic: true\ntags: [a, b\n---\n";
    expect(readSharingFlags(md).public).toBe(false);
  });

  it("still reads flags alongside a balanced list value", () => {
    const md = "---\ntags: [a, b]\npublic: true\ncomments: true\n---\n";
    expect(readSharingFlags(md)).toEqual({
      public: true,
      comments: true,
      suggestions: false,
    });
  });
});
