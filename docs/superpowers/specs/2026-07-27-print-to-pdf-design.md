# Print / Export to PDF — design

Date: 2026-07-27

## Goal

Let a reader turn the open markdown document into a PDF containing only the
rendered page — no breadcrumbs, toolbars, sidebar, rails, or floating status
chrome.

## Mechanism

Native browser print. A toolbar button and a command-palette entry call
`window.print()`; the user picks "Save as PDF" in the system dialog. The feature
is therefore a `@media print` block in `app/src/style.css` plus a small number of
markers in the JSX.

Rejected alternatives: bundling a JS PDF generator (~500KB, weaker typography,
poor page-break control) and server-side rendering on Cloudflare (needs a
browser-rendering binding and new secrets). Native print also means `⌘P` produces
the same clean output with no extra wiring.

## Hiding chrome

Chrome containers get a `data-print-hide` attribute in the JSX, and print CSS
carries one rule:

```css
@media print {
  [data-print-hide] { display: none !important; }
}
```

Marked containers:

- the GitHub breadcrumb bar (`DocumentWorkspace`)
- the document toolbar row (mode select, share, history, comment toggles)
- the file-tree sidebar, expanded and collapsed (`FileTreeSidebar`)
- the `InstructionSender` agent box wrapper
- the comment-rail spacer (`DocumentWorkspace`)

The rails inside `PageCard` are hidden by their existing layout classes
(`.document-comment-rail`, `.document-comment-fallback`) rather than a new
attribute, which would have meant threading a prop through `CommentEditorList`
and `DocumentReviewRail` for no gain.

An explicit attribute beats a list of CSS selectors: it is greppable from the
component, survives class churn, and can be asserted in tests.

Floating overlays — the fixed commit button, status stack, conflict notice,
toasts, guest-comment button, update notice — are swept by one companion rule,
since `.fixed` is Tailwind's literal class name for `position: fixed`:

```css
@media print {
  .fixed { display: none !important; }
}
```

Base UI portals its overlays to `<body>`, outside the app tree and without a
`.fixed` class, so `[data-base-ui-portal]` is hidden too. This is not
hypothetical: clicking the toolbar button leaves its own tooltip open, and
without the rule "Export as PDF" prints on top of the document's first heading.

## Printing the page

The printed region is `[data-testid="document-content-card"]` in `PageCard`.
Print rules:

- strip the card's border, shadow, rounding, and outer padding
- unlock the scroll containers — `html`, `body`, `main`, and
  `[data-document-scroller]` get `height: auto; overflow: visible`. Without
  this the fixed-height flex shell clips the PDF to a single page.
- drop the on-screen 56rem cap on `.document-page-main`, so the page margin is
  the measure
- `print-color-adjust: exact` on the card only. Callout icons and tints, code
  fills and comment highlights are painted as backgrounds, which browsers drop
  unless the reader has "Background graphics" ticked — and those colours carry
  meaning.
- `@page { margin: 0 }`, with the 0.75in paper margin applied as padding on the
  card plus `box-decoration-break: clone` — see "Browser header and footer"
- break hints: `break-after: avoid` on headings; `break-inside: avoid` on `pre`,
  `blockquote`, `table`, `img`

One cascade trap is worth naming: the toolbar row is itself a
`.document-page-shell`, so the rule that unwraps the shell's grid is written
`.document-page-shell:not([data-print-hide])`. Both rules are `!important` at
equal specificity, so without the `:not()` the later one wins and the toolbar
prints.

CriticMarkup keeps its on-screen styling. No comment endnotes.

## Browser header and footer

Chrome prints its own header and footer — page title, date, URL, page number —
and no CSS property switches them off; it is a checkbox in the print dialog.
The one lever CSS does have is where they are drawn: the page margin box. With
`@page { margin: 0 }` there is no margin box, so they have nowhere to render.

Zero page margins would normally mean text against the paper edge, so the
0.75in margin moves onto the document card as padding. Padding alone would
apply only to the first and last page fragment, leaving interior pages flush to
the edge — `box-decoration-break: clone` repeats it on every fragment. This was
verified in Chrome with a page break falling mid-paragraph, where nothing but
cloned padding can hold the text off the top edge.

Caveat: the margin behaviour is verified; the header suppression is not
directly testable through Playwright, which draws its own header/footer via
CDP when asked rather than following Chrome's dialog. The mechanism is
well-established, but the final confirmation is a real ⌘P.

## Mermaid diagrams

A diagram is an absolutely-positioned overlay floating over a reserved gap,
because ProseMirror reverts any change to its own DOM. Absolutely positioned
boxes do not paginate: one meeting a page boundary is cut in half.

For print the overlay is hidden and the same SVG is painted as a background
image on the reserved `<pre>`, which *is* in the flow — so `break-inside: avoid`
applies and the diagram moves to the next page whole. `MermaidOverlays` injects
these rules into a third stylesheet (`mermaid-print.ts` builds the CSS), keeping
the module's rule of never touching the editor's DOM. The SVG is
percent-encoded so its quotes cannot terminate the `url()`, height comes from
the diagram's aspect ratio so the paper width drives it, and a 7.5in cap keeps
a tall diagram on one page.

## Dark mode

A `beforeprint` listener removes the `dark` class from `<html>`; `afterprint`
restores it. This is more robust than overriding every `dark:` variant inside the
print block, and it covers `⌘P` as well as the button.

## Triggers

- A `Printer` icon button in the document toolbar, next to Share/History, shown
  for markdown documents.
- A command-palette command, "Export as PDF".

Both call the same handler.

## Testing

Vitest + jsdom:

- the toolbar button renders for markdown documents and invokes `window.print`
- the palette command is registered and runs the same handler
- `beforeprint` removes the `dark` class and `afterprint` restores it, including
  when the document started in light mode
- each chrome container carries `data-print-hide`

Print CSS is not observable in jsdom, so page layout was verified in a real
browser (Playwright against the `/preview` route) by emulating print media and
generating PDFs: chrome hidden, card stripped, dark-mode document printing
light, headings and code blocks paginating intact across a 12-section document,
and both triggers firing `window.print`.

Follow-up verification covered the mermaid path (a diagram placed to straddle a
page break moves whole to the next page) and interior-page margins under
`@page { margin: 0 }`.
