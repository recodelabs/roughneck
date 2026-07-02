import { serializeForChangeCheck } from "./activity-live";
import {
  type ActivityEntry,
  activityLogPath,
  appendActivityLine,
  parseActivityLog,
} from "./activity-log";
import { isSupportedPath } from "./file-types";
import { invalidateCachedUrl } from "./github-cache";
import { githubFetch, githubGet } from "./github-fetch";
import type { FileMeta } from "./github-tree";
import { titleFromContent } from "./markdown";
import {
  type BackendCapabilities,
  type BackendInfo,
  type FileCommit,
  FileTooLargeError,
  MarkdownFileConflictError,
  type Page,
  type StorageBackend,
  type StoredAsset,
} from "./storage";

export interface GitHubBackendConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  login: string;
}

/** Last-commit metadata for a single file, as shown in the file list. */
export interface FileCommitInfo {
  /** ISO 8601 committed date of the most recent commit touching the file. */
  date: string;
  /** Commit author's display name (may be empty if GitHub omits it). */
  authorName: string;
  /** Author's GitHub login when the commit maps to a user, else null. */
  authorLogin: string | null;
}

const API = "https://api.github.com";
const ACTIVITY_POLL_MS = 10_000;

function pageId(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "");
}
function decodeBase64(b64: string): string {
  const bytes = Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) =>
    c.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}
function encodeBase64Bytes(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((byte) => {
    bin += String.fromCharCode(byte);
  });
  return btoa(bin);
}
function encodeBase64(text: string): string {
  return encodeBase64Bytes(new TextEncoder().encode(text));
}

