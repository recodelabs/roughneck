import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "./components/ui/autocomplete";
import { Button } from "./components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "./components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { formatFileSize, formatRelativeTime } from "./format";
import { clearToken, getStoredToken, login } from "./github-auth";
import { type FileCommitInfo, GitHubBackend } from "./github-backend";
import {
  listAccessibleRepos,
  listBranches,
  type RepoOption,
} from "./github-repos";
import {
  gitHubHref,
  isMarkdownPath,
  isSupportedPath,
  navigate,
  parseGitHubLocation,
} from "./github-route";
import { type FileMeta, getFolderContents, splitPath } from "./github-tree";
import { cn } from "./lib/utils";
import { validateNewFileName } from "./new-file-name";
import { handleSessionExpiry, takeSignedOutReason } from "./session-expiry";

// ---------------------------------------------------------------------------
// GitHub mark SVG (inline, no external dependency)
// ---------------------------------------------------------------------------
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="currentColor"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared logo treatment
// ---------------------------------------------------------------------------
function MarginsLogo() {
  return (
    <p className="font-nanum-pen-script text-[clamp(2.75rem,2.2rem+1.4vw,3.5rem)] leading-none text-[#1d4ed8] dark:text-[#8aa9ff]">
      margins
    </p>
  );
}

