/**
 * Thin wrappers around `fetch` for the GitHub API that add:
 *  - conditional requests / ETag caching for reads (`githubGet`), so repeated
 *    reads return a cached body on `304 Not Modified` and don't burn rate
 *    limit;
 *  - rate-limit detection with a clear error and a single short backoff
 *    (`githubFetch`), so a throttled user sees a real message instead of a
 *    bare `GitHub tree failed (403)`.
 */
import {
  type CacheEntry,
  getCachedEntry,
  setCachedEntry,
} from "./github-cache";
import {
  GitHubRateLimitError,
  type GitHubRateLimitInfo,
  SessionExpiredError,
} from "./storage";

/** Longest server-suggested `Retry-After` we'll silently wait out (seconds). */
const MAX_AUTO_RETRY_SECONDS = 5;

/**
 * Per-request timeout. A stalled socket (no response, no error) would otherwise
 * hang a save/read/poll forever; after this we abort the request so it rejects
 * with a clear, catchable error instead.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Combine several abort signals into one that fires as soon as any input does,
 * carrying that input's `reason`. Used to layer our timeout on top of any
 * caller-supplied `init.signal` without clobbering it (prefers the platform
 * `AbortSignal.any` when available). The listeners are `once` and the returned
 * controller is short-lived, so nothing needs explicit teardown.
 */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  const maybeAny = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof maybeAny === "function") return maybeAny(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/**
 * `fetch` with a hard timeout. Aborts after {@link REQUEST_TIMEOUT_MS} so a hung
 * connection rejects (with a clear error) rather than hanging forever. Any
 * `init.signal` the caller passed is composed with the timeout signal, so an
 * external cancel still works and isn't overwritten.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      new Error(`GitHub request timed out after ${REQUEST_TIMEOUT_MS}ms`),
    );
  }, REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? combineSignals([timeoutController.signal, init.signal])
    : timeoutController.signal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspect a response for GitHub rate-limiting. Returns `null` for anything
 * that isn't a rate limit — a plain 403 (e.g. missing permission) is left to
 * the caller's normal error handling.
 */
export function parseRateLimit(res: Response): GitHubRateLimitInfo | null {
  if (res.status !== 403 && res.status !== 429) return null;

  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");

  // 429 is always a (secondary) limit. A 403 only counts when the headers say
  // so — exhausted primary budget (remaining 0) or a Retry-After hint.
  const isRateLimited =
    res.status === 429 || retryAfter !== null || remaining === "0";
  if (!isRateLimited) return null;

  const info: GitHubRateLimitInfo = { status: res.status };
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) info.retryAfterSeconds = seconds;
  }
  if (reset !== null) {
    const epoch = Number(reset);
    if (Number.isFinite(epoch)) info.resetAt = new Date(epoch * 1000);
  }
  return info;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `fetch` plus rate-limit handling. A `401` (expired/revoked token) throws
 * `SessionExpiredError` so callers can boot the user back to sign-in instead of
 * surfacing a bare `… failed (401)`. On a rate-limited response it either backs
 * off once (for a short, server-suggested `Retry-After`) and retries, or
 * throws `GitHubRateLimitError`. All other responses (including non-rate-limit
 * errors like 404) are returned unchanged for the caller to interpret.
 */
export async function githubFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetchWithTimeout(url, init);
  if (res.status === 401) throw new SessionExpiredError(res.status);
  const limit = parseRateLimit(res);
  if (!limit) return res;

  if (
    limit.retryAfterSeconds != null &&
    limit.retryAfterSeconds <= MAX_AUTO_RETRY_SECONDS
  ) {
    await delay(limit.retryAfterSeconds * 1000);
    const retried = await fetchWithTimeout(url, init);
    const retryLimit = parseRateLimit(retried);
    if (!retryLimit) return retried;
    throw new GitHubRateLimitError(retryLimit);
  }

  throw new GitHubRateLimitError(limit);
}

/**
 * Conditional GET with ETag caching. Sends `If-None-Match` when we hold an
 * ETag for `url`; a `304` returns the cached, already-parsed value. On a fresh
 * `200`, `parse` runs and the result is cached under the response ETag.
 *
 * `parse` owns non-rate-limit error handling (e.g. throwing on `!res.ok`); a
 * thrown `parse` skips caching.
 */
export async function githubGet<T>(
  url: string,
  baseHeaders: Record<string, string>,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  const cached: CacheEntry<T> | undefined = getCachedEntry<T>(url);
  const headers = cached
    ? { ...baseHeaders, "If-None-Match": cached.etag }
    : baseHeaders;

  const res = await githubFetch(url, { headers });

  if (res.status === 304 && cached) {
    return cached.data;
  }

  const data = await parse(res);
  const etag = res.headers.get("etag");
  if (etag) setCachedEntry(url, etag, data);
  return data;
}
