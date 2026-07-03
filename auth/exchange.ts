export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/** Exchange an OAuth `code` for a GitHub access token. Framework-free. */
export async function exchangeCodeForToken(
  code: string,
  creds: OAuthCredentials,
): Promise<string> {
  if (!code?.trim()) throw new Error("Missing OAuth code");
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (json.error) throw new Error(`GitHub OAuth error: ${json.error}`);
  if (!json.access_token)
    throw new Error("GitHub OAuth: no access_token in response");
  return json.access_token;
}
