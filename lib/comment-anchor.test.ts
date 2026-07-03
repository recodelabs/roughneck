// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectionOccurrence } from "./comment-anchor";
import { insertPublicComment } from "./insert-public-comment";

const fm = "---\npublic: true\ncomments: true\n---\n";

describe("selectionOccurrence", () => {
  it("returns 2 when selectionStart is at the 2nd plain-text occurrence", () => {
    // body: "cat dog cat dog cat"
    // offsets: 0..3 = first cat, 8..11 = second cat, 16..19 = third cat
    const body = "cat dog cat dog cat";
    const md = fm + body;
    const fmLen = fm.length;
    // selectionStart at the 2nd "cat" in the body = fmLen + 8
    expect(selectionOccurrence(md, "cat", fmLen + 8)).toBe(2);
    // selectionStart at the 3rd "cat" = fmLen + 16
    expect(selectionOccurrence(md, "cat", fmLen + 16)).toBe(3);
    // selectionStart at the 1st "cat" = fmLen + 0
    expect(selectionOccurrence(md, "cat", fmLen + 0)).toBe(1);
  });

  it("skips occurrences inside existing critic markup regions", () => {
    // body has {==cat==} (markup) then plain "cat"
    const body = '{==cat==}{>>note<<}{id="x" by="y" at="t"} The cat sat.';
    const md = fm + body;
    const fmLen = fm.length;
    // plain "cat" starts at fmLen + body.indexOf("The cat") + 4
    const plainCatBodyOffset = body.indexOf("The cat") + 4; // +4 for "The "
    expect(selectionOccurrence(md, "cat", fmLen + plainCatBodyOffset)).toBe(1);
  });

  it("selectionStart < first plain occurrence still returns 1", () => {
    const body = "hello cat world";
    const md = fm + body;
    // selectionStart before any occurrence → returns 1 (the first plain occurrence)
    expect(selectionOccurrence(md, "cat", fm.length + 0)).toBe(1);
  });

  it("round-trip: insertPublicComment wraps the intended occurrence", () => {
    // Two plain occurrences of "cat" in body.
    // We want to select the 2nd one.
    const body = "The cat sat. The cat ran.";
    const md = fm + body;
    const fmLen = fm.length;
    // 2nd "cat" starts at body offset 17
    const secondCatBodyOffset = body.indexOf("cat", body.indexOf("cat") + 1);
    const occ = selectionOccurrence(md, "cat", fmLen + secondCatBodyOffset);
    expect(occ).toBe(2);
    const out = insertPublicComment(md, {
      mode: "new",
      quote: "cat",
      occurrence: occ,
      text: "which one?",
      authorName: "Jane",
      id: "g1",
      atIso: "2026-06-18T00:00:00.000Z",
    });
    // Should wrap the SECOND cat
    expect(out).toContain('The cat sat. The {==cat==}{>>which one?<<}{id="g1"');
  });

  it("round-trip with markup: skips the markup cat and wraps the plain one", () => {
    const body = '{==cat==}{>>note<<}{id="x" by="y" at="t"} The cat sat.';
    const md = fm + body;
    const fmLen = fm.length;
    const plainCatBodyOffset = body.indexOf("The cat") + 4;
    const occ = selectionOccurrence(md, "cat", fmLen + plainCatBodyOffset);
    expect(occ).toBe(1); // markup cat skipped
    const out = insertPublicComment(md, {
      mode: "new",
      quote: "cat",
      occurrence: occ,
      text: "plain",
      authorName: "A",
      id: "g2",
      atIso: "t",
    });
    // The original markup anchor remains untouched
    expect(out).toContain('{==cat==}{>>note<<}{id="x"');
    // The plain cat in "The cat sat." is wrapped
    expect(out).toContain("The {==cat==}{>>plain<<}");
  });
});