/** Lowercase hex SHA-256 of the given bytes (used to content-address assets). */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Best-effort MIME type from a file extension, for building `data:` URLs. */
function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/** Strip characters that are awkward in a repo path, keeping a readable stem. */
function sanitizeAssetName(filename: string): string {
  const trimmed = filename.trim() || "attachment";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Content-addressed repo path for an uploaded asset:
 * `assets/<sanitized-stem>-<hash8><.ext>`. Embedding a slice of the content
 * hash means identical bytes always map to the same path (free de-dupe) while
 * different files that happen to share a name never collide.
 */
function assetPath(filename: string, hashHex: string): string {
  const safe = sanitizeAssetName(filename);
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  return `assets/${stem}-${hashHex.slice(0, 8)}${ext}`;
}

/** Sanitise a path segment so it's safe to embed in a git branch name. */
function branchSafe(segment: string): string {
  return (
    segment
      .replace(/[^a-zA-Z0-9._/-]+/g, "-")
      .replace(/^[-./]+|[-./]+$/g, "")
      .replace(/\.\.+/g, "-") || "x"
  );
}

export class GitHubBackend implements StorageBackend {
  info: BackendInfo;
  capabilities: BackendCapabilities = {
    documentPath: false,
    manualCommit: true,
    remoteSession: false,
    createFile: true,
    activityLog: true,
    pullRequests: true,
  };
  canManageProjects = false;
  private cfg: GitHubBackendConfig;

  /**
   * "Propose changes" mode. When on, commits land on a working branch
   * ({@link workingBranch}) instead of the selected base branch, and saving
   * opens (or reuses) a Pull Request back to the base. Off by default, so the
   * straight-to-branch behaviour is unchanged until the user opts in.
   */
  private proposeChanges = false;
  /** Set once the working branch is known to exist (created or already there). */
  private workingBranchEnsured = false;
  /** In-flight ensure, so concurrent saves don't each try to create the branch. */
  private ensurePromise: Promise<void> | null = null;
  /** In-flight probe for a pre-existing working branch, cached per session. */
  private probePromise: Promise<void> | null = null;
  /** Cached open-PR URL, so we only create/look it up once per session. */
  private prUrl: string | null = null;

  constructor(cfg: GitHubBackendConfig) {
    this.cfg = cfg;
    this.info = {
      kind: "github",
      label: "GitHub",
      detail: `${cfg.owner}/${cfg.repo}@${cfg.branch}`,
      authorLabel: cfg.login,
    };
  }

  /** Stable per-user working branch for this repo, e.g. `margins/octocat/main`. */
  private get workingBranch(): string {
    return `margins/${branchSafe(this.cfg.login)}/${branchSafe(this.cfg.branch)}`;
  }

  /**
   * The branch every read/write targets right now. In propose-changes mode this
   * is the working branch *once it exists* — until the first write creates it,
   * reads still come from the base branch (where the content is identical), so
   * we never address a branch that isn't there.
   */
  private get ref(): string {
    return this.proposeChanges && this.workingBranchEnsured
      ? this.workingBranch
      : this.cfg.branch;
  }

  /** Turn propose-changes mode on or off for this session. */
  setProposeChanges(enabled: boolean): void {
    this.proposeChanges = enabled;
  }

  /** Whether propose-changes mode is currently on. */
  get isProposingChanges(): boolean {
    return this.proposeChanges;
  }

  /** The open PR's URL once one has been created/found, else null. */
  pullRequestUrl(): string | null {
    return this.proposeChanges ? this.prUrl : null;
  }

  /**
   * Ensure the working branch exists before a write lands on it. Creates it off
   * the current base-branch head; a 422 means it already exists (reuse it). A
   * no-op outside propose-changes mode and after the branch is known to exist.
   */
  private ensureWorkingBranch(): Promise<void> {
    if (!this.proposeChanges || this.workingBranchEnsured) {
      return Promise.resolve();
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.createWorkingBranch().then(
        () => {
          this.workingBranchEnsured = true;
        },
        (err) => {
          // Let the next write retry instead of wedging on a transient failure.
          this.ensurePromise = null;
          throw err;
        },
      );
    }
    return this.ensurePromise;
  }

  private async createWorkingBranch(): Promise<void> {
    const { owner, repo, branch } = this.cfg;
    const refRes = await githubFetch(
      `${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers: this.headers() },
    );
    if (!refRes.ok) {
      throw new Error(`GitHub base ref read failed (${refRes.status})`);
    }
    const refJson = (await refRes.json()) as { object?: { sha?: string } };
    const sha = refJson.object?.sha;
    if (!sha) throw new Error("GitHub base ref had no commit sha");

    const createRes = await githubFetch(
      `${API}/repos/${owner}/${repo}/git/refs`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          ref: `refs/heads/${this.workingBranch}`,
          sha,
        }),
      },
    );
    // 422 == the ref already exists; reuse it rather than erroring.
    if (createRes.ok || createRes.status === 422) return;
    throw new Error(
      `GitHub working branch create failed (${createRes.status})`,
    );
  }

  /**
   * In propose-changes mode, detect a working branch left over from a previous
   * session and adopt it up front. The branch name is stable per user+base, so
   * it may already carry commits and an open PR. Without this, reads come from
   * the base branch until the first write flips {@link workingBranchEnsured} —
   * which both hides the user's own proposed changes in the editor and makes
   * the first save PUT a base-branch sha against a diverged working branch,
   * producing a spurious {@link MarkdownFileConflictError}. Adopting the branch
   * first means reads and the first save both use its real sha.
   *
   * A no-op in direct mode or once the branch is known. On 404 (not created
   * yet) we leave it to the create-on-demand write path. Cached per session and
   * best-effort: a failed probe is swallowed so a read never fails because of
   * it, and reset so a later call can retry (falling back to create-on-demand).
   */
  private probeWorkingBranch(): Promise<void> {
    if (!this.proposeChanges || this.workingBranchEnsured) {
      return Promise.resolve();
    }
    if (!this.probePromise) {
      this.probePromise = this.adoptExistingWorkingBranch().then(
        undefined,
        () => {
          this.probePromise = null;
        },
      );
    }
    return this.probePromise;
  }

  private async adoptExistingWorkingBranch(): Promise<void> {
    const { owner, repo } = this.cfg;
    const res = await githubFetch(
      `${API}/repos/${owner}/${repo}/git/ref/heads/${this.workingBranch}`,
      { headers: this.headers() },
    );
    // 200 → the branch is already there; adopt it so `this.ref` resolves to it
    // for reads and the first save. 404 → not created yet; leave it be.
    if (res.ok) this.workingBranchEnsured = true;
  }

  /**
   * Make sure an open PR exists from the working branch back to the base, and
   * cache its URL. Best-effort: the commit has already landed, so a PR failure
   * is logged rather than thrown (it would otherwise fail an otherwise-good
   * save). A 422 means a PR is already open — look it up and reuse it.
   */
  private async ensurePullRequest(): Promise<void> {
    if (!this.proposeChanges || this.prUrl) return;
    const { owner, repo, branch, login } = this.cfg;
    try {
      const res = await githubFetch(`${API}/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          title: `margins: changes from ${login}`,
          head: this.workingBranch,
          base: branch,
          body: "Proposed from [margins](https://github.com/recodelabs/margins).",
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { html_url?: string };
        if (json.html_url) this.prUrl = json.html_url;
        return;
      }
      if (res.status === 422) {
        this.prUrl = await this.findOpenPullRequest();
        return;
      }
      throw new Error(`GitHub pull request failed (${res.status})`);
    } catch (error) {
      console.error("Could not open pull request:", error);
    }
  }

  private async findOpenPullRequest(): Promise<string | null> {
    const { owner, repo, branch } = this.cfg;
    const url =
      `${API}/repos/${owner}/${repo}/pulls` +
      `?head=${owner}:${this.workingBranch}&base=${branch}&state=open`;
    const res = await githubFetch(url, { headers: this.headers() });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ html_url?: string }>;
    return list[0]?.html_url ?? null;
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: "application/vnd.github+json",
      ...extra,
    };
  }

  private contentsUrl(relativePath: string, ref?: string): string {
    const { owner, repo } = this.cfg;
    return `${API}/repos/${owner}/${repo}/contents/${relativePath}?ref=${ref ?? this.ref}`;
  }

  private async readFile(relativePath: string): Promise<Page> {
    return githubGet(
      this.contentsUrl(relativePath),
      this.headers(),
      async (res) => {
        if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
        const json = (await res.json()) as {
          sha: string;
          content: string;
          encoding?: string;
          size?: number;
        };
        // The Contents API only returns inline content for files up to 1 MB. For
        // larger files it responds with `encoding: "none"` and an empty `content`,
        // which would otherwise decode to "" and silently open an empty editor —
        // and a later autosave would overwrite the real file with emptiness.
        if (
          json.encoding === "none" ||
          (json.content === "" && (json.size ?? 0) > 0)
        ) {
          throw new FileTooLargeError(relativePath, json.size);
        }
        const content = decodeBase64(json.content);
        return {
          id: pageId(relativePath),
          title: titleFromContent(
            content,
            relativePath.split("/").at(-1) || relativePath,
          ),
          content,
          version: json.sha,
        };
      },
    );
  }

  async getMarkdownFile(relativePath: string): Promise<Page> {
    if (!isSupportedPath(relativePath)) {
      throw new Error("This file type can't be opened in margins");
    }
    // Adopt any pre-existing working branch so the returned version is the
    // working branch's sha — otherwise the first save would PUT a base-branch
    // sha against a diverged branch and spuriously conflict.
    await this.probeWorkingBranch();
    return this.readFile(relativePath);
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page> {
    if (!isSupportedPath(relativePath)) {
      throw new Error("This file type can't be opened in margins");
    }
    // In propose-changes mode this creates the working branch (if needed) so the
    // commit below lands there and `this.ref` resolves to it.
    await this.ensureWorkingBranch();
    const { owner, repo } = this.cfg;
    const res = await githubFetch(
      `${API}/repos/${owner}/${repo}/contents/${relativePath}`,
      {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: `Update ${relativePath}`,
          content: encodeBase64(content),
          sha: expectedVersion,
          branch: this.ref,
        }),
      },
    );
    if (res.status === 409 || res.status === 422) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      // 422 is also used for plain validation errors — only a SHA mismatch is a real conflict.
      if (res.status === 422 && !errBody.message?.includes("but expected")) {
        throw new Error(
          `GitHub save failed (422): ${errBody.message ?? "validation error"}`,
        );
      }
      let current: Page;
      try {
        current = await this.readFile(relativePath);
      } catch {
        throw new Error(
          `GitHub conflict detected but the current file could not be re-read (${res.status})`,
        );
      }
      throw new MarkdownFileConflictError(current);
    }
    if (!res.ok) throw new Error(`GitHub save failed (${res.status})`);
    const json = (await res.json()) as { content: { sha: string } };
    // The file changed on the server — drop any cached read so the next open
    // re-fetches (and re-conditionalises) instead of serving stale content.
    invalidateCachedUrl(this.contentsUrl(relativePath));
    // The working branch now has a commit ahead of base — open (or reuse) a PR.
    await this.ensurePullRequest();
    return {
      id: pageId(relativePath),
      title: titleFromContent(
        content,
        relativePath.split("/").at(-1) || relativePath,
      ),
      content,
      version: json.content.sha,
    };
  }

  async createMarkdownFile(
    relativePath: string,
    content: string,
  ): Promise<Page> {
    if (!isSupportedPath(relativePath)) {
      throw new Error("This file type can't be created in margins");
    }
    await this.ensureWorkingBranch();
    const { owner, repo } = this.cfg;
    const res = await githubFetch(
      `${API}/repos/${owner}/${repo}/contents/${relativePath}`,
      {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: `Create ${relativePath}`,
          content: encodeBase64(content),
          branch: this.ref,
        }),
      },
    );
    // A no-sha PUT to an existing path 422s with a message about the missing
    // sha — surface that as a friendly collision error. Other 422s are real
    // validation failures, so pass GitHub's message through instead of
    // mislabeling them as collisions (mirrors saveMarkdownFile's 422 handling).
    if (res.status === 422) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      const msg = errBody.message ?? "";
      if (/sha.*supplied|already exists/i.test(msg)) {
        throw new Error(`A file named "${relativePath}" already exists`);
      }
      throw new Error(
        `GitHub create failed (422): ${msg || "validation error"}`,
      );
    }
    if (!res.ok) throw new Error(`GitHub create failed (${res.status})`);
    const json = (await res.json()) as { content: { sha: string } };
    invalidateCachedUrl(this.contentsUrl(relativePath));
    await this.ensurePullRequest();
    return {
      id: pageId(relativePath),
      title: titleFromContent(
        content,
        relativePath.split("/").at(-1) || relativePath,
      ),
      content,
      version: json.content.sha,
    };
  }

  private async readActivityRaw(
    path: string,
  ): Promise<{ text: string; sha: string } | null> {
    const res = await githubFetch(this.contentsUrl(path), {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub activity read failed (${res.status})`);
    const json = (await res.json()) as {
      sha: string;
      content: string;
      encoding?: string;
      size?: number;
    };
    // The Contents API only inlines content for files ≤1 MB. For larger files it
    // returns encoding:"none" with empty content but a real sha — decoding that
    // would produce "" and a subsequent PUT would overwrite the entire history.
    if (
      json.encoding === "none" ||
      (json.content === "" && (json.size ?? 0) > 0)
    ) {
      throw new FileTooLargeError(path, json.size);
    }
    return { text: decodeBase64(json.content), sha: json.sha };
  }

  async readActivityLog(docPath: string): Promise<ActivityEntry[]> {
    await this.probeWorkingBranch();
    const raw = await this.readActivityRaw(activityLogPath(docPath));
    return raw ? parseActivityLog(raw.text) : [];
  }

  watchActivityLog(
    docPath: string,
    onChange: (entries: ActivityEntry[]) => void,
  ): () => void {
    let disposed = false;
    let lastSig: string | null = null;
    // Guard against poll pile-up: if a tick runs slow (or hangs), the interval
    // keeps firing. Without this, successive ticks would stack unbounded
    // concurrent requests against the same doc. Skip a tick while one is still
    // outstanding so at most one activity request is in flight at a time.
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const entries = await this.readActivityLog(docPath);
        if (disposed) return;
        const sig = serializeForChangeCheck(entries);
        if (sig !== lastSig) {
          lastSig = sig;
          onChange(entries);
        }
      } catch (error) {
        console.error("activity-log poll failed:", error);
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, ACTIVITY_POLL_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }

  commitUrl(sha: string): string {
    const { owner, repo } = this.cfg;
    return `https://github.com/${owner}/${repo}/commit/${sha}`;
  }

  async appendActivityEntry(
    docPath: string,
    entry: ActivityEntry,
  ): Promise<void> {
    // Settle on one branch up front so the read-sha and the write target match.
    await this.ensureWorkingBranch();
    const { owner, repo } = this.cfg;
    const path = activityLogPath(docPath);

    // GET the current sha then PUT with it. If another writer appended in
    // between, GitHub 422s on the stale sha — re-read and retry once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.readActivityRaw(path);
      const nextText = appendActivityLine(existing?.text ?? "", entry);
      const res = await githubFetch(
        `${API}/repos/${owner}/${repo}/contents/${path}`,
        {
          method: "PUT",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            message: `chore(margins): activity (${entry.role}) on ${docPath}`,
            content: encodeBase64(nextText),
            sha: existing?.sha,
            branch: this.ref,
          }),
        },
      );
      if (res.ok) {
        invalidateCachedUrl(this.contentsUrl(path));
        return;
      }
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      const isStaleSha =
        res.status === 422 && (errBody.message ?? "").includes("but expected");
      if (isStaleSha && attempt === 0) continue;
      throw new Error(
        `GitHub activity append failed (${res.status}): ${errBody.message ?? "error"}`,
      );
    }
  }

  async listMarkdownPaths(): Promise<FileMeta[]> {
    await this.probeWorkingBranch();
    const { owner, repo } = this.cfg;
    const url = `${API}/repos/${owner}/${repo}/git/trees/${this.ref}?recursive=1`;
    return githubGet(url, this.headers(), async (res) => {
      if (!res.ok) throw new Error(`GitHub tree failed (${res.status})`);
      const json = (await res.json()) as {
        tree: Array<{ path: string; type: string; size?: number }>;
        truncated?: boolean;
      };
      if (json.truncated) {
        throw new Error(
          "GitHub tree listing was truncated (repo too large to list recursively)",
        );
      }
      return json.tree
        .filter((e) => e.type === "blob" && isSupportedPath(e.path))
        .map((e) => ({ path: e.path, size: e.size ?? 0 }));
    });
  }

  /**
   * Last-commit metadata (date + author) for a set of paths, fetched in a
   * single GraphQL call. Used by the file list to show "last modified … by …".
   * Paths with no commit history (shouldn't normally happen for tracked files)
   * are simply absent from the returned map. Returns an empty map — with no
   * network call — for an empty input.
   *
   * The query aliases one `history(first: 1, path: …)` per file off the branch
   * head commit, so it's one round-trip per folder view regardless of count.
   */
  async listPathCommitInfo(
    paths: string[],
  ): Promise<Map<string, FileCommitInfo>> {
    const result = new Map<string, FileCommitInfo>();
    if (paths.length === 0) return result;

    await this.probeWorkingBranch();
    const { owner, repo } = this.cfg;
    const ref = this.ref;
    const fields = paths
      .map(
        (path, i) =>
          `f${i}: object(expression: ${JSON.stringify(ref)}) { ` +
          `... on Commit { history(first: 1, path: ${JSON.stringify(path)}) { ` +
          `nodes { committedDate author { name user { login } } } } } }`,
      )
      .join("\n");
    const query = `query { repository(owner: ${JSON.stringify(
      owner,
    )}, name: ${JSON.stringify(repo)}) {\n${fields}\n} }`;

    const res = await githubFetch(`${API}/graphql`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(`GitHub commit info failed (${res.status})`);
    }
    const json = (await res.json()) as {
      data?: {
        repository?: Record<
          string,
          {
            history?: {
              nodes?: Array<{
                committedDate: string;
                author?: {
                  name?: string;
                  user?: { login?: string } | null;
                } | null;
              }>;
            };
          } | null
        >;
      };
    };

    const repository = json.data?.repository;
    if (!repository) return result;

    paths.forEach((path, i) => {
      const node = repository[`f${i}`]?.history?.nodes?.[0];
      if (!node) return;
      result.set(path, {
        date: node.committedDate,
        authorName: node.author?.name ?? "",
        authorLogin: node.author?.user?.login ?? null,
      });
    });

    return result;
  }

  /**
   * Recent commits touching `relativePath`, newest first — drives the file
   * history view. One GraphQL round-trip walks the branch head's commit history
   * filtered to the path, mirroring {@link listPathCommitInfo}.
   */
  async listFileHistory(
    relativePath: string,
    limit = 20,
  ): Promise<FileCommit[]> {
    // Adopt any pre-existing working branch and query `this.ref` (like
    // listPathCommitInfo) so the user's own working-branch commits show up in
    // history instead of only the base branch's.
    await this.probeWorkingBranch();
    const { owner, repo } = this.cfg;
    const ref = this.ref;
    const query =
      `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ` +
      `object(expression: ${JSON.stringify(ref)}) { ... on Commit { ` +
      `history(first: ${limit}, path: ${JSON.stringify(relativePath)}) { ` +
      `nodes { oid messageHeadline committedDate author { name user { login } } } } } } } }`;

    const res = await githubFetch(`${API}/graphql`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(`GitHub file history failed (${res.status})`);
    }
    const json = (await res.json()) as {
      data?: {
        repository?: {
          object?: {
            history?: {
              nodes?: Array<{
                oid: string;
                messageHeadline?: string;
                committedDate: string;
                author?: {
                  name?: string;
                  user?: { login?: string } | null;
                } | null;
              }>;
            };
          } | null;
        } | null;
      };
    };

    const nodes = json.data?.repository?.object?.history?.nodes ?? [];
    return nodes.map((node) => ({
      sha: node.oid,
      message: node.messageHeadline ?? "",
      date: node.committedDate,
      authorName: node.author?.name ?? "",
      authorLogin: node.author?.user?.login ?? null,
    }));
  }

  /** Read a file's decoded content at a specific commit/ref. */
  async readFileAtRef(relativePath: string, ref: string): Promise<string> {
    return githubGet(
      this.contentsUrl(relativePath, ref),
      this.headers(),
      async (res) => {
        if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
        const json = (await res.json()) as {
          content: string;
          encoding?: string;
          size?: number;
        };
        if (
          json.encoding === "none" ||
          (json.content === "" && (json.size ?? 0) > 0)
        ) {
          throw new FileTooLargeError(relativePath, json.size);
        }
        return decodeBase64(json.content);
      },
    );
  }

  /**
   * Commits a pasted/dropped file into the repo under `assets/` and returns a
   * reference to insert into the document. The path is content-addressed
   * (`assets/<name>-<hash8>.<ext>`), so re-uploading identical bytes reuses the
   * existing blob instead of committing a duplicate.
   *
   * Uses the Contents API, which inlines the body as base64 — fine for typical
   * pasted images. Files over ~1 MB need the Git Data (blob) API and are out of
   * scope here (tracked by the large-file issue); GitHub's rejection surfaces as
   * a clear error.
   */
  async saveAsset(file: File): Promise<StoredAsset> {
    // In propose-changes mode, create/adopt the working branch first so both
    // the dedupe existence-check read and the commit below target it — a pasted
    // image must land on the PR branch, not silently on the base branch. A
    // no-op in direct mode, where `this.ref` stays the base branch.
    await this.ensureWorkingBranch();
    const { owner, repo } = this.cfg;
    const mimeType = file.type || "application/octet-stream";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = assetPath(file.name, await sha256Hex(bytes));

    const reference: StoredAsset = {
      markdownPath: path,
      previewUrl: this.resolveFileUrl(path) ?? path,
      mimeType,
    };

    // Same content hash → same path: if it's already committed, reuse it.
    const existing = await githubFetch(this.contentsUrl(path), {
      headers: this.headers(),
    });
    if (existing.ok) return reference;
    if (existing.status !== 404) {
      throw new Error(`GitHub asset check failed (${existing.status})`);
    }

    const res = await githubFetch(
      `${API}/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: `chore(margins): add asset ${path}`,
          content: encodeBase64Bytes(bytes),
          branch: this.ref,
        }),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub asset upload failed (${res.status}): ${errBody.message ?? "error"}`,
      );
    }
    invalidateCachedUrl(this.contentsUrl(path));
    return reference;
  }

  resolveFileUrl(path: string): string | null {
    const { owner, repo } = this.cfg;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${this.ref}/${path}`;
  }

  /**
   * Fetch an asset's bytes via the authenticated API and return a `data:` URL.
   * Used to render images in **private** repos, whose `raw.githubusercontent.com`
   * URLs 404 in an `<img>` tag (no auth header). The Contents API inlines the
   * base64 body for files up to 1 MB; larger files fall back to the Git blob
   * API (addressed by the sha the Contents response still returns).
   */
  async readAssetDataUrl(path: string): Promise<string | null> {
    try {
      const res = await githubFetch(this.contentsUrl(path), {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        content?: string;
        encoding?: string;
        sha?: string;
      };
      const mime = mimeFromPath(path);
      let base64 = json.encoding === "base64" ? (json.content ?? "") : "";
      // Contents API returns empty content for files >1 MB; fetch the blob.
      if (!base64 && json.sha) {
        const blobRes = await githubFetch(
          `${API}/repos/${this.cfg.owner}/${this.cfg.repo}/git/blobs/${json.sha}`,
          { headers: this.headers() },
        );
        if (!blobRes.ok) return null;
        const blob = (await blobRes.json()) as {
          content?: string;
          encoding?: string;
        };
        base64 = blob.encoding === "base64" ? (blob.content ?? "") : "";
      }
      if (!base64) return null;
      return `data:${mime};base64,${base64.replace(/\s/g, "")}`;
    } catch {
      return null;
    }
  }

  async openProject(_path: string): Promise<void> {
    // no-op: repo/branch are fixed at construction
  }

  /**
   * Whether the signed-in user has push (write) access to the repo, read from
   * `GET /repos/{owner}/{repo}`'s `permissions.push`. Returns false on any error
   * (fail safe: hide edit controls rather than offer a commit that 403s).
   */
  async getRepoPermission(): Promise<boolean> {
    const { owner, repo } = this.cfg;
    try {
      const res = await fetch(`${API}/repos/${owner}/${repo}`, {
        headers: this.headers(),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { permissions?: { push?: boolean } };
      return json.permissions?.push === true;
    } catch {
      return false;
    }
  }

  /**
   * Logins that can be @mentioned in comments. Prefers the repo's collaborators
   * (the people with explicit access), but that endpoint needs push access, so
   * we fall back to public contributors when it's forbidden — read-only and
   * guest viewers still get useful suggestions. One page of 100 is plenty for an
   * autocomplete menu. Returns [] on any failure so the composer degrades to a
   * plain textarea rather than throwing.
   */
  async listCollaborators(): Promise<string[]> {
    const { owner, repo } = this.cfg;
    const base = `${API}/repos/${owner}/${repo}`;
    try {
      const collaborators = await fetch(`${base}/collaborators?per_page=100`, {
        headers: this.headers(),
      });
      if (collaborators.ok) {
        return loginsFromUserList(await collaborators.json());
      }

      const contributors = await fetch(`${base}/contributors?per_page=100`, {
        headers: this.headers(),
      });
      if (contributors.ok) {
        return loginsFromUserList(await contributors.json());
      }

      return [];
    } catch {
      return [];
    }
  }
}

/** Extracts unique, non-empty `login` strings from a GitHub user-list payload. */
function loginsFromUserList(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  const logins = body
    .map((entry) =>
      entry && typeof (entry as { login?: unknown }).login === "string"
        ? (entry as { login: string }).login
        : null,
    )
    .filter((login): login is string => Boolean(login));
  return [...new Set(logins)];
}
