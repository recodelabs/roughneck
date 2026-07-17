import { useCallback, useEffect, useState } from "react";
import {
  buildLocationForDocumentEditorViewMode,
  type DocumentEditorViewMode,
  getDocumentEditorViewModeFromLocation,
} from "./app-navigation";

const DEFAULT_MODE: DocumentEditorViewMode = "rich-text";

/**
 * Owns the rich-text/code choice for the open document, with the URL's
 * `?editor=` param as the single source of truth.
 *
 * The re-sync on `popstate` is load-bearing (REC-519). In-app navigation
 * rebuilds the URL from scratch — `gitHubHref()` emits only `?branch=`, and
 * `buildLocationForLinkedMarkdownDocument()` clears the query outright — so
 * `?editor=` is dropped on every document switch. Without listening here, the
 * mode would keep whatever value the toggle last wrote and every subsequent
 * document would open in code view until a full reload put the URL back in
 * charge.
 *
 * The toggle uses `replaceState`, which fires no `popstate`, so writing the
 * param cannot feed back into this listener.
 */
export function useDocumentEditorViewMode() {
  const [mode, setMode] = useState(() =>
    getDocumentEditorViewModeFromLocation(DEFAULT_MODE),
  );

  useEffect(() => {
    const onPopState = () =>
      setMode(getDocumentEditorViewModeFromLocation(DEFAULT_MODE));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const changeMode = useCallback((nextMode: DocumentEditorViewMode) => {
    // Keep the mode out of the history stack: switching views is a display
    // preference, not a place the Back button should return to.
    window.history.replaceState(
      null,
      "",
      buildLocationForDocumentEditorViewMode(nextMode),
    );
    setMode(nextMode);
  }, []);

  return [mode, changeMode] as const;
}
