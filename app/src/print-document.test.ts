import { afterEach, describe, expect, it, vi } from "vitest";
import { installPrintThemeReset, printDocument } from "./print-document";

// Listeners live on the shared window, so every install must be undone or it
// keeps reacting to the next test's print events.
const uninstallers: Array<() => void> = [];

function install(): () => void {
  const uninstall = installPrintThemeReset();
  uninstallers.push(uninstall);
  return uninstall;
}

afterEach(() => {
  while (uninstallers.length) uninstallers.pop()?.();
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
});

describe("printDocument", () => {
  it("opens the browser print dialog", () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);

    printDocument();

    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe("installPrintThemeReset", () => {
  it("drops the dark class while printing so the PDF is readable", () => {
    document.documentElement.classList.add("dark");
    install();

    window.dispatchEvent(new Event("beforeprint"));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("restores dark mode after printing", () => {
    document.documentElement.classList.add("dark");
    install();

    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("afterprint"));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("leaves a light-mode document light after printing", () => {
    install();

    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("afterprint"));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("stops touching the theme once uninstalled", () => {
    document.documentElement.classList.add("dark");
    const uninstall = install();

    uninstall();
    window.dispatchEvent(new Event("beforeprint"));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
