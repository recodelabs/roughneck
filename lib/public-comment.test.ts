// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublicComment } from "./public-comment";

vi.mock("./installation-token", () => ({
  getInstallationToken: async () => "ghs_test",
}));
const env = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pk" };
const ids = { id: "g1", atIso: "2026-06-18T00:00:00.000Z" };
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function fileResponse(markdown: string) {
  return new Response(
    JSON.stringify({
      content: Buffer.from(markdown, "utf8").toString("base64"),
      encoding: "base64",
      sha: "abc123",
    }),
    { status: 200 },
  );
}
const req = (
  over: Partial<Parameters<typeof handlePublicComment>[1]> = {},
) => ({
  owner: "o",
  repo: "r",
  path: "d.md",
  mode: "new" as const,
  text: "hi",
  authorName: "Jane",
  anchor: { quote: "cat", occurrence: 1 },
  ...over,
});

describe("handlePublicComment", () => {
  it("403 when comments flag is off", async () => {
    global.fetch = vi.fn(async () =>
      fileResponse("---\npublic: true\n---\nThe cat.\n"),
    ) as never;
    const res = await handlePublicComment(env, req(), ids);
    expect(res.status).toBe(403);
  });

  it("400 on over-length text", async () => {
    const res = await handlePublicComment(
      env,
      req({ text: "x".repeat(2001) }),
      ids,
    );
    expect(res.status).toBe(400);
  });

  it("409 when the anchor quote is missing", async () => {
    global.fetch = vi.fn(async () =>
      fileResponse("---\npublic: true\ncomments: true\n---\nno match here\n"),
    ) as never;
    const res = await handlePublicComment(env, req(), ids);
    expect(res.status).toBe(409);
  });

  it("commits the inserted comment as margins[bot] and returns 200", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method !== "PUT")
        return fileResponse(
          "---\npublic: true\ncomments: true\n---\nThe cat sat.\n",
        );
      return new Response(JSON.stringify({ commit: { sha: "new" } }), {
        status: 200,
      });
    }) as never;
    const res = await handlePublicComment(env, req(), ids);
    expect(res.status).toBe(200);
    const put = calls.find((c) => c.init?.method === "PUT");
    const sent = JSON.parse(String(put?.init?.body));
    const decoded = Buffer.from(sent.content, "base64").toString("utf8");
    expect(decoded).toContain("{==cat==}{>>hi<<}");
    expect(decoded).toContain('guest="true"');
    expect(sent.sha).toBe("abc123");
    expect(sent.author.name).toBe("margins[bot]");
    expect(sent.message).toContain("Public comment by Jane (guest)");
  });

  it("never accepts caller-supplied file content", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method !== "PUT")
        return fileResponse(
          "---\npublic: true\ncomments: true\n---\nThe cat sat.\n",
        );
      return new Response(JSON.stringify({ commit: { sha: "new" } }), {
        status: 200,
      });
    }) as never;
    // @ts-expect-error — content is not part of CommentRequest
    const res = await handlePublicComment(env, req({ content: "evil" }), ids);
    expect(res.status).toBe(200); // ignored, normal insert
    const put = calls.find((c) => c.init?.method === "PUT");
    const sent = JSON.parse(String(put?.init?.body));
    const decoded = Buffer.from(sent.content, "base64").toString("utf8");
    // The PUT body must NOT contain the caller-supplied "evil" content string
    expect(decoded).not.toContain("evil");
    // The PUT body MUST contain the server-inserted comment markup
    expect(decoded).toContain("{==cat==}");
    expect(decoded).toContain('guest="true"');
  });

  it("400 when new-mode anchor.occurrence is 0 — fetch never called", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const res = await handlePublicComment(
      env,
      req({ anchor: { quote: "cat", occurrence: 0 } }),
      ids,
    );
    expect(res.status).toBe(400);
    // GitHub must never be contacted for invalid input
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 when new-mode anchor.occurrence is negative — fetch never called", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const res = await handlePublicComment(
      env,
      req({ anchor: { quote: "cat", occurrence: -5 } }),
      ids,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries on 409: PUT 409 then 200 → final 200, GET called twice", async () => {
    let putAttempts = 0;
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method !== "PUT")
        return fileResponse(
          "---\npublic: true\ncomments: true\n---\nThe cat sat.\n",
        );
      putAttempts++;
      if (putAttempts === 1) return new Response("Conflict", { status: 409 });
      return new Response(JSON.stringify({ commit: { sha: "new2" } }), {
        status: 200,
      });
    }) as never;
    const res = await handlePublicComment(env, req(), ids);
    expect(res.status).toBe(200);
    const getCalls = calls.filter((c) => c.init?.method !== "PUT");
    expect(getCalls.length).toBe(2); // re-read after 409
  });

  it("returns 409 when PUT 409 twice (no more retries)", async () => {
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT")
        return fileResponse(
          "---\npublic: true\ncomments: true\n---\nThe cat sat.\n",
        );
      return new Response("Conflict", { status: 409 });
    }) as never;
    const res = await handlePublicComment(env, req(), ids);
    expect(res.status).toBe(409);
  });

  it("strips newlines from authorName in commit message", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method !== "PUT")
        return fileResponse(
          "---\npublic: true\ncomments: true\n---\nThe cat sat.\n",
        );
      return new Response(JSON.stringify({ commit: { sha: "new" } }), {
        status: 200,
      });
    }) as never;
    const res = await handlePublicComment(
      env,
      req({ authorName: "Bad\nName\r\nEvil" }),
      ids,
    );
    expect(res.status).toBe(200);
    const put = calls.find((c) => c.init?.method === "PUT");
    const sent = JSON.parse(String(put?.init?.body));
    // Commit message must be a single line — no CR or LF
    expect(sent.message).not.toMatch(/[\r\n]/);
  });
});
