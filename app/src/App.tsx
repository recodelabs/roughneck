import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  editorBusy,
  findNewAgentReplies,
  liveUpdateActionFor,
} from "./activity-live";
import type { ActivityEntry } from "./activity-log";
import {
  formatWorkspacePathForDisplay,
  getPathLeaf,
  getRequestedPathState,
  joinPath,
  PREVIEW_PATH,
  ROUGHDRAFT_FLAVORED_MARKDOWN_PATH,
  syncRequestedPathInUrl,
} from "./app-navigation";
import { resolveAppView } from "./app-view";
import { type AutoMergeOutcome, saveWithAutoMerge } from "./auto-merge";
import { ConflictResolveDialog } from "./ConflictResolveDialog";
import { DocumentLoadError } from "./DocumentLoadError";
import type { GitHubDocNav } from "./DocumentWorkspace";
import { detectBackend, isGitHubMode } from "./detect-backend";
import { useDocumentEditorViewMode } from "./document-editor-view-mode";
import { createDocumentSessionStore } from "./document-session";
import { GitHubPicker } from "./GitHubPicker";
import { completeLoginFromUrl, getStoredToken } from "./github-auth";
import { isSupportedPath, navigate, parseGitHubLocation } from "./github-route";
import { Homepage, HomepageSubtitle } from "./Homepage";
import type { MergeRegion } from "./merge";
import type { DocumentSaveState } from "./PageCard";
import { PreviewPage } from "./PreviewPage";
import { PublicDocNotFoundError } from "./public-backend";
import { RoughdraftFlavoredMarkdownPage } from "./RoughdraftFlavoredMarkdownPage";
import { runWithErrorFeedback } from "./run-with-error-feedback";
import { handleSessionExpiry } from "./session-expiry";
import { setSharingFlag } from "./sharing-frontmatter";
import {
  type CompleteReviewOptions,
  FileTooLargeError,
  MarkdownFileConflictError,
  type Page,
  type StorageBackend,
} from "./storage";
import { Toast } from "./Toast";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { UpdateNotice } from "./UpdateNotice";
import { fetchUpdateStatus, type UpdateStatus } from "./update-status";

// The editor workspace pulls in the heavy editor stack (TipTap, Turndown,
// CodeMirror). Load it lazily so the login screen and picker don't pay for the
// full bundle up front (see PERF-2).
const DocumentWorkspace = lazy(() =>
  import("./DocumentWorkspace").then((module) => ({
    default: module.DocumentWorkspace,
  })),
);

// The file-tree sidebar only appears in the document workspace (GitHub mode),
// so lazy-load it with the workspace to keep it off the login/picker path.
const FileTreeSidebar = lazy(() =>
  import("./FileTreeSidebar").then((module) => ({
    default: module.FileTreeSidebar,
  })),
);

export type DocumentDiskChangeState =
  | "clean"
  | "changed"
  | "conflict"
  | "paused";

export function shouldWarnBeforeUnload({
  activeDocumentPath,
  isDirty,
  saveState,
  diskChangeState,
}: {
  activeDocumentPath: string | null;
  isDirty: boolean;
  saveState: DocumentSaveState;
  diskChangeState: DocumentDiskChangeState;
}) {
  return (
    !!activeDocumentPath &&
    (isDirty ||
      saveState === "saving" ||
      saveState === "unsaved" ||
      saveState === "error" ||
      diskChangeState !== "clean")
  );
}

