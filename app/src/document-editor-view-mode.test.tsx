import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useDocumentEditorViewMode } from "./document-editor-view-mode";

/**
 * Mounts the hook in a throwaway probe component and exposes its latest return
 * value, so each test can drive real popstate/history behaviour against jsdom's
 * window rather than a mock.
 */
function mountHook() {
  let latest: ReturnType<typeof useDocumentEditorViewMode> | null = null;

  function Probe() {
    latest = useDocumentEditorViewMode();
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));

  return {
    get mode() {
      if (!latest) throw new Error("hook did not render");
      return latest[0];
    },
    setMode(mode: Parameters<NonNullable<typeof latest>[1]>[0]) {
      if (!latest) throw new Error("hook did not render");
      const setter = latest[1];
      act(() => setter(mode));
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Navigate the way the app's own navigate() does: push, then fire popstate. */
function navigateTo(href: string) {
  act(() => {
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

const mounted: Array<{ cleanup: () => void }> = [];

function mount() {
  const hook = mountHook();
  mounted.push(hook);
  return hook;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  window.history.replaceState(null, "", "/");
});

describe("useDocumentEditorViewMode", () => {
  it("defaults to rich text when the URL carries no editor param", () => {
    window.history.replaceState(null, "", "/owner/repo/doc.md");
    expect(mount().mode).toBe("rich-text");
  });

  it("opens in code view when the URL requests it", () => {
    window.history.replaceState(null, "", "/owner/repo/doc.md?editor=code");
    expect(mount().mode).toBe("code");
  });

  it("ignores an unrecognised editor param", () => {
    window.history.replaceState(null, "", "/owner/repo/doc.md?editor=bogus");
    expect(mount().mode).toBe("rich-text");
  });

  it("writes the chosen mode into the URL without a history entry", () => {
    window.history.replaceState(null, "", "/owner/repo/doc.md");
    const historyLengthBefore = window.history.length;
    const hook = mount();

    hook.setMode("code");

    expect(hook.mode).toBe("code");
    expect(new URLSearchParams(window.location.search).get("editor")).toBe(
      "code",
    );
    expect(window.history.length).toBe(historyLengthBefore);
  });

  // REC-519: in-app navigation rebuilds the URL from scratch and drops
  // ?editor=, but the mode used to live in React state that only the toggle
  // ever wrote. Every document opened after one code-view toggle rendered as
  // markdown until a reload.
  it("falls back to rich text when navigating to a doc with no editor param", () => {
    window.history.replaceState(null, "", "/owner/repo/first.md");
    const hook = mount();

    hook.setMode("code");
    expect(hook.mode).toBe("code");

    navigateTo("/owner/repo/second.md");

    expect(hook.mode).toBe("rich-text");
  });

  it("restores code view when navigating back to an editor=code URL", () => {
    window.history.replaceState(null, "", "/owner/repo/first.md");
    const hook = mount();

    navigateTo("/owner/repo/second.md?editor=code");

    expect(hook.mode).toBe("code");
  });

  it("stops tracking location once unmounted", () => {
    window.history.replaceState(null, "", "/owner/repo/first.md");
    const hook = mountHook();
    hook.cleanup();

    expect(() => navigateTo("/owner/repo/second.md?editor=code")).not.toThrow();
  });
});
