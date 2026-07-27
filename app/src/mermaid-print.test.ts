import { describe, expect, it } from "vitest";
import { buildMermaidPrintRules } from "./mermaid-print";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect fill="#fff"/></svg>';

describe("buildMermaidPrintRules", () => {
  it("returns nothing when the document has no diagrams", () => {
    expect(buildMermaidPrintRules([])).toBe("");
  });

  it("scopes every rule to print", () => {
    const css = buildMermaidPrintRules([{ index: 2, svg: SVG, aspect: 0.5 }]);
    expect(css.startsWith("@media print{")).toBe(true);
    expect(css.endsWith("}")).toBe(true);
  });

  it("targets the reserved <pre> under both editor roots", () => {
    const css = buildMermaidPrintRules([{ index: 3, svg: SVG, aspect: 0.5 }]);
    expect(css).toContain(".ProseMirror>pre:nth-child(3)");
    expect(css).toContain(".tiptap>pre:nth-child(3)");
  });

  it("paints the diagram as a background image on the in-flow block", () => {
    const css = buildMermaidPrintRules([{ index: 1, svg: SVG, aspect: 0.5 }]);
    expect(css).toContain("background-image:url(");
    expect(css).toContain("data:image/svg+xml,");
    expect(css).toContain("background-size:contain");
  });

  it("percent-encodes the SVG so its quotes cannot terminate the CSS url()", () => {
    const css = buildMermaidPrintRules([{ index: 1, svg: SVG, aspect: 0.5 }]);
    // A raw `"` in the payload would close url("…") early and break every
    // following rule in the sheet.
    const payload = css.match(/data:image\/svg\+xml,([^"]*)"/)?.[1];
    expect(payload).toBeDefined();
    expect(payload).not.toContain('"');
    expect(payload).not.toContain("(");
    expect(payload).toContain("%3Csvg");
  });

  it("keeps a diagram whole rather than letting a page boundary cut it", () => {
    const css = buildMermaidPrintRules([{ index: 1, svg: SVG, aspect: 0.5 }]);
    expect(css).toContain("break-inside:avoid");
  });

  it("sizes from the paper width via the diagram's aspect ratio", () => {
    // The on-screen height is a viewport-derived pixel value, meaningless on
    // paper — aspect-ratio lets the printed width drive the height instead.
    const css = buildMermaidPrintRules([{ index: 1, svg: SVG, aspect: 0.5 }]);
    expect(css).toContain("height:auto!important");
    expect(css).toContain("aspect-ratio:1/0.5");
  });

  it("caps height so a tall diagram still fits on one page", () => {
    const css = buildMermaidPrintRules([{ index: 1, svg: SVG, aspect: 4 }]);
    expect(css).toMatch(/max-height:[\d.]+in/);
  });

  it("emits one block per diagram", () => {
    const css = buildMermaidPrintRules([
      { index: 1, svg: SVG, aspect: 0.5 },
      { index: 4, svg: SVG, aspect: 0.5 },
    ]);
    expect(css).toContain("nth-child(1)");
    expect(css).toContain("nth-child(4)");
  });
});