export function App() {
  const initialRequestedPathState = getRequestedPathState();
  const [requestedPathState] = useState(initialRequestedPathState);
  // Current GitHub route, kept reactive so file-open / back-to-picker are
  // in-app transitions rather than full reloads. Updated on `popstate` (browser
  // Back/Forward and the synthetic event fired by navigate()).
  const [githubLocation, setGithubLocation] = useState(parseGitHubLocation);
  const isRoughdraftFlavoredMarkdownRoute =
    window.location.pathname === ROUGHDRAFT_FLAVORED_MARKDOWN_PATH;
  const isPreviewRoute = window.location.pathname === PREVIEW_PATH;
  const [backend, setBackend] = useState<StorageBackend | null>(null);
  const [documentPage, setDocumentPage] = useState<Page | null>(null);
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(
    initialRequestedPathState.documentPath,
  );
  const [documentSession] = useState(() => createDocumentSessionStore());
  const [documentDiskChangeState, setDocumentDiskChangeState] =
    useState<DocumentDiskChangeState>("clean");
  const [documentForceResetKey, setDocumentForceResetKey] = useState<
    string | null
  >(null);
  // Set when an autosave hits an overlapping edit conflict that the 3-way merge
  // could not resolve on its own; drives the resolve dialog. `version` is the
  // server's current version, which the resolved text must be saved against.
  const [documentMergeConflict, setDocumentMergeConflict] = useState<{
    path: string;
    base: string;
    regions: MergeRegion[];
    version?: string;
  } | null>(null);
  const [documentActionError, setDocumentActionError] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publicView, setPublicView] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  // "Propose changes" mode: commit through a working branch + PR instead of
  // straight to the selected branch. Persisted per repo as a default.
  const [proposeChanges, setProposeChanges] = useState(false);
  const [pendingNavHref, setPendingNavHref] = useState<string | null>(null);
  const [committingBeforeLeave, setCommittingBeforeLeave] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [documentEditorViewMode, handleDocumentEditorViewModeChange] =
    useDocumentEditorViewMode();
  const [toast, setToast] = useState<{
    message: string;
    commitUrl?: string;
    prUrl?: string;
  } | null>(null);
  // The PR URL we've already announced, so we toast it once per session rather
  // than on every save in propose-changes mode.
  const announcedPrUrlRef = useRef<string | null>(null);
  const [liveActivityEntries, setLiveActivityEntries] = useState<
    ActivityEntry[] | null
  >(null);
  const prevActivityEntriesRef = useRef<ActivityEntry[]>([]);
  const backendRef = useRef<StorageBackend | null>(null);
  const documentPageRef = useRef<Page | null>(null);
  const activeDocumentPathRef = useRef<string | null>(activeDocumentPath);
  // Which GitHub repo/branch the current backend serves, so same-repo
  // navigations reuse it (no re-detect) while a repo/branch switch re-detects.
  const githubRepoSigRef = useRef<string | null>(null);

  backendRef.current = backend;
  documentPageRef.current = documentPage;
  activeDocumentPathRef.current = activeDocumentPath;

  const applyDocumentPage = useCallback(
    (nextDocument: Page) => {
      setDocumentPage(nextDocument);
      documentSession.setDraftContent(nextDocument.content);
    },
    [documentSession],
  );

  const loadDocument = useCallback(
    async (nextBackend: StorageBackend, relativePath: string) => {
      const nextDocument = await nextBackend.getMarkdownFile(relativePath);
      applyDocumentPage(nextDocument);
      setActiveDocumentPath(relativePath);
      documentSession.setDirty(false);
      setDocumentDiskChangeState("clean");
      return nextDocument;
    },
    [applyDocumentPage, documentSession],
  );

  // Reflect browser Back/Forward (and the synthetic popstate from navigate())
  // into reactive route state so the load effect and render react to in-app URL
  // changes without a reload. This is the single popstate handler App was
  // missing (ARCH-6).
  useEffect(() => {
    const onPopState = () => setGithubLocation(parseGitHubLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadUpdateStatus = async () => {
      const nextUpdateStatus = await fetchUpdateStatus();
      if (!cancelled) {
        setUpdateStatus(nextUpdateStatus);
      }
    };

    void loadUpdateStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isGitHubMode()) return;
    const sourceUrl = new URL("/api/open-requests", window.location.origin);
    if (requestedPathState.rawPath) {
      sourceUrl.searchParams.set("path", requestedPathState.rawPath);
    }

    const source = new EventSource(`${sourceUrl.pathname}${sourceUrl.search}`);
    const handleOpenRequest = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          url?: unknown;
        };
        if (typeof payload.url !== "string" || !payload.url.trim()) return;

        const nextUrl = new URL(payload.url, window.location.origin);
        window.focus();
        if (nextUrl.href !== window.location.href) {
          window.location.assign(nextUrl.href);
        }
      } catch (error) {
        console.error("Failed to handle Roughdraft open request:", error);
      }
    };

    source.addEventListener("open-request", handleOpenRequest);

    return () => {
      source.removeEventListener("open-request", handleOpenRequest);
      source.close();
    };
  }, [requestedPathState.rawPath]);

  useEffect(() => {
    let cancelled = false;

    // GitHub mode is reactive: this runs on first mount AND on every in-app
    // navigation (githubLocation changes via popstate). Same-repo file switches
    // reuse the detected backend — only the document path changes — so opening a
    // file or going back is an in-app transition, not an app re-boot. With the
    // ETag cache, repeat tree/doc reads come back 304.
    const initializeGitHub = async () => {
      // Complete the OAuth handshake first if the callback forwarded a `?code=`:
      // this strips code/state from the URL and stores the token. It MUST run
      // before the repo-less-root early-return below, otherwise login can never
      // finish at the `/?code=…` URL we land on right after the GitHub callback.
      await completeLoginFromUrl();
      if (cancelled) return;

      const { owner, repo, branch, path } = githubLocation;

      // Folder / repo-root URL (or not enough info yet) → picker view. Clear any
      // open document so render falls through to <GitHubPicker />.
      if (!owner || !repo || !isSupportedPath(path)) {
        setActiveDocumentPath(null);
        setDocumentPage(null);
        setLoadError(null);
        setPublicView(false);
        setLoading(false);
        return;
      }

      const repoSignature = `${owner}/${repo}@${branch}`;
      let detectedBackend = backendRef.current;

      // Re-detect the backend only when there isn't one yet or the repo/branch
      // changed (e.g. the picker's repo input switched repos before opening).
      if (!detectedBackend || githubRepoSigRef.current !== repoSignature) {
        setLoading(true);
        setLoadError(null);
        detectedBackend = await detectBackend();
        if (cancelled) return;
        setBackend(detectedBackend);
        githubRepoSigRef.current = repoSignature;
      }

      // Already showing this exact document (e.g. a redundant popstate) — skip
      // the refetch entirely.
      if (activeDocumentPathRef.current === path && documentPageRef.current) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadError(null);
      await loadDocument(detectedBackend, path);
      if (cancelled) return;
      setPublicView(detectedBackend.info.kind === "public");
      if (detectedBackend.info.kind === "github") {
        const canPush = await (
          detectedBackend as unknown as {
            getRepoPermission(): Promise<boolean>;
          }
        )
          .getRepoPermission()
          .catch(() => false);
        if (!cancelled) setCanEdit(canPush);
      } else {
        setCanEdit(false);
      }
      setLoading(false);
    };

    const initializeLocal = async () => {
      setLoading(true);
      setLoadError(null);
      setDocumentPage(null);

      const detectedBackend = await detectBackend();
      if (cancelled) return;

      setBackend(detectedBackend);

      if (detectedBackend.capabilities.documentPath) {
        const documentPath = detectedBackend.documentPath?.() || "remote.md";
        await loadDocument(detectedBackend, documentPath);
        if (cancelled) return;
        setLoading(false);
        return;
      }

      if (!requestedPathState.rawPath) {
        setActiveDocumentPath(null);
        setLoading(false);
        return;
      }

      syncRequestedPathInUrl(requestedPathState.rawPath);

      if (!requestedPathState.projectPath || !requestedPathState.documentPath) {
        setActiveDocumentPath(null);
        setLoadError("Roughdraft now opens one .md file at a time.");
        setLoading(false);
        return;
      }

      if (detectedBackend.canManageProjects) {
        await detectedBackend.openProject(requestedPathState.projectPath);
      }

      if (cancelled) return;

      await loadDocument(detectedBackend, requestedPathState.documentPath);
      if (cancelled) return;

      setLoading(false);
    };

    const initialize = async () => {
      try {
        if (isGitHubMode()) {
          await initializeGitHub();
        } else {
          await initializeLocal();
        }
      } catch (error) {
        if (cancelled) return;

        if (error instanceof PublicDocNotFoundError) {
          // Not shared (or private): drop to the sign-in picker so the visitor
          // can authenticate to view a private doc.
          setPublicView(false);
          setActiveDocumentPath(null);
          setDocumentPage(null);
          setLoadError(null);
          setLoading(false);
          return;
        }

        // An expired session boots the user back to sign-in; don't render the
        // generic load error over the in-flight redirect.
        if (handleSessionExpiry(error)) return;

        console.error("Failed to open markdown file:", error);
        setActiveDocumentPath(null);
        setLoadError(
          error instanceof FileTooLargeError
            ? error.message
            : "Could not open that markdown file.",
        );
        setLoading(false);
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [
    loadDocument,
    githubLocation,
    requestedPathState.documentPath,
    requestedPathState.projectPath,
    requestedPathState.rawPath,
  ]);

  useEffect(() => {
    const githubFilePath =
      githubLocation.owner &&
      githubLocation.repo &&
      isSupportedPath(githubLocation.path)
        ? `${githubLocation.owner}/${githubLocation.repo}/${githubLocation.path.replace(/^\/+/, "")}`
        : null;

    const workspaceTitlePath =
      githubFilePath ??
      (activeDocumentPath
        ? formatWorkspacePathForDisplay(
            backend?.info.projectPath
              ? joinPath(backend.info.projectPath, activeDocumentPath)
              : requestedPathState.rawPath,
          )
        : null);

    document.title = isPreviewRoute
      ? "Roughdraft Preview"
      : isRoughdraftFlavoredMarkdownRoute
        ? "Roughdraft Flavored Markdown"
        : workspaceTitlePath
          ? `margins.md - ${workspaceTitlePath}`
          : "margins.md";
  }, [
    activeDocumentPath,
    backend,
    githubLocation,
    isRoughdraftFlavoredMarkdownRoute,
    isPreviewRoute,
    requestedPathState.rawPath,
  ]);

  // Bind the active backend's save into the pure auto-merge orchestrator, so it
  // folds in concurrent saves and surfaces only genuine overlaps as conflicts.
  const runAutoMergeSave = useCallback(
    (params: {
      path: string;
      content: string;
      base: string;
      expectedVersion?: string;
    }): Promise<AutoMergeOutcome> => {
      const backend = backendRef.current;
      if (!backend) return Promise.resolve({ kind: "exhausted" });
      return saveWithAutoMerge(
        (path, content, expectedVersion) =>
          backend.saveMarkdownFile(path, content, expectedVersion),
        params,
      );
    },
    [],
  );

  // In propose-changes mode a save opens (or reuses) a PR; surface its URL the
  // first time we see it so the user can jump to the pull request.
  const announcePullRequest = useCallback(() => {
    const url = backendRef.current?.pullRequestUrl?.() ?? null;
    if (url && url !== announcedPrUrlRef.current) {
      announcedPrUrlRef.current = url;
      setToast({
        message: "Opened a pull request with your changes.",
        prUrl: url,
      });
    }
  }, []);

  // Load the per-repo "propose changes" default and apply it to the backend
  // whenever the backend changes.
  useEffect(() => {
    if (!backend?.capabilities.pullRequests) {
      setProposeChanges(false);
      return;
    }
    let pref = false;
    try {
      pref =
        localStorage.getItem(
          `margins:proposeChanges:${backend.info.detail}`,
        ) === "1";
    } catch {
      // localStorage unavailable (private mode) — fall back to direct commits.
    }
    setProposeChanges(pref);
    backend.setProposeChanges?.(pref);
  }, [backend]);

  const handleProposeChangesChange = useCallback((next: boolean) => {
    const currentBackend = backendRef.current;
    if (!currentBackend?.capabilities.pullRequests) return;
    setProposeChanges(next);
    currentBackend.setProposeChanges?.(next);
    try {
      localStorage.setItem(
        `margins:proposeChanges:${currentBackend.info.detail}`,
        next ? "1" : "0",
      );
    } catch {
      // Best-effort persistence; the in-session toggle still works without it.
    }
  }, []);

  const handleSaveDocument = useCallback(
    async (id: string, content: string) => {
      if (!activeDocumentPath) return;

      const baseDoc =
        documentPageRef.current?.id === id ? documentPageRef.current : null;
      const outcome = await runAutoMergeSave({
        path: activeDocumentPath,
        content,
        // The common ancestor: the content we last synced with the server. On a
        // conflict the save failed, so this still holds the base.
        base: baseDoc?.content ?? content,
        expectedVersion: baseDoc?.version,
      });

      if (outcome.kind === "saved") {
        applyDocumentPage(outcome.savedDocument);
        documentSession.setDirty(false);
        setDocumentDiskChangeState("clean");
        setDocumentMergeConflict(null);
        if (outcome.autoMerged) {
          // The editor still shows our pre-merge draft; reset it to the merged
          // result so the next autosave can't clobber the folded-in changes.
          setDocumentForceResetKey(
            `${activeDocumentPath}:${outcome.savedDocument.version ?? Date.now()}:merged`,
          );
          setToast({ message: "Merged in changes saved by someone else." });
        } else {
          announcePullRequest();
        }
        return;
      }

      if (outcome.kind === "conflict") {
        setDocumentMergeConflict(outcome.conflict);
      }
      setDocumentDiskChangeState("conflict");
      // Signal the editor that this autosave did not land, so it doesn't show
      // "saved" while the conflict dialog is open.
      throw new MarkdownFileConflictError(
        documentPageRef.current ?? { id, title: id, content },
      );
    },
    [
      activeDocumentPath,
      announcePullRequest,
      applyDocumentPage,
      documentSession,
      runAutoMergeSave,
    ],
  );

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const session = documentSession.getSnapshot();
      if (
        !shouldWarnBeforeUnload({
          activeDocumentPath: activeDocumentPathRef.current,
          isDirty: session.dirty,
          saveState: session.saveState,
          diskChangeState: documentDiskChangeState,
        })
      ) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [documentDiskChangeState, documentSession]);

  const handleReloadDocumentFromDisk = useCallback(
    () =>
      runWithErrorFeedback(
        async () => {
          const currentBackend = backendRef.current;
          const currentPath = activeDocumentPathRef.current;
          if (!currentBackend || !currentPath) return;

          setDocumentActionError(null);
          const nextDocument =
            await currentBackend.getMarkdownFile(currentPath);
          applyDocumentPage(nextDocument);
          documentSession.setDirty(false);
          setDocumentDiskChangeState("clean");
          setDocumentForceResetKey(
            `${currentPath}:${nextDocument.version ?? Date.now()}`,
          );
        },
        setDocumentActionError,
        "Could not reload the file from disk.",
      ),
    [applyDocumentPage, documentSession],
  );

  const handleKeepEditingWithoutAutosave = useCallback(() => {
    setDocumentDiskChangeState("paused");
  }, []);

  const handleOverwriteDocumentOnDisk = useCallback(
    () =>
      runWithErrorFeedback(
        async () => {
          const currentBackend = backendRef.current;
          const currentPath = activeDocumentPathRef.current;
          const currentDocument = documentPageRef.current;
          if (!currentBackend || !currentPath || !currentDocument) return;

          setDocumentActionError(null);
          const content =
            documentSession.getSnapshot().draftContent ??
            currentDocument.content;
          const savedDocument = await currentBackend.saveMarkdownFile(
            currentPath,
            content,
          );

          applyDocumentPage(savedDocument);
          documentSession.setDirty(false);
          documentSession.setSaveState("saved");
          setDocumentDiskChangeState("clean");
          setDocumentForceResetKey(
            `${currentPath}:${savedDocument.version ?? Date.now()}:overwrite`,
          );
        },
        setDocumentActionError,
        "Could not overwrite the file on disk.",
      ),
    [applyDocumentPage, documentSession],
  );

  // The user picked how to resolve each overlapping conflict; save the combined
  // text. If yet another save landed meanwhile, re-merge and re-open the dialog.
  const handleResolveConflict = useCallback(
    (resolvedText: string) =>
      runWithErrorFeedback(
        async () => {
          const conflict = documentMergeConflict;
          const currentPath = activeDocumentPathRef.current;
          if (!conflict || !currentPath) return;

          setDocumentActionError(null);
          const outcome = await runAutoMergeSave({
            path: currentPath,
            content: resolvedText,
            base: conflict.base,
            expectedVersion: conflict.version,
          });

          if (outcome.kind === "saved") {
            applyDocumentPage(outcome.savedDocument);
            documentSession.setDirty(false);
            documentSession.setSaveState("saved");
            setDocumentDiskChangeState("clean");
            setDocumentMergeConflict(null);
            setDocumentForceResetKey(
              `${currentPath}:${outcome.savedDocument.version ?? Date.now()}:resolved`,
            );
            return;
          }

          if (outcome.kind === "conflict") {
            setDocumentMergeConflict(outcome.conflict);
            return;
          }
          throw new Error("Could not save the resolved document.");
        },
        setDocumentActionError,
        "Could not save the resolved document.",
      ),
    [
      applyDocumentPage,
      documentMergeConflict,
      documentSession,
      runAutoMergeSave,
    ],
  );

  const handleCancelConflict = useCallback(() => {
    // Close the dialog but keep the draft; autosave stays paused so we don't
    // immediately re-trigger the same conflict.
    setDocumentMergeConflict(null);
    setDocumentDiskChangeState("paused");
  }, []);

  const handleTakeTheirsForConflict = useCallback(() => {
    setDocumentMergeConflict(null);
    void handleReloadDocumentFromDisk();
  }, [handleReloadDocumentFromDisk]);

  const handleCompleteReview = useCallback(
    async (options?: CompleteReviewOptions) => {
      const currentBackend = backendRef.current;
      const currentPath = activeDocumentPathRef.current;
      const currentDocument = documentPageRef.current;
      if (!currentBackend || !currentPath || !currentDocument) {
        return { delivered: false };
      }

      const content =
        documentSession.getSnapshot().draftContent ?? currentDocument.content;
      const expectedVersion = currentDocument.version;

      const savedDocument = await currentBackend.saveMarkdownFile(
        currentPath,
        content,
        expectedVersion,
      );

      applyDocumentPage(savedDocument);
      documentSession.setDirty(false);
      setDocumentDiskChangeState("clean");

      return currentBackend.completeReview
        ? currentBackend.completeReview(currentPath, options)
        : { delivered: false };
    },
    [applyDocumentPage, documentSession],
  );

  const handleSetPublic = useCallback(
    async (next: boolean) => {
      const currentBackend = backendRef.current;
      const currentPath = activeDocumentPathRef.current;
      const currentDocument = documentPageRef.current;
      if (!currentBackend || !currentPath || !currentDocument) return;
      const updated = setSharingFlag(currentDocument.content, "public", next);
      // Apply the page the save returns rather than re-reading: GitHub's Contents
      // API is eventually consistent, so an immediate re-read often serves the
      // pre-commit blob and the controlled Share checkbox snaps back off. The
      // returned page already holds the freshly-written content and new SHA
      // (mirrors handleCompleteReview).
      const savedDocument = await currentBackend.saveMarkdownFile(
        currentPath,
        updated,
        currentDocument.version,
      );
      applyDocumentPage(savedDocument);
      documentSession.setDirty(false);
      setDocumentDiskChangeState("clean");
    },
    [applyDocumentPage, documentSession],
  );

  const handleSetComments = useCallback(
    async (next: boolean) => {
      const currentBackend = backendRef.current;
      const currentPath = activeDocumentPathRef.current;
      const currentDocument = documentPageRef.current;
      if (!currentBackend || !currentPath || !currentDocument) return;
      const updated = setSharingFlag(currentDocument.content, "comments", next);
      // See handleSetPublic: apply the save's returned page instead of re-reading,
      // so the toggle reflects immediately despite GitHub's eventual consistency.
      const savedDocument = await currentBackend.saveMarkdownFile(
        currentPath,
        updated,
        currentDocument.version,
      );
      applyDocumentPage(savedDocument);
      documentSession.setDirty(false);
      setDocumentDiskChangeState("clean");
    },
    [applyDocumentPage, documentSession],
  );

  useEffect(() => {
    if (!backend?.watchMarkdownFile || !activeDocumentPath) return;

    let disposed = false;
    const stopWatching = backend.watchMarkdownFile(
      activeDocumentPath,
      (event) => {
        if (disposed || event.path !== activeDocumentPath) return;

        const currentDocument = documentPageRef.current;
        if (event.version && currentDocument?.version === event.version) {
          return;
        }

        if (!event.exists) {
          setDocumentDiskChangeState("changed");
          return;
        }

        if (documentDiskChangeState === "paused") {
          return;
        }

        if (documentSession.getSnapshot().dirty) {
          setDocumentDiskChangeState("changed");
          return;
        }

        void (async () => {
          const currentBackend = backendRef.current;
          const currentPath = activeDocumentPathRef.current;
          if (!currentBackend || !currentPath || disposed) return;

          try {
            const nextDocument =
              await currentBackend.getMarkdownFile(currentPath);
            if (disposed) return;
            applyDocumentPage(nextDocument);
            setDocumentDiskChangeState("clean");
          } catch (error) {
            console.error("Failed to reload changed markdown file:", error);
          }
        })();
      },
    );

    return () => {
      disposed = true;
      stopWatching();
    };
  }, [
    activeDocumentPath,
    applyDocumentPage,
    backend,
    documentDiskChangeState,
    documentSession,
  ]);

  useEffect(() => {
    if (!backend?.capabilities.activityLog || !backend.watchActivityLog) return;
    if (!activeDocumentPath) return;

    let disposed = false;
    let seeded = false;
    prevActivityEntriesRef.current = [];

    const stop = backend.watchActivityLog(activeDocumentPath, (entries) => {
      if (disposed) return;
      setLiveActivityEntries(entries);

      // The first callback is the baseline (the log as it is when the doc opens).
      // Seed the diff state but DON'T act on pre-existing replies — otherwise old
      // agent replies would re-apply/toast every time you open the doc.
      if (!seeded) {
        seeded = true;
        prevActivityEntriesRef.current = entries;
        return;
      }

      const fresh = findNewAgentReplies(
        prevActivityEntriesRef.current,
        entries,
      );
      prevActivityEntriesRef.current = entries;

      for (const reply of fresh) {
        const snapshot = documentSession.getSnapshot();
        const busy = editorBusy({
          dirty: snapshot.dirty,
          saveState: snapshot.saveState,
          composingComment: snapshot.composingComment,
        });
        const action = liveUpdateActionFor(reply, busy);

        if (action === "conflict") {
          setDocumentDiskChangeState("changed");
          setToast({
            message: "The agent updated this doc — reload when ready.",
          });
          continue;
        }
        if (action !== "apply") continue;

        void (async () => {
          const currentBackend = backendRef.current;
          const currentPath = activeDocumentPathRef.current;
          if (!currentBackend || !currentPath || disposed) return;
          try {
            const nextDocument =
              await currentBackend.getMarkdownFile(currentPath);
            if (disposed) return;
            applyDocumentPage(nextDocument);
            documentSession.setDirty(false);
            setDocumentDiskChangeState("clean");
            setToast({
              message: `Updated by the agent · ${reply.summary}`,
              commitUrl: reply.commit
                ? currentBackend.commitUrl?.(reply.commit)
                : undefined,
            });
          } catch (error) {
            console.error("Failed to apply agent update:", error);
            setToast({
              message: "The agent updated this doc — reload to see it.",
            });
          }
        })();
      }
    });

    return () => {
      disposed = true;
      stop();
      setLiveActivityEntries(null);
    };
  }, [activeDocumentPath, applyDocumentPage, backend, documentSession]);

  const dismissToast = useCallback(() => setToast(null), []);

  // SPA navigation away from the open document (breadcrumb back-to-picker /
  // folder). A full reload used to trigger the native beforeunload warning;
  // SPA nav bypasses it, so we re-run the same dirty check here and confirm
  // before leaving, otherwise unsaved edits would be silently lost.
  const handleNavigateAway = useCallback(
    (href: string) => {
      const session = documentSession.getSnapshot();
      if (
        shouldWarnBeforeUnload({
          activeDocumentPath: activeDocumentPathRef.current,
          isDirty: session.dirty,
          saveState: session.saveState,
          diskChangeState: documentDiskChangeState,
        })
      ) {
        setLeaveError(null);
        setPendingNavHref(href);
        return;
      }
      navigate(href);
    },
    [documentSession, documentDiskChangeState],
  );

  const handleStayOnDocument = useCallback(() => {
    setPendingNavHref(null);
    setLeaveError(null);
    setCommittingBeforeLeave(false);
  }, []);

  const handleLeaveWithoutSaving = useCallback(() => {
    const href = pendingNavHref;
    setPendingNavHref(null);
    setLeaveError(null);
    setCommittingBeforeLeave(false);
    if (href) navigate(href);
  }, [pendingNavHref]);

  const handleCommitAndLeave = useCallback(async () => {
    const href = pendingNavHref;
    if (!href) return;
    const controller = documentSession.getSnapshot().saveController;
    if (!controller) {
      // No editor controller to commit through — just leave.
      handleLeaveWithoutSaving();
      return;
    }
    setCommittingBeforeLeave(true);
    setLeaveError(null);
    const result = await controller.flushSave();
    if (result.status === "saved") {
      setCommittingBeforeLeave(false);
      setPendingNavHref(null);
      navigate(href);
      return;
    }
    setCommittingBeforeLeave(false);
    setLeaveError(
      result.status === "blocked"
        ? "This file changed on disk — resolve the conflict before committing."
        : result.error instanceof Error
          ? result.error.message
          : "Could not commit your changes.",
    );
  }, [pendingNavHref, documentSession, handleLeaveWithoutSaving]);

  const view = resolveAppView({
    loading,
    isRoughdraftFlavoredMarkdownRoute,
    isPreviewRoute,
    gitHubMode: isGitHubMode(),
    hasToken: !!getStoredToken(),
    githubLocation,
    loadError,
    rawPath: requestedPathState.rawPath,
    publicView,
  });

  if (view === "loading") {
    return (
      <div
        className="h-screen bg-[#FCFCFC] dark:bg-background"
        aria-hidden="true"
      />
    );
  }

  if (view === "roughdraft-flavored-markdown") {
    return <RoughdraftFlavoredMarkdownPage />;
  }

  if (view === "preview") {
    return <PreviewPage />;
  }

  if (view === "github-picker") {
    return <GitHubPicker />;
  }

  if (view === "load-error") {
    return (
      <DocumentLoadError
        message={loadError ?? "Could not open that markdown file."}
      />
    );
  }

  if (view === "homepage") {
    return (
      <Homepage message={<HomepageSubtitle />} updateStatus={updateStatus} />
    );
  }

  const documentAbsolutePath =
    activeDocumentPath && backend?.info.projectPath
      ? joinPath(backend.info.projectPath, activeDocumentPath)
      : requestedPathState.rawPath;
  const documentFilenameLabel =
    getPathLeaf(documentAbsolutePath ?? activeDocumentPath) ?? "Untitled.md";

  // Build githubNav when in GitHub mode and a markdown file path is in the URL
  const githubNav: GitHubDocNav | null = (() => {
    if (!isGitHubMode()) return null;
    const loc = githubLocation;
    if (!loc.owner || !loc.repo || !isSupportedPath(loc.path)) return null;
    return {
      owner: loc.owner,
      repo: loc.repo,
      branch: loc.branch,
      path: loc.path,
    };
  })();

  const shareUrl = (() => {
    const loc = githubLocation;
    if (!loc.owner || !loc.repo || !isSupportedPath(loc.path)) return "";
    return `${window.location.origin}/${loc.owner}/${loc.repo}/${loc.path}${loc.branch && loc.branch !== "main" ? `?branch=${loc.branch}` : ""}`;
  })();

  return (
    <main className="relative flex h-screen min-w-0 flex-col overflow-hidden bg-[#FCFCFC] dark:bg-background text-slate-950 dark:text-slate-50">
      {toast ? (
        <Toast
          message={toast.message}
          commitUrl={toast.commitUrl}
          prUrl={toast.prUrl}
          onDismiss={dismissToast}
        />
      ) : null}
      {documentMergeConflict ? (
        <ConflictResolveDialog
          regions={documentMergeConflict.regions}
          onResolve={handleResolveConflict}
          onTakeTheirs={handleTakeTheirsForConflict}
          onCancel={handleCancelConflict}
        />
      ) : null}
      {updateStatus ? (
        <div className="pointer-events-none absolute top-4 right-4 z-40 max-w-sm">
          <div className="pointer-events-auto">
            <UpdateNotice updateStatus={updateStatus} />
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={null}>
          <FileTreeSidebar
            backend={backend}
            githubNav={githubNav}
            onNavigate={handleNavigateAway}
          />
        </Suspense>
        <Suspense fallback={null}>
          <DocumentWorkspace
            documentPage={documentPage}
            activeDocumentPath={activeDocumentPath}
            documentFilenameLabel={documentFilenameLabel}
            documentEditorViewMode={documentEditorViewMode}
            onDocumentEditorViewModeChange={handleDocumentEditorViewModeChange}
            onSaveDocument={handleSaveDocument}
            documentSession={documentSession}
            documentDiskChangeState={documentDiskChangeState}
            documentForceResetKey={documentForceResetKey}
            documentActionError={documentActionError}
            onDismissDocumentActionError={() => setDocumentActionError(null)}
            onReloadDocumentFromDisk={handleReloadDocumentFromDisk}
            onKeepEditingWithoutAutosave={handleKeepEditingWithoutAutosave}
            onOverwriteDocumentOnDisk={handleOverwriteDocumentOnDisk}
            onCompleteReview={handleCompleteReview}
            backend={backend}
            manualCommit={backend?.capabilities.manualCommit ?? false}
            canProposeChanges={backend?.capabilities.pullRequests ?? false}
            proposeChanges={proposeChanges}
            onProposeChangesChange={handleProposeChangesChange}
            githubNav={githubNav}
            onNavigate={handleNavigateAway}
            liveActivityEntries={liveActivityEntries}
            canEdit={canEdit}
            shareUrl={shareUrl}
            onSetPublic={handleSetPublic}
            onSetComments={handleSetComments}
            onDocumentPageChange={setDocumentPage}
          />
        </Suspense>
      </div>
      <UnsavedChangesDialog
        open={pendingNavHref !== null}
        manualCommit={backend?.capabilities.manualCommit ?? false}
        committing={committingBeforeLeave}
        error={leaveError}
        onCommitAndLeave={handleCommitAndLeave}
        onLeaveWithoutSaving={handleLeaveWithoutSaving}
        onStay={handleStayOnDocument}
      />
    </main>
  );
}
