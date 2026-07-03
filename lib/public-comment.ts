// lib/public-comment.ts

import { AnchorError, insertPublicComment } from "./insert-public-comment";
import { type AppEnv, getInstallationToken } from "./installation-token";
import { isSafeMarkdownPath } from "./public-doc";
import { readSharingFlags } from "./sharing-flags";

const API = "https://api.github.com";
export const MAX_COMMENT_LEN = 2000;
export const MAX_NAME_LEN = 60;

export interface CommentRequest {
  owner: string;
  repo: string;
  path: string;
  mode: "new" | "reply";
  text: string;
  authorName: string;
  anchor?: { quote: string; occurrence: number };
  parentId?: string;
}

const resp = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const plain = (msg: string, status: number): Response =>
  new Response(msg, { status, headers: { "Cache-Control": "no-store" } });

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "marginsmd",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Chunked base64 — String.fromCharCode(...bytes) overflows the call stack on
// large docs (a real doc can be 100+ KB).
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function handlePublicComment(
  env: AppEnv,
  body: CommentRequest,
  ids: { id: string; atIso: string },
): Promise<Response> {
  const { owner, repo, path, mode, text, authorName } = body;
  if (!owner || !repo || !isSafeMarkdownPath(path))
    return plain("Bad request", 400);
  if (mode !== "new" && mode !== "reply") return plain("Bad request", 400);
  if (!text || text.length > MAX_COMMENT_LEN) return plain("Bad request", 400);
  if (
    !authorName ||
    authorName.trim().length === 0 ||
    authorName.length > MAX_NAME_LEN
  )
    return plain("Bad request", 400);
  if (mode === "new" && !body.anchor?.quote) return plain("Bad request", 400);
  if (mode === "new" && body.anchor?.occurrence !== undefined) {
    const occ = body.anchor.occurrence;
    if (!Number.isInteger(occ) || occ < 1) return plain("Bad request", 400);
  }
  if (mode === "reply" && !body.parentId) return plain("Bad request", 400);

  let token: string;
  try {
    token = await getInstallationToken(env, owner, repo);
  } catch {
    return plain("Not found", 404);
  }

  const contentsUrl = `${API}/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  const readFile = async (): Promise<{
    markdown: string;
    sha: string;
  } | null> => {
    const res = await fetch(contentsUrl, { headers: ghHeaders(token) });
    if (!res.ok) return null;
    const file = (await res.json()) as {
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (!file.content || file.encoding !== "base64" || !file.sha) return null;
    const markdown = new TextDecoder().decode(
      Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) =>
        c.charCodeAt(0),
      ),
    );
    return { markdown, sha: file.sha };
  };

  // Strip CR/LF from authorName to prevent commit message newline injection
  const safeAuthorName = authorName.replace(/[\r\n]/g, "");

  const commit = async (
    newMarkdown: string,
    sha: string,
  ): Promise<Response> => {
    const put = await fetch(contentsUrl, {
      method: "PUT",
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: `Public comment by ${safeAuthorName} (guest) on ${path}`,
        content: toBase64(newMarkdown),
        sha,
        author: {
          name: "margins[bot]",
          email: "margins[bot]@users.noreply.github.com",
        },
        committer: {
          name: "margins[bot]",
          email: "margins[bot]@users.noreply.github.com",
        },
      }),
    });
    return put.ok
      ? resp({ markdown: newMarkdown, comments: true, suggestions: false }, 200)
      : put.status === 409
        ? plain("Conflict", 409)
        : plain("Not found", 404);
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await readFile();
    if (!file) return plain("Not found", 404);
    const flags = readSharingFlags(file.markdown);
    if (!flags.public) return plain("Not found", 404);
    if (!flags.comments) return plain("Forbidden", 403);

    let next: string;
    try {
      next = insertPublicComment(
        file.markdown,
        mode === "new"
          ? {
              mode: "new",
              // biome-ignore lint/style/noNonNullAssertion: guarded above — the "new" branch already returned 400 if body.anchor?.quote was falsy.
              quote: body.anchor!.quote,
              occurrence: body.anchor?.occurrence ?? 1,
              text,
              authorName,
              id: ids.id,
              atIso: ids.atIso,
            }
          : {
              mode: "reply",
              // biome-ignore lint/style/noNonNullAssertion: guarded above — the "reply" branch already returned 400 if body.parentId was falsy.
              parentId: body.parentId!,
              text,
              authorName,
              id: ids.id,
              atIso: ids.atIso,
            },
      );
    } catch (e) {
      if (e instanceof AnchorError) return plain("Conflict", 409);
      return plain("Not found", 404);
    }
    const out = await commit(next, file.sha);
    if (out.status !== 409 || attempt === 1) return out;
  }
  // Unreachable: attempt runs 0..1 and the attempt===1 branch above always
  // returns, so the loop never falls through. Satisfies strict noImplicitReturns.
  throw new Error("unreachable");
}
