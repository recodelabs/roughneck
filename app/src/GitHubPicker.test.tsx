import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPicker } from "./GitHubPicker";
import { clearGitHubCache } from "./github-cache";

const TOKEN_KEY = "margins.gh.token";
const originalFetch = global.fetch;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearGitHubCache();
  sessionStorage.setItem(TOKEN_KEY, "tok");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  sessionStorage.clear();
  global.fetch = originalFetch;
});

/** Set an input's value the way React's change tracking expects, then fire it. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GitHubPicker tree-fetch debounce", () => {
  it("fires a single tree request after the user stops typing, not one per keystroke", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ tree: [] }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<GitHubPicker />);
    });

    const input = container.querySelector<HTMLInputElement>("#gh-repo-input");
    if (!input) throw new Error("repo input not found");

    // Type "own/repo" one character at a time.
    for (const value of ["o", "ow", "own/", "own/r", "own/repo"]) {
      act(() => {
        typeInto(input, value);
      });
    }

    const treeCalls = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/git/trees/"));

    // No tree request yet — every keystroke reset the debounce timer.
    expect(treeCalls()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Exactly one tree request, and it's the recursive listing.
    expect(treeCalls()).toHaveLength(1);
    expect(String(treeCalls()[0][0])).toContain("recursive=1");
  });
});

describe("GitHubPicker file open", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("opens a file via SPA pushState + popstate, not a full reload", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tree: [{ path: "README.md", type: "blob" }],
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<GitHubPicker />);
    });

    const input = container.querySelector<HTMLInputElement>("#gh-repo-input");
    if (!input) throw new Error("repo input not found");
    act(() => {
      typeInto(input, "own/repo");
    });

    // Let the debounced tree fetch resolve so the file row renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const fileButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("README.md"));
    if (!fileButton) throw new Error("README.md row not found");

    // pushState (not a full-reload location.assign) is the SPA signal here.
    const pushSpy = vi.spyOn(window.history, "pushState");
    const onPopState = vi.fn();
    window.addEventListener("popstate", onPopState);

    act(() => {
      fileButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/own/repo/README.md");
    expect(onPopState).toHaveBeenCalledTimes(1);

    window.removeEventListener("popstate", onPopState);
    pushSpy.mockRestore();
  });
});

describe("GitHubPicker branch pulldown", () => {
  /** Route the two calls the picker makes: the repo tree and the branch list. */
  function mockRepo(branches: string[]) {
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/branches"))
        return new Response(
          JSON.stringify(branches.map((name) => ({ name }))),
          { status: 200 },
        );
      return new Response(JSON.stringify({ tree: [] }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  async function renderWithRepo(branches: string[]) {
    mockRepo(branches);
    vi.useFakeTimers();
    await act(async () => {
      root.render(<GitHubPicker />);
    });
    const repoInput =
      container.querySelector<HTMLInputElement>("#gh-repo-input");
    if (!repoInput) throw new Error("repo input not found");
    await act(async () => {
      typeInto(repoInput, "own/repo");
      await vi.advanceTimersByTimeAsync(400);
    });
    vi.useRealTimers();
  }

  it("shows every branch on opening the pulldown — no typing required", async () => {
    await renderWithRepo(["main", "feature/one", "release-2"]);

    const trigger =
      container.querySelector<HTMLButtonElement>("#gh-branch-trigger");
    if (!trigger) throw new Error("branch trigger not found");
    // The trigger reads as the current branch before it's ever opened, and the
    // list itself isn't mounted until it is.
    expect(trigger.textContent).toContain("main");
    expect(
      document.querySelectorAll('[data-slot="combobox-item"]'),
    ).toHaveLength(0);

    await act(async () => {
      trigger.click();
    });

    const options = Array.from(
      document.querySelectorAll('[data-slot="combobox-item"]'),
    ).map((el) => el.textContent);
    expect(options).toEqual(
      expect.arrayContaining(["main", "feature/one", "release-2"]),
    );
  });

  it("drops the previous repo's branches when the repo changes", async () => {
    // Branch list depends on which repo is asked for, so a stale list is
    // visible as branches from the repo we navigated away from.
    global.fetch = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/repos/own/first/branches"))
        return new Response(JSON.stringify([{ name: "first-only" }]), {
          status: 200,
        });
      if (href.includes("/repos/own/second/branches"))
        return new Response(JSON.stringify([{ name: "second-only" }]), {
          status: 200,
        });
      return new Response(JSON.stringify({ tree: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    await act(async () => {
      root.render(<GitHubPicker />);
    });
    const repoInput =
      container.querySelector<HTMLInputElement>("#gh-repo-input");
    if (!repoInput) throw new Error("repo input not found");
    await act(async () => {
      typeInto(repoInput, "own/first");
      await vi.advanceTimersByTimeAsync(400);
    });
    // Switch repos, then look *before* the debounced branch fetch has fired:
    // the first repo's branches must already be gone rather than lingering as
    // pickable options that don't exist in the new repo.
    await act(async () => {
      typeInto(repoInput, "own/second");
      await vi.advanceTimersByTimeAsync(100);
    });

    const options = () =>
      Array.from(document.querySelectorAll('[data-slot="combobox-item"]')).map(
        (el) => el.textContent,
      );

    const trigger =
      container.querySelector<HTMLButtonElement>("#gh-branch-trigger");
    if (!trigger) throw new Error("branch trigger not found");
    await act(async () => {
      trigger.click();
    });
    expect(options()).not.toContain("first-only");

    // The open pulldown then fills in with the new repo's branches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    vi.useRealTimers();
    expect(options()).toContain("second-only");
  });

  it("falls back to a text input when the branch list can't be loaded", async () => {
    await renderWithRepo([]);

    expect(container.querySelector("#gh-branch-trigger")).toBeNull();
    const input = container.querySelector<HTMLInputElement>("#gh-branch-input");
    expect(input?.value).toBe("main");
  });
});

describe("GitHubPicker new-file creation", () => {
  async function loadRepo(treePaths: string[]) {
    const treeMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tree: treePaths.map((p) => ({ path: p, type: "blob" })),
          }),
          { status: 200 },
        ),
    );
    global.fetch = treeMock as unknown as typeof fetch;

    vi.useFakeTimers();
    await act(async () => {
      root.render(<GitHubPicker />);
    });
    const input = container.querySelector<HTMLInputElement>("#gh-repo-input");
    if (!input) throw new Error("repo input not found");
    await act(async () => {
      typeInto(input, "own/repo");
      await vi.advanceTimersByTimeAsync(400);
    });
    vi.useRealTimers();
  }

  function findButtonByText(text: string): HTMLButtonElement | null {
    const all = Array.from(document.querySelectorAll("button"));
    return (all.find((b) => b.textContent?.includes(text)) ??
      null) as HTMLButtonElement | null;
  }

  it("shows a New file button once a repo is loaded and creates a file via PUT", async () => {
    await loadRepo(["docs/existing.md"]);

    const newFileBtn = findButtonByText("New file");
    expect(newFileBtn).not.toBeNull();

    await act(async () => {
      newFileBtn?.click();
    });

    const nameInput = document.body.querySelector<HTMLInputElement>(
      "#new-file-name-input",
    );
    if (!nameInput) throw new Error("new-file name input not found");
    expect(nameInput.value).toBe("untitled.md");

    const putMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: { sha: "created1" } }), {
          status: 201,
        }),
    );
    global.fetch = putMock as unknown as typeof fetch;

    await act(async () => {
      typeInto(nameInput, "my-notes.md");
    });
    const createBtn = findButtonByText("Create file");
    await act(async () => {
      createBtn?.click();
    });

    expect(putMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/own/repo/contents/my-notes.md",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse(
      (putMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.sha).toBeUndefined();
    expect(body.message).toBe("Create my-notes.md");
  });
});
