import { exchangeCodeForToken } from "../../../auth/exchange";

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

// Auth responses must never be cached (a cached redirect/token is a correctness
// and security hazard — and the edge will otherwise cache these on *.pages.dev).
const noStore = { "Cache-Control": "no-store" };

export const onRequestGet: (ctx: {
  request: Request;
  env: Env;
}) => Promise<Response> = async ({ request, env }) => {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") {
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authorize.searchParams.set(
      "redirect_uri",
      `${url.origin}/api/auth/callback`,
    );
    authorize.searchParams.set("state", url.searchParams.get("state") || "");
    return new Response(null, {
      status: 302,
      headers: { Location: authorize.toString(), ...noStore },
    });
  }
  if (url.pathname === "/api/auth/callback") {
    // Forward the single-use OAuth `code` (and `state`) to the SPA — never the
    // access token. The SPA verifies `state` and exchanges the code for the token
    // via a same-origin POST, so the token never appears in a URL/Location header.
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const location = `${url.origin}/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return new Response(null, {
      status: 302,
      headers: { Location: location, ...noStore },
    });
  }
  return new Response("Not found", { status: 404, headers: noStore });
};

export const onRequestPost: (ctx: {
  request: Request;
  env: Env;
}) => Promise<Response> = async ({ request, env }) => {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/token") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        code?: string;
      };
      const token = await exchangeCodeForToken(body.code || "", {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      });
      return new Response(JSON.stringify({ access_token: token }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...noStore },
      });
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), {
        status: 500,
        headers: noStore,
      });
    }
  }
  return new Response("Not found", { status: 404, headers: noStore });
};
