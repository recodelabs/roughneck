/**
 * Export-to-PDF is the browser's own print pipeline: the print stylesheet in
 * `style.css` hides every bit of app chrome (`[data-print-hide]`, `.fixed`) and
 * lays out the document content card alone, so "Save as PDF" in the native
 * dialog yields just the page.
 */

/** Open the browser print dialog for the current document. */
export function printDocument(): void {
  window.print();
}

/**
 * Print in light mode regardless of the on-screen theme.
 *
 * Browsers drop background colours when printing, so a dark document would come
 * out as pale text on white paper. Dropping the `dark` class off `<html>` for
 * the duration of the print is far more robust than shadowing every `dark:`
 * variant inside the print block — and it covers ⌘P as well as the button,
 * since the native shortcut fires `beforeprint` too.
 *
 * Returns an uninstall function.
 */
export function installPrintThemeReset(): () => void {
  let wasDark = false;

  const onBeforePrint = () => {
    wasDark = document.documentElement.classList.contains("dark");
    document.documentElement.classList.remove("dark");
  };
  const onAfterPrint = () => {
    if (wasDark) document.documentElement.classList.add("dark");
  };

  window.addEventListener("beforeprint", onBeforePrint);
  window.addEventListener("afterprint", onAfterPrint);
  return () => {
    window.removeEventListener("beforeprint", onBeforePrint);
    window.removeEventListener("afterprint", onAfterPrint);
  };
}