// ---------------------------------------------------------------------------
// Login screen (no token stored)
// ---------------------------------------------------------------------------
function LoginScreen() {
  // Read once: if we were booted out by an expired session, explain why. The
  // reason is consumed (cleared) on read so it doesn't persist across reloads.
  const [signedOutReason] = useState(takeSignedOutReason);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#FCFCFC] dark:bg-background px-6 py-12 text-center text-slate-950 dark:text-slate-50">
      <div className="flex w-full max-w-xl flex-col items-center">
        <img
          src="/margins.svg"
          alt="margins"
          className="w-[clamp(16rem,52vw,28rem)] select-none dark:invert"
          draggable={false}
        />
        <h1 className="font-nanum-pen-script mt-6 text-[clamp(3.25rem,2.6rem+3vw,5rem)] leading-[0.95] text-[#1d4ed8] dark:text-[#8aa9ff]">
          Collaborate with your AI in markdown
        </h1>
        <p className="mt-5 max-w-md text-[clamp(1.05rem,1rem+0.3vw,1.2rem)] leading-relaxed text-slate-600 dark:text-slate-400">
          View, edit and annotate any{" "}
          <span className="rounded-sm bg-[#fff5c7] px-1 font-medium text-slate-950 dark:bg-amber-500/35 dark:text-slate-50">
            .md file
          </span>{" "}
          in GitHub to collaborate with your AI.
        </p>
        {signedOutReason === "expired" && (
          <p
            role="status"
            className="mt-6 rounded-lg bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
          >
            Your session expired. Please sign in again.
          </p>
        )}
        <Button
          className="mt-9 h-14 cursor-pointer gap-2.5 rounded-xl px-7 text-lg shadow-[0_12px_32px_rgba(0,0,0,0.16)] transition-transform hover:-translate-y-0.5"
          size="lg"
          onClick={login}
        >
          <GitHubMark className="size-5" />
          Continue with GitHub
        </Button>
        <p className="mt-6 max-w-md text-sm leading-relaxed text-stone-500 dark:text-stone-400">
          First time?{" "}
          <a
            href="https://github.com/apps/margins-md"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-slate-700 underline decoration-stone-300 underline-offset-2 hover:text-slate-900 dark:text-slate-300 dark:decoration-stone-600 dark:hover:text-slate-100"
          >
            Install the margins app
          </a>{" "}
          on the repos you want to review — pick your account, choose
          repositories, then come back and sign in.
        </p>
        <p className="mt-8 text-xs font-medium tracking-wide text-stone-400 dark:text-stone-500">
          Free &amp; open source · your edits commit straight to GitHub ·{" "}
          <a
            href="https://github.com/recodelabs/roughneck"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-stone-300 underline-offset-2 hover:text-slate-700 dark:decoration-stone-600 dark:hover:text-slate-300"
          >
            GitHub
          </a>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo browser (token present)
// ---------------------------------------------------------------------------

/** Read the current folder from the path-based URL. */
function getDirFromUrl(): string {
  const loc = parseGitHubLocation();
  // If the path looks like an openable file (shouldn't happen in picker mode,
  // but guard anyway), treat the parent as the current folder.
  if (isSupportedPath(loc.path)) {
    const lastSlash = loc.path.lastIndexOf("/");
    return lastSlash >= 0 ? loc.path.slice(0, lastSlash) : "";
  }
  return loc.path;
}

/** Wait this long after the last keystroke before fetching the repo tree. */
const TREE_FETCH_DEBOUNCE_MS = 300;

export function GitHubPicker() {
  const token = getStoredToken();
  const initialLoc = parseGitHubLocation();

  const logout = () => {
    clearToken();
    window.location.assign("/");
  };

  const [repo, setRepo] = useState(
    initialLoc.owner && initialLoc.repo
      ? `${initialLoc.owner}/${initialLoc.repo}`
      : "",
  );
  const [ref, setRef] = useState(initialLoc.branch || "main");
  const [currentDir, setCurrentDir] = useState(() => getDirFromUrl());
  const [allPaths, setAllPaths] = useState<FileMeta[] | null>(null);
  // Last-commit metadata (date + author) per file path, fetched lazily for the
  // current folder. Keyed by full path; absent until the folder's batch lands.
  const [commitInfo, setCommitInfo] = useState<Map<string, FileCommitInfo>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState("untitled.md");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Repos the GitHub App has been granted access to, and the branches of the
  // currently-typed repo. Both power searchable dropdowns; both fail soft so
  // the fields keep working as free-text inputs if the API call errors.
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);

  // Map of full name -> default branch, so picking a repo can preselect its
  // default branch instead of a hard-coded "main".
  const repoDefaultBranch = useMemo(
    () => new Map(repoOptions.map((o) => [o.fullName, o.defaultBranch])),
    [repoOptions],
  );

  // Branch pulldown contents: the repo's default branch first (the one people
  // reach for most), then the rest as GitHub returned them. The branch in the
  // URL is included even if it's missing from the list, so a hand-typed or
  // since-deleted ref still shows as the selected item.
  const branchItems = useMemo(() => {
    if (branchOptions.length === 0) return [];
    const def = repoDefaultBranch.get(repo);
    const ordered = [
      ...(def && branchOptions.includes(def) ? [def] : []),
      ...branchOptions.filter((b) => b !== def),
    ];
    return ordered.includes(ref) ? ordered : [ref, ...ordered];
  }, [branchOptions, repoDefaultBranch, repo, ref]);

  // Show the pulldown as soon as branches are on their way, so switching repos
  // doesn't swap the control out for the free-text fallback and back again.
  const showBranchPulldown = branchItems.length > 0 || branchesLoading;

  // Fetch the repos the user can access through the App's installations, once
  // per token. Failure is non-fatal: the repo field stays free-text.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    listAccessibleRepos(token)
      .then((repos) => {
        if (!cancelled) setRepoOptions(repos);
      })
      .catch(() => {
        /* fail soft — keep manual entry */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Fetch branches for the typed repo (debounced/abortable like the tree fetch).
  useEffect(() => {
    const [owner, name] = repo.split("/");
    if (!token || !owner || !name) {
      setBranchOptions([]);
      setBranchesLoading(false);
      return;
    }
    let cancelled = false;
    // Drop the previous repo's branches straight away — showing them under a
    // new repo would offer branches that don't exist there.
    setBranchOptions([]);
    setBranchesLoading(true);
    const timer = window.setTimeout(() => {
      listBranches(token, owner, name)
        .then((b) => {
          if (!cancelled) setBranchOptions(b);
        })
        .catch(() => {
          if (!cancelled) setBranchOptions([]); // fail soft
        })
        .finally(() => {
          if (!cancelled) setBranchesLoading(false);
        });
    }, TREE_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [token, repo]);

  // Repo changed via the input/dropdown: reset the browsed dir, and if the
  // chosen repo is a known one, preselect its default branch.
  const onRepoChange = (value: string) => {
    setRepo(value);
    setCurrentDir("");
    const def = repoDefaultBranch.get(value);
    if (def) setRef(def);
  };

  // Listen for browser Back/Forward so path-based dir stays in sync
  useEffect(() => {
    const onPopState = () => {
      setCurrentDir(getDirFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Fetch the flat path list whenever token+repo+ref changes. Debounced so
  // typing `owner/repo` (or a branch) fires a single recursive tree request
  // after the user pauses, not one per keystroke.
  const fetchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const [owner, name] = repo.split("/");
    if (!token || !owner || !name) {
      setAllPaths(null);
      setError(null);
      return;
    }

    const timer = window.setTimeout(() => {
      fetchAbortRef.current?.abort();
      const abortCtrl = new AbortController();
      fetchAbortRef.current = abortCtrl;

      setLoading(true);
      setError(null);
      setAllPaths(null);
      // Drop any commit metadata from the previous repo/branch.
      setCommitInfo(new Map());

      const backend = new GitHubBackend({
        token,
        owner,
        repo: name,
        branch: ref,
        login: "",
      });
      backend
        .listMarkdownPaths()
        .then((p) => {
          if (abortCtrl.signal.aborted) return;
          setAllPaths(p);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (abortCtrl.signal.aborted) return;
          if (handleSessionExpiry(e)) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    }, TREE_FETCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      fetchAbortRef.current?.abort();
    };
  }, [token, repo, ref]);

  // Compute folder contents for the current view (folders + files at this dir).
  const entries = useMemo(
    () => (allPaths ? getFolderContents(allPaths, currentDir) : []),
    [allPaths, currentDir],
  );

  // Fetch last-commit metadata (date + author) for the files in the current
  // folder — one batched GraphQL call per folder view. Failures are non-fatal:
  // the list still works, it just won't show "modified … by …".
  useEffect(() => {
    const [owner, name] = repo.split("/");
    if (!token || !owner || !name || !allPaths) return;

    const filePaths = entries
      .filter(
        (e): e is Extract<typeof e, { kind: "file" }> => e.kind === "file",
      )
      .map((e) => e.path);
    if (filePaths.length === 0) return;

    let cancelled = false;
    const backend = new GitHubBackend({
      token,
      owner,
      repo: name,
      branch: ref,
      login: "",
    });
    backend
      .listPathCommitInfo(filePaths)
      .then((info) => {
        if (cancelled || info.size === 0) return;
        setCommitInfo((prev) => {
          const next = new Map(prev);
          for (const [path, value] of info) next.set(path, value);
          return next;
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        handleSessionExpiry(e);
      });

    return () => {
      cancelled = true;
    };
  }, [token, repo, ref, entries, allPaths]);

  // Derive owner/name from the repo input field
  const [repoOwner, repoName] = repo.split("/");

  // Navigate into a subfolder — SPA pushState. The synthetic popstate from
  // navigate() drives the onPopState handler above, which re-reads currentDir
  // from the URL, so we keep a single source of truth (the URL).
  const drillInto = (folderPath: string) => {
    navigate(
      gitHubHref({
        owner: repoOwner ?? "",
        repo: repoName ?? "",
        branch: ref,
        path: folderPath,
      }),
    );
  };

  // Navigate up one level
  const drillUp = () => {
    const parent = currentDir.includes("/")
      ? currentDir.slice(0, currentDir.lastIndexOf("/"))
      : "";
    drillInto(parent);
  };

  // Navigate to an arbitrary folder segment
  const drillTo = (folderPath: string) => {
    drillInto(folderPath);
  };

  // Open a file — SPA-navigate to the document workspace (no full reload).
  // App's popstate-driven location state swaps the picker for the workspace.
  const openFile = (filePath: string) => {
    navigate(
      gitHubHref({
        owner: repoOwner ?? "",
        repo: repoName ?? "",
        branch: ref,
        path: filePath,
      }),
    );
  };

  if (!token) {
    return <LoginScreen />;
  }

  // Compute breadcrumb segments for the current dir
  const breadcrumbSegments = splitPath(currentDir);

  // Reference time for relative "… ago" labels in the file list.
  const now = new Date();

  const existingFileNames = entries
    .filter((e) => e.kind === "file")
    .map((e) => e.name);
  const nameCheck = validateNewFileName(newFileName, existingFileNames);

  const openNewFileDialog = () => {
    setNewFileName("untitled.md");
    setCreateError(null);
    setShowNewFile(true);
  };

  const handleCreateFile = async () => {
    const check = validateNewFileName(newFileName, existingFileNames);
    if (!check.ok) {
      setCreateError(check.error);
      return;
    }
    const [owner, name] = repo.split("/");
    if (!token || !owner || !name) return;
    setCreating(true);
    setCreateError(null);
    const backend = new GitHubBackend({
      token,
      owner,
      repo: name,
      branch: ref,
      login: "",
    });
    const newPath = currentDir
      ? `${currentDir}/${newFileName.trim()}`
      : newFileName.trim();
    // Seed markdown with a heading; other types start empty so the file stays
    // valid (e.g. a "# Untitled" line would be invalid JSON).
    const initialContent = isMarkdownPath(newPath) ? "# Untitled\n" : "";
    try {
      await backend.createMarkdownFile(newPath, initialContent);
      setCreating(false);
      setShowNewFile(false);
      openFile(newPath);
    } catch (e) {
      if (handleSessionExpiry(e)) return;
      setCreating(false);
      setCreateError(e instanceof Error ? e.message : String(e));
    }
  };

  const owner = repoOwner ?? "";
  const displayRepoName = repoName ?? repo;

  return (
    <div className="flex min-h-screen flex-col bg-[#FCFCFC] dark:bg-background px-6 pt-8 pb-12 text-slate-950 dark:text-slate-50">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex items-center justify-between">
          <MarginsLogo />
          <button
            type="button"
            onClick={logout}
            className="text-xs font-medium text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-slate-900 dark:text-stone-400 dark:decoration-stone-600 dark:hover:text-slate-100"
          >
            Sign out
          </button>
        </div>

        {/* Repo + branch inputs */}
        <div className="mt-8 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gh-repo-input"
              className="text-xs font-medium text-stone-500 dark:text-stone-400"
            >
              Repository
            </label>
            <Autocomplete
              items={repoOptions.map((o) => o.fullName)}
              value={repo}
              onValueChange={onRepoChange}
            >
              <AutocompleteInput
                id="gh-repo-input"
                placeholder="owner/repo"
                className="w-64"
              />
              {repoOptions.length > 0 ? (
                <AutocompleteContent>
                  <AutocompleteEmpty>
                    No matching repositories
                  </AutocompleteEmpty>
                  <AutocompleteList>
                    {(item: string) => (
                      <AutocompleteItem key={item} value={item}>
                        {item}
                      </AutocompleteItem>
                    )}
                  </AutocompleteList>
                </AutocompleteContent>
              ) : null}
            </Autocomplete>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor={
                showBranchPulldown ? "gh-branch-trigger" : "gh-branch-input"
              }
              className="text-xs font-medium text-stone-500 dark:text-stone-400"
            >
              Branch
            </label>
            {/* With branches loaded this is a pulldown: the trigger shows the
                current branch and opening it lists every branch (searchable).
                If the branch list can't be loaded — API error, or no repo
                chosen yet — fall back to typing the ref by hand. */}
            {showBranchPulldown ? (
              <Combobox
                items={branchItems}
                value={ref}
                onValueChange={(value) => {
                  if (value) setRef(value);
                }}
              >
                <ComboboxTrigger id="gh-branch-trigger" className="w-44">
                  <ComboboxValue />
                </ComboboxTrigger>
                <ComboboxContent>
                  <ComboboxInput placeholder="Find a branch…" />
                  <ComboboxEmpty>
                    {branchesLoading
                      ? "Loading branches…"
                      : "No matching branches"}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(item: string) => (
                      <ComboboxItem key={item} value={item}>
                        {item}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            ) : (
              <input
                id="gh-branch-input"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="main"
                className="h-10 w-44 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm text-slate-950 dark:text-slate-50 outline-none focus:ring-2 focus:ring-slate-300/70 dark:focus:ring-slate-600/70 placeholder:text-stone-400"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
              />
            )}
          </div>
        </div>

        {/* Error state */}
        {error ? (
          <p className="mt-4 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}

        {/* Repo browser */}
        {repo && repo.includes("/") ? (
          <div className="mt-6 w-full">
            {/* Repo header */}
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-950 dark:text-slate-50">
                {owner}
                <span className="text-stone-400 dark:text-stone-500">/</span>
                {displayRepoName}
              </span>
              <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[0.72rem] font-medium text-stone-500 dark:text-stone-400">
                {ref}
              </span>
              <button
                type="button"
                onClick={openNewFileDialog}
                disabled={loading || !allPaths}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                New file
              </button>
            </div>

            {/* Breadcrumb of current folder path */}
            {breadcrumbSegments.length > 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                <button
                  type="button"
                  className="cursor-pointer rounded px-1 py-0.5 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-slate-950 dark:hover:text-slate-50"
                  onClick={() => drillTo("")}
                >
                  {displayRepoName}
                </button>
                {breadcrumbSegments.map((seg, i) => (
                  <span key={seg.path} className="flex items-center gap-1">
                    <ChevronRight
                      className="size-3 text-stone-300 dark:text-stone-600"
                      aria-hidden="true"
                    />
                    {i === breadcrumbSegments.length - 1 ? (
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {seg.name}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="cursor-pointer rounded px-1 py-0.5 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-slate-950 dark:hover:text-slate-50"
                        onClick={() => drillTo(seg.path)}
                      >
                        {seg.name}
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Loading spinner */}
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-stone-400 dark:text-stone-500">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading files…
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                {/* Up row */}
                {currentDir ? (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-sm text-stone-500 dark:text-stone-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors border-b border-slate-100 dark:border-slate-800"
                    onClick={drillUp}
                  >
                    <ArrowLeft
                      className="size-4 shrink-0 text-stone-400 dark:text-stone-500"
                      aria-hidden="true"
                    />
                    <span>
                      Up to{" "}
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {breadcrumbSegments.length > 1
                          ? breadcrumbSegments[breadcrumbSegments.length - 2]
                              .name
                          : repoName}
                      </span>
                    </span>
                  </button>
                ) : null}

                {/* Folder + file rows */}
                {entries.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-stone-400 dark:text-stone-500">
                    No files here.
                  </div>
                ) : (
                  entries.map((entry, i) => {
                    const isLast = i === entries.length - 1;
                    if (entry.kind === "folder") {
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-sm text-slate-950 dark:text-slate-50 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors",
                            !isLast &&
                              "border-b border-slate-100 dark:border-slate-800",
                          )}
                          onClick={() => drillInto(entry.path)}
                        >
                          <Folder
                            className="size-4 shrink-0 text-stone-400 dark:text-stone-500"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate text-left font-medium">
                            {entry.name}
                          </span>
                          <ChevronRight
                            className="size-4 shrink-0 text-stone-300 dark:text-stone-600"
                            aria-hidden="true"
                          />
                        </button>
                      );
                    }
                    // file entry
                    const info = commitInfo.get(entry.path);
                    const author = info
                      ? (info.authorLogin ?? info.authorName)
                      : "";
                    // "12 KB · 3 days ago by octocat" — author/date appear once
                    // the per-folder commit batch resolves.
                    const metaParts = [formatFileSize(entry.size)];
                    if (info) {
                      const when = formatRelativeTime(info.date, now);
                      metaParts.push(author ? `${when} by ${author}` : when);
                    }
                    return (
                      <button
                        key={entry.path}
                        type="button"
                        className={cn(
                          "group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-sm text-slate-950 dark:text-slate-50 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors",
                          !isLast &&
                            "border-b border-slate-100 dark:border-slate-800",
                        )}
                        onClick={() => openFile(entry.path)}
                      >
                        <FileText
                          className="size-4 shrink-0 text-stone-400 dark:text-stone-500"
                          aria-hidden="true"
                        />
                        <span className="flex min-w-0 flex-1 flex-col text-left">
                          {/* Markdown is the primary content type — give .md
                              files a bolder, darker name so they stand out from
                              the supporting file types in the same list. */}
                          <span
                            className={cn(
                              "truncate",
                              isMarkdownPath(entry.name)
                                ? "font-semibold text-slate-900 dark:text-slate-100"
                                : "font-normal text-stone-600 dark:text-stone-300",
                            )}
                          >
                            {entry.name}
                          </span>
                          <span
                            className="truncate text-xs text-stone-400 dark:text-stone-500"
                            title={
                              info
                                ? new Date(info.date).toLocaleString()
                                : undefined
                            }
                          >
                            {metaParts.join(" · ")}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-stone-300 dark:text-stone-600 opacity-0 group-hover:opacity-100 transition-opacity">
                          Open
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <Dialog
        open={showNewFile}
        onOpenChange={(open) => {
          if (!open) setCreating(false);
          setShowNewFile(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="new-file-name-input"
              className="text-xs font-medium text-stone-500 dark:text-stone-400"
            >
              File name {currentDir ? `in ${currentDir}/` : "in repo root"}
            </label>
            <input
              id="new-file-name-input"
              value={newFileName}
              onChange={(e) => {
                setNewFileName(e.target.value);
                setCreateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameCheck.ok && !creating) {
                  void handleCreateFile();
                }
              }}
              placeholder="untitled.md"
              className="h-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm text-slate-950 dark:text-slate-50 outline-none focus:ring-2 focus:ring-slate-300/70 dark:focus:ring-slate-600/70 placeholder:text-stone-400"
              spellCheck={false}
              autoCapitalize="none"
              autoFocus
            />
            {!nameCheck.ok && newFileName.trim() ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                {nameCheck.error}
              </p>
            ) : null}
            {createError ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                {createError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowNewFile(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleCreateFile}
              disabled={!nameCheck.ok || creating}
            >
              {creating ? "Creating…" : "Create file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
