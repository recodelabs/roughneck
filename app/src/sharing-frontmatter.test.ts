import { describe, expect, it } from "vitest";
import { getSharingFlags, setSharingFlag } from "./sharing-frontmatter";

describe("getSharingFlags", () => {
  it("defaults to all-false with no frontmatter", () => {
    expect(getSharingFlags("# Body\n")).toEqual({
      public: false,
      comments: false,
      suggestions: false,
    });
  });
  it("reads true flags", () => {
    expect(getSharingFlags("---\npublic: true\n---\n# Body\n").public).toBe(
      true,
    );
  });
});

describe("setSharingFlag", () => {
  it("adds a frontmatter block when none exists", () => {
    const out = setSharingFlag("# Body\n", "public", true);
    expect(getSharingFlags(out).public).toBe(true);
    expect(out).toContain("# Body");
  });
  it("sets a key without disturbing other keys or the body", () => {
    const md = "---\nversion: 1\ntags: [a]\n---\n\n# Title\n\nText.\n";
    const out = setSharingFlag(md, "public", true);
    expect(getSharingFlags(out).public).toBe(true);
    expect(out).toContain("version: 1");
    expect(out).toContain("# Title");
    expect(out).toContain("Text.");
  });
  it("flips a flag false (removes it) and round-trips", () => {
    const md = "---\npublic: true\n---\n# B\n";
    const off = setSharingFlag(md, "public", false);
    expect(getSharingFlags(off).public).toBe(false);
    const on = setSharingFlag(off, "public", true);
    expect(getSharingFlags(on).public).toBe(true);
  });

  it("setting a flag preserves other keys, comments, and key order", () => {
    const md =
      "---\n# top comment\ntitle: Hello\ntags: [a, b]\naliases:\n  - x\n---\n\n# Body\n";
    const out = setSharingFlag(md, "public", true);
    expect(getSharingFlags(out).public).toBe(true);
    expect(out).toContain("# top comment");
    expect(out).toContain("title: Hello");
    expect(out).toContain("tags: [a, b]");
    expect(out).toContain("aliases:");
    expect(out).toContain("  - x");
    // Existing keys keep their order; the new key is appended before the close.
    expect(out.indexOf("title: Hello")).toBeLessThan(
      out.indexOf("tags: [a, b]"),
    );
    expect(out.indexOf("tags: [a, b]")).toBeLessThan(
      out.indexOf("public: true"),
    );
  });

  it("does not wipe other keys on malformed-but-recoverable frontmatter", () => {
    // `tags: [a, b` is invalid YAML (unclosed flow sequence) so a whole-object
    // parse throws; the line-level write must still preserve every other line.
    const md = "---\ntitle: Hello\ntags: [a, b\n---\n\n# Body\n";
    const out = setSharingFlag(md, "public", true);
    expect(out).toContain("title: Hello");
    expect(out).toContain("tags: [a, b");
    expect(out).toContain("public: true");
    expect(out).toContain("# Body");
  });

  it("clearing a flag removes only that key and keeps the rest", () => {
    const md = "---\ntitle: Hello\npublic: true\ntags: [a]\n---\n\n# Body\n";
    const out = setSharingFlag(md, "public", false);
    expect(getSharingFlags(out).public).toBe(false);
    expect(out).toContain("title: Hello");
    expect(out).toContain("tags: [a]");
    expect(out).not.toContain("public:");
    expect(out).toContain("# Body");
  });

  it("clearing the only key does not corrupt the doc", () => {
    const md = "---\npublic: true\n---\n\n# Body\n\nText.\n";
    const out = setSharingFlag(md, "public", false);
    expect(out).not.toContain("---");
    expect(out).toContain("# Body");
    expect(out).toContain("Text.");
    expect(getSharingFlags(out).public).toBe(false);
  });

  it("round-trips a doc with a YAML comment and keeps the comment", () => {
    const md = "---\n# keep me\npublic: true\n---\n\n# Body\n";
    const off = setSharingFlag(md, "comments", true);
    expect(off).toContain("# keep me");
    const on = setSharingFlag(off, "comments", false);
    expect(on).toContain("# keep me");
    expect(on).toContain("public: true");
    expect(getSharingFlags(on).comments).toBe(false);
  });

  it("does not match prefix-sharing keys or value substrings", () => {
    const md = "---\npublicity: high\ntitle: public\n---\n\n# Body\n";
    const out = setSharingFlag(md, "public", true);
    expect(out).toContain("publicity: high");
    expect(out).toContain("title: public");
    expect(out).toContain("public: true");
    expect(getSharingFlags(out).public).toBe(true);
  });

  it("preserves CRLF line endings", () => {
    const md = "---\r\ntitle: Hello\r\n---\r\n\r\n# Body\r\n";
    const out = setSharingFlag(md, "public", true);
    expect(out).toContain("title: Hello\r\n");
    expect(out).toContain("public: true\r\n");
    expect(getSharingFlags(out).public).toBe(true);
  });
});
