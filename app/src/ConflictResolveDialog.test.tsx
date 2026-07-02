import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConflictResolveDialog,
  type ConflictResolveDialogProps,
} from "./ConflictResolveDialog";
import type { MergeRegion } from "./merge";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  ) ?? null) as HTMLButtonElement | null;
}

function render(props: Partial<ConflictResolveDialogProps> = {}) {
  const handlers = {
    onResolve: vi.fn(),
    onTakeTheirs: vi.fn(),
    onCancel: vi.fn(),
  };
  act(() => {
    root.render(
      <ConflictResolveDialog regions={[]} {...handlers} {...props} />,
    );
  });
  return handlers;
}

describe("ConflictResolveDialog", () => {
  it("defaults each conflict to 'ours' and resolves to our lines", () => {
    const regions: MergeRegion[] = [
      { type: "conflict", ours: ["mine"], base: ["base"], theirs: ["theirs"] },
    ];
    const handlers = render({ regions });
    act(() => buttonByText("Apply & save")?.click());
    expect(handlers.onResolve).toHaveBeenCalledWith("mine");
  });

  it("re-initializes choices when re-rendered with a fresh regions set", () => {
    // Round one: a single conflict. Pick "theirs" for it.
    const regionsA: MergeRegion[] = [
      { type: "stable", lines: ["intro"] },
      { type: "conflict", ours: ["A-ours"], base: ["A"], theirs: ["A-theirs"] },
    ];
    const handlers = render({ regions: regionsA });
    act(() => buttonByText("Use theirs")?.click());

    // A second concurrent save lands mid-resolution: the SAME dialog instance
    // is re-rendered with a different, longer regions set (two conflicts).
    const regionsB: MergeRegion[] = [
      {
        type: "conflict",
        ours: ["B1-ours"],
        base: ["B1"],
        theirs: ["B1-theirs"],
      },
      { type: "stable", lines: ["middle"] },
      {
        type: "conflict",
        ours: ["B2-ours"],
        base: ["B2"],
        theirs: ["B2-theirs"],
      },
    ];
    render({ regions: regionsB, ...handlers });

    // Applying must reflect regionsB defaulted to "ours" for BOTH conflicts —
    // not the stale round-one "theirs" pick mapped onto the wrong region, and
    // not a truncated choices array that drops the second conflict.
    act(() => buttonByText("Apply & save")?.click());
    expect(handlers.onResolve).toHaveBeenCalledWith("B1-ours\nmiddle\nB2-ours");
  });
});
