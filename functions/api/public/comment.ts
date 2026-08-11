import {
  type CommentRequest,
  handlePublicComment,
} from "../../../lib/public-comment";

interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

export const onRequestPost: (ctx: {
  request: Request;
  env: Env;
}) => Promise<Response> = async ({ request, env }) => {
  let body: CommentRequest;
  try {
    body = (await request.json()) as CommentRequest;
  } catch {
    return new Response("Bad request", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const id = crypto.randomUUID();
  const atIso = new Date().toISOString();
  return handlePublicComment(env, body, { id, atIso });
};
