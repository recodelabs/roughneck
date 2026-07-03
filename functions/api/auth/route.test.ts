import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestGet, onRequestPost } from "./[[route]]";

const env = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
};

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET /api/auth/login", () => {
  it("redirects to GitHub's authorize URL with client_id, redirect_uri, and state, and never caches", async () => {
    const request = new Request(
      "https://margins.example/api/auth/login?state=abc123",
    );
    const res = await onRequestGet({ request, env });

    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const location = new URL(res.headers.get("Location") || "");
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://margins.example/api/auth/callback",
    );
    expect(location.searchParams.get("state")).toBe("abc123");
  });
});

describe("GET /api/auth/callback", () => {
  it("forwards code+state to the SPA root and never includes a token", async () => {
    const request = new Request(
      "https://margins.example/api/auth/callback?code=the-code&state=the-state",
    );
    const res = await onRequestGet({ request, env });

    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const location = res.headers.get("Location") || "";
    expect(location).toBe(
      "https://margins.example/?code=the-code&state=the-state",
    );
    expect(location).not.toMatch(/token/i);

    const body = await res.text();
    expect(body).not.toMatch(/token/i);
  });

  it("URL-encodes code and state", async () => {
    const request = new Request(
      "https://margins.example/api/auth/callback?code=a%2Bb&state=x%26y",
    );
    const res = await onRequestGet({ request, env });
    const location = res.headers.get("Location") || "";
    expect(location).toBe("https://margins.example/?code=a%2Bb&state=x%26y");
  });
});

describe("GET unknown path", () => {
  it("returns 404 with no-store", async () => {
    const request = new Request("https://margins.example/api/auth/nope");
    const res = await onRequestGet({ request, env });
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /api/auth/token", () => {
  it("exchanges the code and returns {access_token} with no-store", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "gho_realtoken" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const request = new Request("https://margins.example/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "the-code" }),
    });
    const res = await onRequestPost({ request, env });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ access_token: "gho_realtoken" });
  });

  it("returns a generic 500 body that does not leak the thrown error's message", async () => {
    const secretDetail = "client_secret=super-secret-value-should-not-leak";
    global.fetch = vi.fn(async () => {
      throw new Error(secretDetail);
    }) as unknown as typeof fetch;

    const request = new Request("https://margins.example/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "the-code" }),
    });
    const res = await onRequestPost({ request, env });

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).not.toBe(secretDetail);
    expect(body).not.toContain(secretDetail);
    expect(body).not.toContain("super-secret-value-should-not-leak");
  });
});

describe("POST unknown path", () => {
  it("returns 404 with no-store", async () => {
    const request = new Request("https://margins.example/api/auth/nope", {
      method: "POST",
    });
    const res = await onRequestPost({ request, env });
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
