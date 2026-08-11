import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitHubCache } from "./github-cache";
import { githubFetch } from "./github-fetch";

const originalFetch = global.fetch;
beforeEach(() => {
  clearGitHubCache();
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe("githubFetch timeout", () => {
  it("aborts a never-resolving request after the timeout and rejects", async () => {
    vi.useFakeTimers();
    // A fetch that never settles on its own but rejects if its signal aborts,
    // mirroring how the platform fetch reacts to an AbortController.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    // Attach the rejection handler up front so the eventual rejection is never
    // "unhandled" while the fake clock advances.
    const settled = githubFetch("https://api.github.com/x", {}).then(
      () => "resolved" as const,
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(30_000);

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a normal response and clears the timeout", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await githubFetch("https://api.github.com/x", {});

    expect(res.status).toBe(200);
    // The timeout signal is composed in, so a signal is always passed through.
    const passedInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(passedInit.signal).toBeInstanceOf(AbortSignal);
  });
});
