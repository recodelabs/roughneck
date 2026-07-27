/**
 * Print rules for mermaid diagrams.
 *
 * On screen a diagram is an absolutely-positioned overlay floating over a
 * reserved gap in the editor (see `MermaidOverlays` — ProseMirror reverts any
 * change to its own DOM, so the SVG cannot live in the flow). Absolutely
 * positioned boxes do not paginate: one that meets a page boundary is cut in
 * half rather than pushed to the next page.
 *
 * So for print we drop the overlay and paint the same SVG as a background image
 * on the reserved `<pre>` itself. That block *is* in the flow, which makes
 * `break-inside: avoid` meaningful — the diagram moves to the next page whole.
 * Painting via an injected stylesheet keeps the module's rule of never touching
 * the editor's DOM.
 */

/** A rendered diagram and the `<pre>` it belongs to. */
export interface MermaidPrintEntry {
  /** 1-based position of the `<pre>` among its siblings, for `nth-child`. */
  index: number;
  /** The rendered SVG markup. */
  svg: string;
  /** height / width of the diagram. */
  aspect: number;
}

/**
 * Tallest a diagram may print. The printable box on Letter with 0.75in margins
 * is 9.5in; staying under that keeps a capped diagram on a single page instead
 * of overflowing one it can never fit.
 */
const MAX_HEIGHT_IN = 7.5;

export function buildMermaidPrintRules(entries: MermaidPrintEntry[]): string {
  if (entries.length === 0) return "";

  const blocks = entries.map(({ index, svg, aspect }) => {
    // encodeURIComponent leaves no quote, paren or `#` intact, so the SVG
    // cannot terminate the url() or be read as a fragment.
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    const declarations = [
      `background-image:${url}`,
      "background-repeat:no-repeat",
      "background-position:center",
      "background-size:contain",
      // The on-screen height is derived from the viewport; on paper the page
      // width is the only sensible input, so let the aspect ratio set height.
      "height:auto!important",
      "min-height:0!important",
      `aspect-ratio:1/${aspect}`,
      `max-height:${MAX_HEIGHT_IN}in`,
      "break-inside:avoid",
    ].join(";");

    return [".ProseMirror", ".tiptap"]
      .map((root) => `${root}>pre:nth-child(${index}){${declarations};}`)
      .join("");
  });

  return `@media print{${blocks.join("")}}`;
}
