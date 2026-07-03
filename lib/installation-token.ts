import { createAppJwt } from "./app-jwt";

export interface AppEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

const API = "https://api.github.com";
const SKEW_MS = 60_000; // refresh a minute before expiry

interface CacheEntry {
  token: string;
  expiresAtMs: number;
}
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the module-level token cache between cases. */
export function __resetTokenCacheForTest(): void {
  cache.clear();
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "marginsmd",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Return a (cached) installation access token for the App on `owner/repo`.
 * Throws "App not installed" on a 404 from the installation lookup so the
 * caller can fail closed (→ 404 to the client).
 */
export async function getInstallationToken(
  env: AppEnv,
  owner: string,
  repo: string,
): Promise<string> {
  const key = `${owner}/${repo}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs - SKEW_MS > Date.now()) return hit.token;

  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const instRes = await fetch(`${API}/repos/${owner}/${repo}/installation`, {
    headers: appHeaders(jwt),
  });
  if (instRes.status === 404) throw new Error("App not installed on repo");
  if (!instRes.ok)
    throw new Error(`installation lookup failed (${instRes.status})`);
  const installation = (await instRes.json()) as { id: number };

  const tokRes = await fetch(
    `${API}/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...appHeaders(jwt),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write" },
      }),
    },
  );
  if (!tokRes.ok)
    throw new Error(`installation token mint failed (${tokRes.status})`);
  const minted = (await tokRes.json()) as { token: string; expires_at: string };

  cache.set(key, {
    token: minted.token,
    expiresAtMs: Date.parse(minted.expires_at),
  });
  return minted.token;
}
