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
- the file-tree sidebar
- the `InstructionSender` agent box wrapper
- the mobile comment fallback list (`PageCard`)
- the review/comment rail (`PageCard`, `DocumentWorkspace` spacer)

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

## Printing the page

The printed region is `[data-testid="document-content-card"]` in `PageCard`.
Print rules:

- strip the card's border, shadow, rounding, and outer padding
- unlock the scroll containers — `html`, `body`, `main`, and
  `[data-document-scroller]` get `height: auto; overflow: visible`. Without
  this the fixed-height flex shell clips the PDF to a single page.
- `@page { margin: 0.75in }`
- break hints: `break-after: avoid` on headings; `break-inside: avoid` on `pre`,
  `blockquote`, `table`, `img`

CriticMarkup keeps its on-screen styling. No comment endnotes, no custom
header/footer (the browser's own header/footer stays under the user's control in
the print dialog).

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

Print CSS is not observable in jsdom, so page layout is verified manually in a
browser before the work is called done.

## Known limitation

Mermaid diagrams are rendered as absolutely-positioned overlays over a reserved
gap (see `MermaidOverlays`). An overlay that lands on a page boundary may clip
rather than reflow. Text, tables, images, and code paginate normally. Fixing this
would mean rearchitecting the mermaid renderer and is out of scope.
