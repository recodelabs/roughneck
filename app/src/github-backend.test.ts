import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubBackend } from "./github-backend";
import { clearGitHubCache } from "./github-cache";
import {
  FileTooLargeError,
  GitHubRateLimitError,
  MarkdownFileConflictError,
} from "./storage";

const originalFetch = global.fetch;
// Reset the shared ETag cache between cases so a cached entry from one test
// can't add an `If-None-Match` header to another's fetch assertions.
beforeEach(() => {
  clearGitHubCache();
});
afterEach(() => {
  global.fetch = originalFetch;
});

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function backend() {
  return new GitHubBackend({
    token: "tok",
    owner: "o",
    repo: "r",
    branch: "main",
    login: "octocat",
  });
}
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((byte) => {
    bin += String.fromCharCode(byte);
  });
  return btoa(bin);
};

describe("GitHubBackend", () => {
  it("info reflects repo and login", () => {
    const info = backend().info;
    expect(info.kind).toBe("github");
    expect(info.detail).toBe("o/r@main");
    expect(info.authorLabel).toBe("octocat");
  });

  it("getMarkdownFile decodes content, sets version=sha and a title", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sha: "abc123",
            content: b64("# Hello\n\nbody"),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await backend().getMarkdownFile("docs/x.md");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/o/r/contents/docs/x.md?ref=main",
      {
        headers: {
          Authorization: "Bearer tok",
          Accept: "application/vnd.github+json",
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(page.content).toBe("# Hello\n\nbody");
    expect(page.version).toBe("abc123");
    expect(page.id).toBe("docs/x");
    expect(page.title).toBe("Hello");
  });

  it("saveMarkdownFile PUTs base64 content with the prior sha and returns the new version", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: { sha: "def456" },
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await backend().saveMarkdownFile(
      "docs/x.md",
      "# New\n",
      "abc123",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/o/r/contents/docs/x.md",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer tok",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "Update docs/x.md",
          content: b64("# New\n"),
          sha: "abc123",
          branch: "main",
        }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(page?.version).toBe("def456");
    expect(page?.content).toBe("# New\n");
  });

  it("saveMarkdownFile throws MarkdownFileConflictError on 409, carrying current content", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("?ref=")) {
        return new Response(
          JSON.stringify({
            sha: "server999",
            content: b64("# Server\n"),
            encoding: "base64",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ message: "is at ... but expected ..." }),
        { status: 409 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await backend().saveMarkdownFile("docs/x.md", "# Mine\n", "abc123");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MarkdownFileConflictError);
      expect((e as MarkdownFileConflictError).current.content).toBe(
        "# Server\n",
      );
      expect((e as MarkdownFileConflictError).current.version).toBe(
        "server999",
      );
    }
  });

  it("listMarkdownPaths returns supported blob paths with sizes, skipping others", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tree: [
              { path: "a.md", type: "blob", size: 100 },
              { path: "docs", type: "tree" },
              { path: "docs/b.md", type: "blob", size: 2048 },
              { path: "data.json", type: "blob", size: 64 },
              { path: "config.yaml", type: "blob", size: 32 },
              { path: "notes.txt", type: "blob", size: 16 },
              { path: "patient.fsh", type: "blob", size: 8 },
              { path: "img.png", type: "blob", size: 9999 },
              { path: "script.ts", type: "blob", size: 1234 },
            ],
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const files = await backend().listMarkdownPaths();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/o/r/git/trees/main?recursive=1",
      {
        headers: {
          Authorization: "Bearer tok",
          Accept: "application/vnd.github+json",
        },
        signal: expect.any(AbortSignal),
      },
    );
    // .md/.json/.yaml/.txt/.fsh are listed; .png and .ts are skipped.
    expect(files).toEqual([
      { path: "a.md", size: 100 },
      { path: "docs/b.md", size: 2048 },
      { path: "data.json", size: 64 },
      { path: "config.yaml", size: 32 },
      { path: "notes.txt", size: 16 },
      { path: "patient.fsh", size: 8 },
    ]);
  });

  describe("listPathCommitInfo", () => {
    it("fetches last-commit date and author per path via one GraphQL call", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  f0: {
                    history: {
                      nodes: [
                        {
                          committedDate: "2026-06-20T10:00:00Z",
                          author: {
                            name: "Octo Cat",
                            user: { login: "octocat" },
                          },
                        },
                      ],
                    },
                  },
                  f1: {
                    history: {
                      nodes: [
                        {
                          committedDate: "2026-06-19T10:00:00Z",
                          author: { name: "Amadeus Agent", user: null },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const info = await backend().listPathCommitInfo(["a.md", "docs/b.md"]);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/graphql");
      expect(init.method).toBe("POST");
      expect(headersOf(init).Authorization).toBe("Bearer tok");
      expect(String(init.body)).toContain("a.md");
      expect(String(init.body)).toContain("docs/b.md");

      expect(info.get("a.md")).toEqual({
        date: "2026-06-20T10:00:00Z",
        authorName: "Octo Cat",
        authorLogin: "octocat",
      });
      expect(info.get("docs/b.md")).toEqual({
        date: "2026-06-19T10:00:00Z",
        authorName: "Amadeus Agent",
        authorLogin: null,
      });
    });

    it("omits paths with no commit history", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { repository: { f0: { history: { nodes: [] } } } },
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const info = await backend().listPathCommitInfo(["ghost.md"]);
      expect(info.has("ghost.md")).toBe(false);
    });

    it("returns an empty map for no paths without hitting the API", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const info = await backend().listPathCommitInfo([]);
      expect(info.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("listFileHistory", () => {
    it("fetches recent commits for a path via one GraphQL call", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  object: {
                    history: {
                      nodes: [
                        {
                          oid: "sha2",
                          messageHeadline: "Second change",
                          committedDate: "2026-06-20T10:00:00Z",
                          author: {
                            name: "Octo Cat",
                            user: { login: "octocat" },
                          },
                        },
                        {
                          oid: "sha1",
                          messageHeadline: "First change",
                          committedDate: "2026-06-19T10:00:00Z",
                          author: { name: "Amadeus Agent", user: null },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const commits = await backend().listFileHistory("docs/x.md");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/graphql");
      expect(init.method).toBe("POST");
      expect(headersOf(init).Authorization).toBe("Bearer tok");
      expect(String(init.body)).toContain("docs/x.md");

      expect(commits).toEqual([
        {
          sha: "sha2",
          message: "Second change",
          date: "2026-06-20T10:00:00Z",
          authorName: "Octo Cat",
          authorLogin: "octocat",
        },
        {
          sha: "sha1",
          message: "First change",
          date: "2026-06-19T10:00:00Z",
          authorName: "Amadeus Agent",
          authorLogin: null,
        },
      ]);
    });

    it("returns an empty list when the file has no history", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { repository: { object: { history: { nodes: [] } } } },
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const commits = await backend().listFileHistory("ghost.md");
      expect(commits).toEqual([]);
    });
  });

  describe("readFileAtRef", () => {
    it("reads and decodes a file's content at a specific commit", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "blob1",
              content: b64("# Old\n\nbody"),
              encoding: "base64",
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const content = await backend().readFileAtRef("docs/x.md", "sha1");

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/o/r/contents/docs/x.md?ref=sha1",
        {
          headers: {
            Authorization: "Bearer tok",
            Accept: "application/vnd.github+json",
          },
          signal: expect.any(AbortSignal),
        },
      );
      expect(content).toBe("# Old\n\nbody");
    });

    it("throws FileTooLargeError when GitHub omits inline content", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "blob1",
              content: "",
              encoding: "none",
              size: 2_000_000,
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        backend().readFileAtRef("docs/big.md", "sha1"),
      ).rejects.toBeInstanceOf(FileTooLargeError);
    });
  });

  it("round-trips multibyte UTF-8 content (accents, CJK, emoji)", async () => {
    const text = "# Héllo\n\n日本語 🎉\n";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sha: "m1",
            content: b64(text),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const page = await backend().getMarkdownFile("u.md");
    expect(page.content).toBe(text);
    expect(page.title).toBe("Héllo");
  });

  it("resolveFileUrl returns a raw URL; openProject is a no-op", async () => {
    const bk = backend();
    expect(bk.resolveFileUrl("img/x.png")).toBe(
      "https://raw.githubusercontent.com/o/r/main/img/x.png",
    );
    await expect(bk.openProject("anything")).resolves.toBeUndefined();
  });

  describe("saveAsset", () => {
    it("commits the file to a content-addressed path under assets/ and returns a working reference", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        // Existence check for the content-addressed path: not there yet.
        if (init?.method === undefined || init.method === "GET") {
          return new Response("Not Found", { status: 404 });
        }
        // The commit PUT.
        return new Response(JSON.stringify({ content: { sha: "blobsha" } }), {
          status: 201,
        });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const asset = await backend().saveAsset(
        new File(["hello"], "My Logo.png", { type: "image/png" }),
      );

      // Path: assets/<sanitized-name>-<hash8>.<ext>
      expect(asset.markdownPath).toMatch(/^assets\/My-Logo-[0-9a-f]{8}\.png$/);
      expect(asset.mimeType).toBe("image/png");

      // The PUT carried the base64 bytes, a commit message, and the branch.
      const put = calls.find((c) => c.init?.method === "PUT");
      expect(put).toBeDefined();
      expect(put?.url).toBe(
        `https://api.github.com/repos/o/r/contents/${asset.markdownPath}`,
      );
      const body = JSON.parse(put?.init?.body as string) as {
        content: string;
        branch: string;
        message: string;
        sha?: string;
      };
      expect(body.branch).toBe("main");
      expect(body.content).toBe(b64("hello"));
      expect(body.sha).toBeUndefined();

      // The inserted reference resolves through resolveFileUrl.
      expect(backend().resolveFileUrl(asset.markdownPath)).toBe(
        `https://raw.githubusercontent.com/o/r/main/${asset.markdownPath}`,
      );
    });

    it("de-dupes identical content: reuses the existing blob without a second commit", async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        // Existence check finds the same content already committed.
        if (init?.method === undefined || init.method === "GET") {
          return new Response(JSON.stringify({ sha: "existing" }), {
            status: 200,
          });
        }
        throw new Error("should not PUT an already-present asset");
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const asset = await backend().saveAsset(
        new File(["hello"], "logo.png", { type: "image/png" }),
      );

      expect(asset.markdownPath).toMatch(/^assets\/logo-[0-9a-f]{8}\.png$/);
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(false);
    });

    it("throws a clear error when the commit is rejected (e.g. permission)", async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === undefined || init.method === "GET") {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          { status: 403 },
        );
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        backend().saveAsset(new File(["x"], "x.png", { type: "image/png" })),
      ).rejects.toThrow(/403|not accessible/i);
    });
  });

  describe("readAssetDataUrl", () => {
    it("returns a data: URL with the right MIME from the Contents API base64", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "img1",
              content: b64("PNGDATA"),
              encoding: "base64",
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const url = await backend().readAssetDataUrl("assets/pic.png");
      expect(url).toBe(`data:image/png;base64,${b64("PNGDATA")}`);
      // Authenticated request to the Contents API path.
      const [reqUrl, init] = fetchMock.mock.calls[0];
      expect(String(reqUrl)).toContain("/repos/o/r/contents/assets/pic.png");
      expect(headersOf(init as RequestInit).Authorization).toBe("Bearer tok");
    });

    it("falls back to the Git blob API when the Contents body is empty (>1 MB)", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/git/blobs/")) {
          return new Response(
            JSON.stringify({ content: b64("BIGJPEG"), encoding: "base64" }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ sha: "blobsha", content: "", encoding: "none" }),
          { status: 200 },
        );
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const url = await backend().readAssetDataUrl("assets/big.jpg");
      expect(url).toBe(`data:image/jpeg;base64,${b64("BIGJPEG")}`);
    });

    it("returns null when the asset is missing", async () => {
      const fetchMock = vi.fn(
        async () => new Response("Not Found", { status: 404 }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      expect(await backend().readAssetDataUrl("assets/nope.png")).toBeNull();
    });
  });

  describe("large-file guard", () => {
    it("throws FileTooLargeError when the API returns encoding:none (file over 1 MB)", async () => {
      // GitHub's Contents API omits inline content for files >1 MB, responding
      // with an empty `content` and `encoding: "none"`.
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "big1",
              content: "",
              encoding: "none",
              size: 2_000_000,
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        backend().getMarkdownFile("docs/huge.md"),
      ).rejects.toBeInstanceOf(FileTooLargeError);
      await expect(backend().getMarkdownFile("docs/huge.md")).rejects.toThrow(
        /too large/i,
      );
    });

    it("throws FileTooLargeError when content is empty but the file size is non-zero", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "big2",
              content: "",
              encoding: "base64",
              size: 1_500_000,
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const error = await backend()
        .getMarkdownFile("docs/huge.md")
        .catch((e) => e);
      expect(error).toBeInstanceOf(FileTooLargeError);
      expect((error as FileTooLargeError).path).toBe("docs/huge.md");
      expect((error as FileTooLargeError).size).toBe(1_500_000);
    });

    it("still opens a genuinely empty (0-byte) markdown file", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "empty1",
              content: "",
              encoding: "base64",
              size: 0,
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const page = await backend().getMarkdownFile("docs/empty.md");
      expect(page.content).toBe("");
      expect(page.version).toBe("empty1");
    });
  });

  describe("ETag / conditional-request caching", () => {
    it("first read sends no If-None-Match; a later 304 returns cached content without re-parsing", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: "v1",
              content: b64("# A\n"),
              encoding: "base64",
            }),
            { status: 200, headers: { ETag: '"etag-1"' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 304, headers: { ETag: '"etag-1"' } }),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const bk = backend();
      const first = await bk.getMarkdownFile("docs/x.md");
      const second = await bk.getMarkdownFile("docs/x.md");

      expect(
        headersOf(fetchMock.mock.calls[0][1])["If-None-Match"],
      ).toBeUndefined();
      expect(headersOf(fetchMock.mock.calls[1][1])["If-None-Match"]).toBe(
        '"etag-1"',
      );
      // The 304 body is empty — proof we served the cached parse, not res.json().
      expect(second).toEqual(first);
      expect(second.content).toBe("# A\n");
    });

    it("caches the tree listing and serves a 304 from cache", async () => {
      const tree = JSON.stringify({
        tree: [{ path: "a.md", type: "blob", size: 7 }],
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(tree, { status: 200, headers: { ETag: '"tree-1"' } }),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 304, headers: { ETag: '"tree-1"' } }),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const bk = backend();
      expect(await bk.listMarkdownPaths()).toEqual([{ path: "a.md", size: 7 }]);
      expect(await bk.listMarkdownPaths()).toEqual([{ path: "a.md", size: 7 }]);
      expect(headersOf(fetchMock.mock.calls[1][1])["If-None-Match"]).toBe(
        '"tree-1"',
      );
    });

    it("invalidates the cached read after a successful save", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: "v1",
              content: b64("# A\n"),
              encoding: "base64",
            }),
            { status: 200, headers: { ETag: '"e1"' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ content: { sha: "v2" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sha: "v2",
              content: b64("# B\n"),
              encoding: "base64",
            }),
            { status: 200, headers: { ETag: '"e2"' } },
          ),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const bk = backend();
      await bk.getMarkdownFile("docs/x.md");
      await bk.saveMarkdownFile("docs/x.md", "# B\n", "v1");
      const reread = await bk.getMarkdownFile("docs/x.md");

      // The post-save read must NOT carry the stale ETag.
      expect(
        headersOf(fetchMock.mock.calls[2][1])["If-None-Match"],
      ).toBeUndefined();
      expect(reread.content).toBe("# B\n");
    });
  });

  describe("rate-limit handling", () => {
    it("throws GitHubRateLimitError with a clear message on a 403 with remaining=0 (not the bare tree error)", async () => {
      const reset = Math.floor(Date.now() / 1000) + 600;
      const fetchMock = vi.fn(
        async () =>
          new Response("rate limited", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset),
            },
          }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const error = await backend()
        .listMarkdownPaths()
        .catch((e) => e);
      expect(error).toBeInstanceOf(GitHubRateLimitError);
      expect(error.message).toMatch(/rate limit/i);
      expect(error.message).not.toMatch(/tree failed/i);
      expect((error as GitHubRateLimitError).resetAt).toBeInstanceOf(Date);
    });

    it("treats a 429 with Retry-After as a rate limit on reads", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const error = await backend()
        .getMarkdownFile("a.md")
        .catch((e) => e);
      expect(error).toBeInstanceOf(GitHubRateLimitError);
      expect((error as GitHubRateLimitError).retryAfterSeconds).toBe(30);
    });

    it("leaves a plain 403 (no rate-limit headers) as the normal labeled error", async () => {
      const fetchMock = vi.fn(
        async () => new Response("forbidden", { status: 403 }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(backend().listMarkdownPaths()).rejects.toThrow(
        /tree failed \(403\)/i,
      );
    });

    it("backs off once on a short Retry-After and then succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("", { status: 429, headers: { "retry-after": "0" } }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              tree: [{ path: "a.md", type: "blob", size: 11 }],
            }),
            { status: 200 },
          ),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const files = await backend().listMarkdownPaths();
      expect(files).toEqual([{ path: "a.md", size: 11 }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rate-limits saves too (no silent 403 swallow)", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(
        backend().saveMarkdownFile("a.md", "# x\n"),
      ).rejects.toBeInstanceOf(GitHubRateLimitError);
    });
  });

  describe("createMarkdownFile", () => {
    it("PUTs base64 content with NO sha and a Create message", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ content: { sha: "new1" } }), {
            status: 201,
          }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const page = await backend().createMarkdownFile(
        "docs/new.md",
        "# Untitled\n",
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/o/r/contents/docs/new.md",
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer tok",
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: "Create docs/new.md",
            content: b64("# Untitled\n"),
            branch: "main",
          }),
          signal: expect.any(AbortSignal),
        },
      );
      expect(page?.version).toBe("new1");
      expect(page?.content).toBe("# Untitled\n");
    });

    it("maps a sha-collision 422 to an already-exists error", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
            }),
            { status: 422 },
          ),
      ) as unknown as typeof fetch;

      await expect(
        backend().createMarkdownFile("docs/dup.md", "# x\n"),
      ).rejects.toThrow(/already exists/);
    });

    it("surfaces a non-collision 422 as a generic create error", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ message: "path contains a malformed segment" }),
            {
              status: 422,
            },
          ),
      ) as unknown as typeof fetch;

      const promise = backend().createMarkdownFile("docs/weird.md", "# x\n");
      await expect(promise).rejects.toThrow(/malformed segment/);
      await expect(promise).rejects.not.toThrow(/already exists/);
    });

    it("rejects an unsupported file type without calling fetch", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        backend().createMarkdownFile("logo.png", "x"),
      ).rejects.toThrow("This file type can't be created in margins");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("activity log", () => {
    it("readActivityLog returns [] when the log file is absent (404)", async () => {
      global.fetch = vi.fn(
        async () => new Response("not found", { status: 404 }),
      ) as unknown as typeof fetch;
      await expect(backend().readActivityLog("docs/x.md")).resolves.toEqual([]);
    });

    it("readActivityLog parses the JSONL content", async () => {
      const line = JSON.stringify({
        id: "a1",
        at: "2026-06-13T12:00:00.000Z",
        by: "octocat",
        role: "user",
        type: "rewrite",
        instruction: "tighten",
      });
      global.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "s1",
              content: b64(`${line}\n`),
              encoding: "base64",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;
      const entries = await backend().readActivityLog("docs/x.md");
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("a1");
    });

    it("appendActivityEntry reads, appends and PUTs with the prior sha", async () => {
      const existing = JSON.stringify({
        id: "a0",
        at: "2026-06-13T11:00:00.000Z",
        by: "octocat",
        role: "user",
        type: "comments",
        instruction: "apply",
      });
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== "PUT") {
          return new Response(
            JSON.stringify({
              sha: "log-sha",
              content: b64(`${existing}\n`),
              encoding: "base64",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ content: { sha: "new" } }), {
          status: 200,
        });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const entry = {
        id: "a1",
        at: "2026-06-13T12:00:00.000Z",
        by: "octocat",
        role: "user" as const,
        type: "rewrite" as const,
        instruction: "tighten",
      };
      await backend().appendActivityEntry("docs/x.md", entry);

      const putCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit)?.method === "PUT",
      );
      expect(putCall?.[0]).toBe(
        "https://api.github.com/repos/o/r/contents/.margins/docs/x.md.activity.jsonl",
      );
      const body = JSON.parse((putCall?.[1] as RequestInit).body as string);
      expect(body.sha).toBe("log-sha");
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)),
      );
      expect(decoded).toBe(`${existing}\n${JSON.stringify(entry)}\n`);
    });

    it("readActivityLog throws rather than truncating when the log is too large to inline", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "big",
              content: "",
              encoding: "none",
              size: 2000000,
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;
      await expect(backend().readActivityLog("docs/x.md")).rejects.toThrow();
    });

    it("retries the append once when the first PUT 422s on a stale sha", async () => {
      let getCount = 0;
      let putCount = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          putCount += 1;
          if (putCount === 1) {
            // stale sha — someone else appended first
            return new Response(
              JSON.stringify({ message: "is at abc but expected def" }),
              { status: 422 },
            );
          }
          return new Response(JSON.stringify({ content: { sha: "ok" } }), {
            status: 200,
          });
        }
        getCount += 1;
        const sha = getCount === 1 ? "sha-1" : "sha-2";
        return new Response(
          JSON.stringify({ sha, content: b64("{}\n"), encoding: "base64" }),
          { status: 200 },
        );
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const entry = {
        id: "a1",
        at: "2026-06-13T12:00:00.000Z",
        by: "octocat",
        role: "user" as const,
        type: "rewrite" as const,
        instruction: "tighten",
      };
      await expect(
        backend().appendActivityEntry("docs/x.md", entry),
      ).resolves.toBeUndefined();

      const putCalls = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit)?.method === "PUT",
      );
      expect(putCalls).toHaveLength(2);
      // the retry used the freshly re-read sha
      const secondBody = JSON.parse(
        (putCalls[1][1] as RequestInit).body as string,
      );
      expect(secondBody.sha).toBe("sha-2");
    });

    it("throws if the append still 422s after the retry", async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return new Response(
            JSON.stringify({ message: "is at abc but expected def" }),
            { status: 422 },
          );
        }
        return new Response(
          JSON.stringify({
            sha: "s",
            content: b64("{}\n"),
            encoding: "base64",
          }),
          { status: 200 },
        );
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(
        backend().appendActivityEntry("docs/x.md", {
          id: "a1",
          at: "t",
          by: "octocat",
          role: "user",
          type: "rewrite",
          instruction: "x",
        }),
      ).rejects.toThrow(/422/);
    });

    it("does not retry a non-sha-conflict 422 (throws immediately)", async () => {
      let puts = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts += 1;
          return new Response(JSON.stringify({ message: "path is invalid" }), {
            status: 422,
          });
        }
        return new Response(
          JSON.stringify({
            sha: "s",
            content: b64("{}\n"),
            encoding: "base64",
          }),
          { status: 200 },
        );
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(
        backend().appendActivityEntry("docs/x.md", {
          id: "a1",
          at: "t",
          by: "octocat",
          role: "user",
          type: "rewrite",
          instruction: "x",
        }),
      ).rejects.toThrow(/422/);
      expect(puts).toBe(1); // no retry
    });
  });

  it("watchActivityLog polls, fires on change, and stops on unsubscribe", async () => {
    vi.useFakeTimers();
    const log1 =
      '{"id":"i1","at":"t","by":"u","role":"user","type":"custom","instruction":"x"}\n';
    const log2 =
      log1 +
      '{"id":"a1","at":"t","by":"agent","role":"agent","replyTo":"i1","status":"done","summary":"s","commit":"abc"}\n';
    const bodies = [log1, log1, log2];
    let call = 0;
    global.fetch = vi.fn(async () => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return new Response(
        JSON.stringify({
          sha: `sha${call}`,
          content: b64(body),
          encoding: "base64",
        }),
        { status: 200 },
      );
    });

    const seen: number[] = [];
    const stop = backend().watchActivityLog("doc.md", (entries) => {
      seen.push(entries.length);
    });

    // Baseline tick (immediate) -> fires once with 1 entry.
    await vi.advanceTimersByTimeAsync(0);
    // Second poll: identical content -> no fire.
    await vi.advanceTimersByTimeAsync(10_000);
    // Third poll: the agent reply appears -> fires with 2 entries.
    await vi.advanceTimersByTimeAsync(10_000);

    stop();
    const callsAfterStop = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterStop,
    );

    expect(seen).toEqual([1, 2]);
    vi.useRealTimers();
  });

  it("watchActivityLog skips a tick while the previous request is still in flight", async () => {
    vi.useFakeTimers();
    // A fetch that stays pending until we release it, so the baseline tick is
    // still outstanding when the next interval fires.
    let releaseFetch: (() => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () =>
            resolve(
              new Response(
                JSON.stringify({
                  sha: "s",
                  content: b64(""),
                  encoding: "base64",
                }),
                { status: 200 },
              ),
            );
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const stop = backend().watchActivityLog("doc.md", () => {});

    // Immediate baseline tick issues one request that stays pending.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Two intervals fire while the first tick is still outstanding: both skip,
    // so no extra concurrent request piles up.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once the in-flight request settles, the next interval issues a fresh one.
    releaseFetch?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
    vi.useRealTimers();
  });

  it("commitUrl points at the repo commit", () => {
    expect(backend().commitUrl("abc123")).toBe(
      "https://github.com/o/r/commit/abc123",
    );
  });

  describe("getRepoPermission", () => {
    it("returns true when the repo reports push access", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ permissions: { push: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      expect(await backend().getRepoPermission()).toBe(true);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/repos/o/r");
    });

    it("returns false when push is false", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ permissions: { push: false } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ) as unknown as typeof fetch;
      expect(await backend().getRepoPermission()).toBe(false);
    });

    it("returns false when the request fails (non-ok status)", async () => {
      global.fetch = vi.fn(
        async () => new Response("forbidden", { status: 403 }),
      ) as unknown as typeof fetch;
      expect(await backend().getRepoPermission()).toBe(false);
    });

    it("returns false when fetch throws (network error)", async () => {
      global.fetch = vi.fn(async () => {
        throw new Error("network error");
      }) as unknown as typeof fetch;
      expect(await backend().getRepoPermission()).toBe(false);
    });
  });

  describe("supported-file-type guard", () => {
    it("getMarkdownFile rejects an unsupported path without calling fetch", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(backend().getMarkdownFile("data.csv")).rejects.toThrow(
        "This file type can't be opened in margins",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("saveMarkdownFile rejects an unsupported path without calling fetch", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(backend().saveMarkdownFile("logo.png", "x")).rejects.toThrow(
        "This file type can't be opened in margins",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("getMarkdownFile reads a non-markdown supported type (.json)", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "j1",
              content: b64('{\n  "a": 1\n}\n'),
              encoding: "base64",
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      const page = await backend().getMarkdownFile("data.json");
      expect(page.content).toBe('{\n  "a": 1\n}\n');
      expect(fetchMock).toHaveBeenCalled();
    });

    it("getMarkdownFile accepts a .MD (uppercase) path", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sha: "x1",
              content: b64("# Upper\n"),
              encoding: "base64",
            }),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      const page = await backend().getMarkdownFile("NOTE.MD");
      expect(page.content).toBe("# Upper\n");
    });
  });

  describe("listCollaborators", () => {
    it("returns deduped logins from the collaborators endpoint", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { login: "alice", type: "User" },
              { login: "bob", type: "User" },
              { login: "alice", type: "User" },
            ]),
            { status: 200 },
          ),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const logins = await backend().listCollaborators();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/o/r/collaborators?per_page=100",
        {
          headers: {
            Authorization: "Bearer tok",
            Accept: "application/vnd.github+json",
          },
        },
      );
      expect(logins).toEqual(["alice", "bob"]);
    });

    it("falls back to contributors when collaborators is forbidden", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 403 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ login: "carol" }, { login: null }]), {
            status: 200,
          }),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const logins = await backend().listCollaborators();

      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://api.github.com/repos/o/r/contributors?per_page=100",
        expect.anything(),
      );
      expect(logins).toEqual(["carol"]);
    });

    it("returns [] when both endpoints fail", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 403 }))
        .mockResolvedValueOnce(new Response("", { status: 404 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      expect(await backend().listCollaborators()).toEqual([]);
    });

    it("returns [] when the request throws", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("network down");
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      expect(await backend().listCollaborators()).toEqual([]);
    });
  });

  describe("propose-changes (PR) mode", () => {
    interface Call {
      url: string;
      method: string;
      // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary bodies
      body?: any;
    }
    function route(handler: (url: string, method: string) => Response): Call[] {
      const calls: Call[] = [];
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({
          url,
          method,
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return handler(url, method);
      }) as unknown as typeof fetch;
      return calls;
    }

    it("exposes the pullRequests capability", () => {
      expect(backend().capabilities.pullRequests).toBe(true);
    });

    it("save creates a working branch, commits there, and opens a PR", async () => {
      const b = backend();
      b.setProposeChanges(true);
      const calls = route((url, method) => {
        if (url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/git/refs") && method === "POST") {
          return new Response("{}", { status: 201 });
        }
        if (url.includes("/contents/docs/x.md") && method === "PUT") {
          return new Response(JSON.stringify({ content: { sha: "worksha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/pulls") && method === "POST") {
          return new Response(
            JSON.stringify({ html_url: "https://github.com/o/r/pull/7" }),
            { status: 201 },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      });

      const page = await b.saveMarkdownFile("docs/x.md", "# New\n", "basesha");

      expect(page.version).toBe("worksha");
      expect(b.pullRequestUrl()).toBe("https://github.com/o/r/pull/7");

      const createRef = calls.find((c) => c.url.endsWith("/git/refs"));
      expect(createRef?.body).toEqual({
        ref: "refs/heads/margins/octocat/main",
        sha: "basesha",
      });
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body.branch).toBe("margins/octocat/main");
      const pull = calls.find(
        (c) => c.url.endsWith("/pulls") && c.method === "POST",
      );
      expect(pull?.body.head).toBe("margins/octocat/main");
      expect(pull?.body.base).toBe("main");
    });

    it("reuses an existing branch and PR (422s) without erroring", async () => {
      const b = backend();
      b.setProposeChanges(true);
      route((url, method) => {
        if (url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/git/refs") && method === "POST") {
          // Branch already exists.
          return new Response(
            JSON.stringify({ message: "Reference already exists" }),
            { status: 422 },
          );
        }
        if (url.includes("/contents/docs/x.md") && method === "PUT") {
          return new Response(JSON.stringify({ content: { sha: "worksha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/pulls") && method === "POST") {
          // A PR is already open.
          return new Response(
            JSON.stringify({ message: "A pull request already exists" }),
            { status: 422 },
          );
        }
        if (url.includes("/pulls?head=") && method === "GET") {
          return new Response(
            JSON.stringify([{ html_url: "https://github.com/o/r/pull/3" }]),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      });

      const page = await b.saveMarkdownFile("docs/x.md", "# New\n", "basesha");
      expect(page.version).toBe("worksha");
      expect(b.pullRequestUrl()).toBe("https://github.com/o/r/pull/3");
    });

    it("reads from the base branch until the working branch exists, then from it", async () => {
      const b = backend();
      b.setProposeChanges(true);
      const calls = route((url, method) => {
        // The pre-existing-branch probe: this branch isn't there yet.
        if (url.includes("/git/ref/heads/margins/octocat/main")) {
          return new Response("Not Found", { status: 404 });
        }
        if (url.includes("/git/trees/")) {
          return new Response(JSON.stringify({ tree: [] }), { status: 200 });
        }
        if (url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/git/refs") && method === "POST") {
          return new Response("{}", { status: 201 });
        }
        if (url.includes("/contents/") && method === "PUT") {
          return new Response(JSON.stringify({ content: { sha: "worksha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/pulls") && method === "POST") {
          return new Response(
            JSON.stringify({ html_url: "https://github.com/o/r/pull/9" }),
            { status: 201 },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      });

      // Before any write, the listing comes from the base branch.
      await b.listMarkdownPaths();
      expect(calls.some((c) => c.url.includes("/git/trees/main"))).toBe(true);

      // A save creates the working branch...
      await b.saveMarkdownFile("docs/x.md", "# New\n", "basesha");

      // ...and now reads target the working branch.
      calls.length = 0;
      await b.listMarkdownPaths();
      expect(
        calls.some((c) => c.url.includes("/git/trees/margins/octocat/main")),
      ).toBe(true);
    });

    it("commits straight to the base branch when the toggle is off", async () => {
      const b = backend();
      const calls = route((url, method) => {
        if (url.includes("/contents/docs/x.md") && method === "PUT") {
          return new Response(JSON.stringify({ content: { sha: "def456" } }), {
            status: 200,
          });
        }
        throw new Error(`unexpected ${method} ${url}`);
      });
      await b.saveMarkdownFile("docs/x.md", "# New\n", "abc123");
      expect(b.pullRequestUrl()).toBeNull();
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body.branch).toBe("main");
      // No branch/PR machinery was touched.
      expect(calls.every((c) => !c.url.includes("/git/refs"))).toBe(true);
      expect(calls.every((c) => !c.url.endsWith("/pulls"))).toBe(true);
    });

    it("saveAsset commits to the working branch (not the base branch) in propose mode", async () => {
      const b = backend();
      b.setProposeChanges(true);
      const calls = route((url, method) => {
        if (url.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "basesha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/git/refs") && method === "POST") {
          return new Response("{}", { status: 201 });
        }
        // Dedupe existence check: not present yet.
        if (url.includes("/contents/assets/") && method === "GET") {
          return new Response("Not Found", { status: 404 });
        }
        if (url.includes("/contents/assets/") && method === "PUT") {
          return new Response(
            JSON.stringify({ content: { sha: "assetsha" } }),
            {
              status: 201,
            },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      });

      await b.saveAsset(new File(["hi"], "pic.png", { type: "image/png" }));

      // Both the existence-check read and the commit target the working branch.
      const check = calls.find(
        (c) => c.url.includes("/contents/assets/") && c.method === "GET",
      );
      expect(check?.url).toContain("ref=margins/octocat/main");
      const put = calls.find(
        (c) => c.url.includes("/contents/assets/") && c.method === "PUT",
      );
      expect(put?.body.branch).toBe("margins/octocat/main");
    });

    it("listFileHistory queries the working branch (this.ref) once adopted", async () => {
      const b = backend();
      b.setProposeChanges(true);
      const calls = route((url, method) => {
        // Probe: the working branch already exists — adopt it.
        if (url.includes("/git/ref/heads/margins/octocat/main")) {
          return new Response(JSON.stringify({ object: { sha: "worksha" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/graphql")) {
          return new Response(
            JSON.stringify({
              data: { repository: { object: { history: { nodes: [] } } } },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      });

      await b.listFileHistory("docs/x.md");

      const gql = calls.find((c) => c.url.endsWith("/graphql"));
      // The GraphQL object(expression) uses the working branch, not base "main".
      expect(String(gql?.body.query)).toContain("margins/octocat/main");
    });

    it("a reused, pre-existing working branch does not spuriously conflict on first save", async () => {
      const b = backend();
      b.setProposeChanges(true);
      const calls = route((url, method) => {
        // Probe finds the working branch (left over from a prior session).
        if (url.includes("/git/ref/heads/margins/octocat/main")) {
          return new Response(JSON.stringify({ object: { sha: "worksha" } }), {
            status: 200,
          });
        }
        // The read comes from the working branch: its real sha + content.
        if (url.includes("/contents/docs/x.md") && method === "GET") {
          return new Response(
            JSON.stringify({
              sha: "worksha",
              content: b64("# working\n"),
              encoding: "base64",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/contents/docs/x.md") && method === "PUT") {
          return new Response(
            JSON.stringify({ content: { sha: "worksha2" } }),
            {
              status: 200,
            },
          );
        }
        if (url.endsWith("/pulls") && method === "POST") {
          return new Response(
            JSON.stringify({ html_url: "https://github.com/o/r/pull/5" }),
            { status: 201 },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      });

      // Opening the doc reflects the working branch, not stale base content.
      const opened = await b.getMarkdownFile("docs/x.md");
      expect(opened.version).toBe("worksha");
      expect(opened.content).toBe("# working\n");
      const read = calls.find(
        (c) => c.url.includes("/contents/docs/x.md") && c.method === "GET",
      );
      expect(read?.url).toContain("ref=margins/octocat/main");

      // The first save PUTs the working branch sha against the working branch —
      // no re-create (branch was adopted via probe), no phantom conflict.
      const page = await b.saveMarkdownFile(
        "docs/x.md",
        "# edited\n",
        "worksha",
      );
      expect(page.version).toBe("worksha2");
      const put = calls.find(
        (c) => c.url.includes("/contents/docs/x.md") && c.method === "PUT",
      );
      expect(put?.body.branch).toBe("margins/octocat/main");
      expect(put?.body.sha).toBe("worksha");
      expect(calls.every((c) => !c.url.endsWith("/git/refs"))).toBe(true);
    });
  });
});
