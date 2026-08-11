// @vitest-environment node
// Server/Worker module: mints a GitHub App JWT via Web Crypto, which needs the
// Node environment (see app-jwt.test.ts for why jsdom breaks on Node 20).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTokenCacheForTest,
  getInstallationToken,
} from "./installation-token";

vi.mock("./app-jwt", () => ({ createAppJwt: async () => "test.jwt.sig" }));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  __resetTokenCacheForTest();
});

const env = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pk" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getInstallationToken", () => {
  it("resolves the installation then mints a token", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42 })) // GET .../installation
      .mockResolvedValueOnce(
        jsonResponse({ token: "ghs_abc", expires_at: future }),
      ); // POST access_tokens
    global.fetch = fetchMock as unknown as typeof fetch;

    const token = await getInstallationToken(env, "o", "r");
    expect(token).toBe("ghs_abc");
    expect(fetchMock.mock.calls[0][0]).toContain("/repos/o/r/installation");
    expect(fetchMock.mock.calls[1][0]).toContain(
      "/app/installations/42/access_tokens",
    );

    const mintCall = fetchMock.mock.calls[1];
    const mintInit = mintCall[1] as RequestInit;
    expect(mintInit.method).toBe("POST");
    expect((mintInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(mintInit.body as string)).toEqual({
      repositories: ["r"],
      permissions: { contents: "write" },
    });
  });

  it("caches the token for the same repo (no second mint)", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42 }))
      .mockResolvedValueOnce(
        jsonResponse({ token: "ghs_abc", expires_at: future }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await getInstallationToken(env, "o", "r");
    const again = await getInstallationToken(env, "o", "r");
    expect(again).toBe("ghs_abc");
    expect(fetchMock).toHaveBeenCalledTimes(2); // not 4
  });

  it("throws when the app is not installed on the repo (404)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 404)) as unknown as typeof fetch;
    await expect(getInstallationToken(env, "o", "r")).rejects.toThrow(
      /not installed/i,
    );
  });
});
