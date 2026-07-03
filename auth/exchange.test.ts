import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeCodeForToken } from "./exchange";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("exchangeCodeForToken", () => {
  it("posts code+credentials to GitHub and returns the access token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "gho_xyz", token_type: "bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const token = await exchangeCodeForToken("the-code", {
      clientId: "cid",
      clientSecret: "secret",
    });

    expect(token).toBe("gho_xyz");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      client_id: "cid",
      client_secret: "secret",
      code: "the-code",
    });
  });

  it("rejects a blank code without calling GitHub", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken("", { clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/code/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws if GitHub returns an error payload", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "bad_verification_code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken("x", { clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/bad_verification_code/);
  });
});
