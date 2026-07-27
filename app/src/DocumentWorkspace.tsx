import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CodeXml,
  Eye,
  EyeOff,
  GitPullRequest,
  History,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  Printer,
  RefreshCcw,
  Upload,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bodyStart as commentAnchorBodyStart,
  selectionOccurrence,
} from "../../lib/comment-anchor";
import type { ActivityEntry } from "./activity-log";
import {
  readStoredAgentBoxHidden,
  writeStoredAgentBoxHidden,
} from "./agent-box-visibility";
import type { DocumentEditorViewMode } from "./app-navigation";
import { CommandPalette } from "./CommandPalette";
import {
  buildDocumentPaletteCommands,
  type PaletteCommand,
} from "./command-palette";
import {
  readStoredCommentsHidden,
  writeStoredCommentsHidden,
} from "./comment-visibility";
import { RemoteSessionBanner } from "./components/RemoteSessionBanner";
import { Button } from "./components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
} from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { criticMarkdownHasReviewRail } from "./critic-markup";
import {
  type DocumentSessionStore,
  useDocumentSession,
} from "./document-session";
import { FileHistoryDialog } from "./FileHistoryDialog";
import { isMarkdownPath } from "./file-types";
import { getStoredToken } from "./github-auth";
import { listAccessibleRepos, listBranches } from "./github-repos";
import { gitHubHref } from "./github-route";
import { getGuestName, setGuestName } from "./guest-identity";
import { InstructionSender } from "./InstructionSender";
import { cn } from "./lib/utils";
import { MermaidOverlays } from "./MermaidOverlays";
import { toHtml } from "./markdown";
import {
  type DocumentInteractionMode,
  type DocumentSaveState,
  PageCard,
} from "./PageCard";
import { installPrintThemeReset, printDocument } from "./print-document";
import type { PublicBackend } from "./public-backend";
import { SharePopover } from "./SharePopover";
import { getSharingFlags } from "./sharing-frontmatter";
import type { CompleteReviewOptions, Page, StorageBackend } from "./storage";
import { currentTheme, setTheme } from "./theme";

/** Groups the palette keeps hidden until the user types (stable identity). */
const PALETTE_HIDDEN_GROUPS = ["Files"];

type DiskChangeState = "clean" | "changed" | "conflict" | "paused";
type ReviewHandoffState =
  | "idle"
  | "notifying"
  | "notified"
  | "undelivered"
  | "error";
type FileCopyAction = "path" | "filename" | "markdown" | "rich-text";

const documentInteractionModeOptions = [
  { value: "editing", label: "Editing", Icon: PencilLine },
  { value: "suggesting", label: "Suggesting", Icon: MessageSquarePlus },
  { value: "viewing", label: "Viewing", Icon: Eye },
] satisfies {
  value: DocumentInteractionMode;
  label: string;
  Icon: typeof Eye;
}[];

const conflictNoticeCopy: Record<
  Exclude<DiskChangeState, "clean">,
  {
    title: string;
    body: string;
  }
> = {
  changed: {
    title: "File changed on disk",
    body: "Roughdraft found a newer version of this file on disk. Reload to use that version, or overwrite it with your current draft.",
  },
  conflict: {
    title: "Save conflict",
    body: "This file changed on disk while you have unsaved edits. Autosave is paused so your draft will not overwrite those changes.",
  },
  paused: {
    title: "Autosave paused",
    body: "Keep editing locally, then reload from disk to discard your draft or overwrite the disk file when you are ready.",
  },
};

const fileCopyMenuOptions = [
  { action: "path", label: "Copy path" },
  { action: "filename", label: "Copy filename" },
  { action: "markdown", label: "Copy markdown" },
  { action: "rich-text", label: "Copy rich text" },
] satisfies {
  action: FileCopyAction;
  label: string;
}[];

async function writePlainTextToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

async function writeRichTextToClipboard(markdown: string) {
  const clipboardWithRichText = navigator.clipboard as Clipboard & {
    write?: Clipboard["write"];
  };

  if (clipboardWithRichText.write && typeof ClipboardItem !== "undefined") {
    await clipboardWithRichText.write([
      new ClipboardItem({
        "text/html": new Blob([toHtml(markdown)], { type: "text/html" }),
        "text/plain": new Blob([markdown], { type: "text/plain" }),
      }),
    ]);
    return;
  }

  await writePlainTextToClipboard(markdown);
}

function getSaveStatusViewModel(
  saveState: DocumentSaveState,
  diskChangeState: DiskChangeState,
) {
  if (diskChangeState === "conflict") {
    return {
      label: "Save conflict",
      ariaLabel: "Save conflict",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "changed") {
    return {
      label: "File changed on disk",
      ariaLabel: "File changed on disk",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "paused") {
    return {
      label: "Autosave paused",
      ariaLabel: "Autosave paused",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "saving") {
    return {
      label: "Saving",
      ariaLabel: "Saving",
      tone: "neutral" as const,
      Icon: Loader2,
    };
  }

  if (saveState === "error") {
    return {
      label: "Save failed",
      ariaLabel: "Save failed",
      tone: "danger" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "unsaved") {
    return {
      label: "Unsaved changes",
      ariaLabel: "Unsaved changes",
      tone: "neutral" as const,
      Icon: Loader2,
    };
  }

  return {
    label: "Saved",
    ariaLabel: "Saved",
    tone: "success" as const,
    Icon: Check,
  };
}

export function DocumentSaveStatusIndicator({
  saveState,
  diskChangeState,
}: {
  saveState: DocumentSaveState;
  diskChangeState: DiskChangeState;
}) {
  const saveStatus = getSaveStatusViewModel(saveState, diskChangeState);
  const SaveStatusIcon = saveStatus.Icon;

  return (
    <span
      data-testid="document-save-status"
      role="status"
      aria-label={saveStatus.ariaLabel}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center text-stone-400 dark:text-stone-500",
        saveStatus.tone === "warning" && "text-amber-600 dark:text-amber-400",
        saveStatus.tone === "danger" && "text-red-600 dark:text-red-400",
      )}
    >
      <SaveStatusIcon
        data-testid="document-save-status-icon"
        className={cn(
          "size-3.5 shrink-0",
          (saveStatus.label === "Saving" ||
            saveStatus.label === "Unsaved changes") &&
            "animate-spin",
          saveStatus.label === "Saved" && "document-save-status-saved",
        )}
        aria-hidden="true"
      />
    </span>
  );
}

export function isReviewHandoffDisabled({
  saveState,
  documentDiskChangeState,
  reviewHandoffState,
}: {
  saveState: DocumentSaveState;
  documentDiskChangeState: DiskChangeState;
  reviewHandoffState: ReviewHandoffState;
}) {
  // Transient save states ("saving"/"unsaved") intentionally do NOT disable the
  // button. Disabling on them dims the whole control on every keystroke while
  // autosave debounces. Instead the button stays enabled and flushes the
  // pending save on click, so the agent still receives the latest content.
  return (
    saveState === "error" ||
    reviewHandoffState !== "idle" ||
    documentDiskChangeState !== "clean"
  );
}

export interface GitHubDocNav {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

interface DocumentWorkspaceProps {
  documentPage: Page | null;
  activeDocumentPath: string | null;
  documentFilenameLabel: string;
  documentEditorViewMode: DocumentEditorViewMode;
  onDocumentEditorViewModeChange: (mode: DocumentEditorViewMode) => void;
  onSaveDocument: (id: string, content: string) => Promise<void>;
  documentSession: DocumentSessionStore;
  documentDiskChangeState: DiskChangeState;
  documentForceResetKey: string | null;
  documentActionError?: string | null;
  onDismissDocumentActionError?: () => void;
  onReloadDocumentFromDisk: () => void | Promise<void>;
  onKeepEditingWithoutAutosave: () => void;
  onOverwriteDocumentOnDisk: () => void | Promise<void>;
  onCompleteReview: (
    options?: CompleteReviewOptions,
  ) => Promise<{ delivered: boolean }>;
  backend: StorageBackend | null;
  manualCommit?: boolean;
  /** Whether this backend can open PRs (drives the "Propose changes" toggle). */
  canProposeChanges?: boolean;
  /** Current state of propose-changes mode. */
  proposeChanges?: boolean;
  /** Toggle propose-changes mode on/off. */
  onProposeChangesChange?: (next: boolean) => void;
  githubNav?: GitHubDocNav | null;
  liveActivityEntries?: ActivityEntry[] | null;
  canEdit?: boolean;
  shareUrl?: string;
  onSetPublic?: (next: boolean) => Promise<void>;
  onSetComments?: (next: boolean) => Promise<void>;
  /**
   * SPA-navigate to `href` (breadcrumb back-to-picker / folder). App owns the
   * unsaved-changes guard, so this may be a no-op if the user cancels.
   */
  onNavigate?: (href: string) => void;
  /**
   * Called after a successful guest comment submission (public view only) so
   * the parent can replace the document with the refreshed Page returned by
   * the server.
   */
  onDocumentPageChange?: (page: Page) => void;
}

export function DocumentWorkspace({
  documentPage,
  activeDocumentPath,
  documentFilenameLabel,
  documentEditorViewMode,
  onDocumentEditorViewModeChange,
  onSaveDocument,
  documentSession,
  documentDiskChangeState,
  documentForceResetKey,
  documentActionError = null,
  onDismissDocumentActionError,
  onReloadDocumentFromDisk,
  onKeepEditingWithoutAutosave,
  onOverwriteDocumentOnDisk,
  onCompleteReview,
  backend,
  manualCommit = false,
  canProposeChanges = false,
  proposeChanges = false,
  onProposeChangesChange,
  githubNav = null,
  onNavigate,
  liveActivityEntries,
  canEdit = false,
  shareUrl = "",
  onSetPublic = async () => {},
  onSetComments,
  onDocumentPageChange,
}: DocumentWorkspaceProps) {
  const readOnly = backend?.info.kind === "public";
  // Non-markdown files (.json/.yaml/.txt/.fsh) open in the code editor only:
  // the rich-text editor and CriticMarkup comment/review rail are
  // markdown-specific, so the view toggle and comment controls are hidden and
  // the editor is pinned to "code" regardless of any ?editor= URL override.
  const isMarkdownDoc = isMarkdownPath(documentFilenameLabel);
  // File history needs a backend that can list commits and read past revisions
  // (currently GitHub). Hidden in read-only/public view and when no file is open.
  const canViewHistory =
    !readOnly &&
    !!activeDocumentPath &&
    !!backend?.listFileHistory &&
    !!backend?.readFileAtRef;
  const effectiveEditorViewMode: DocumentEditorViewMode = isMarkdownDoc
    ? documentEditorViewMode
    : "code";
  const [documentInteractionMode, setDocumentInteractionMode] =
    useState<DocumentInteractionMode>("editing");
  const effectiveInteractionMode: DocumentInteractionMode = readOnly
    ? "viewing"
    : documentInteractionMode;
  const saveState = useDocumentSession(documentSession, (s) => s.saveState);

  // --- Command palette (⌘K, REC-504) --------------------------------------
  // A keyboard-first launcher for the actions otherwise scattered across the
  // toolbar. File quick-open and branch/repo switching need the GitHub backend;
  // everything else degrades gracefully on local/public docs.
  const isGitHubBackend = backend?.info.kind === "github";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [palettePage, setPalettePage] = useState<"branches" | "repos" | null>(
    null,
  );
  const [palettePageItems, setPalettePageItems] = useState<PaletteCommand[]>(
    [],
  );
  const [palettePageLoading, setPalettePageLoading] = useState(false);
  const [palettePageError, setPalettePageError] = useState<string | null>(null);
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  const paletteFilesLoadedRef = useRef(false);

  // Lazily load the repo's markdown paths the first time the palette opens, so
  // file quick-open is instant on subsequent opens. Failures are non-fatal:
  // quick-open just stays empty.
  useEffect(() => {
    if (!paletteOpen || paletteFilesLoadedRef.current || !backend) return;
    const lister = backend as unknown as {
      listMarkdownPaths?: () => Promise<{ path: string }[]>;
    };
    if (!lister.listMarkdownPaths) return;
    paletteFilesLoadedRef.current = true;
    let cancelled = false;
    void lister
      .listMarkdownPaths()
      .then((files) => {
        if (!cancelled) setPaletteFiles(files.map((f) => f.path));
      })
      .catch(() => {
        paletteFilesLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, backend]);

  // Closing the palette returns it to the root page.
  useEffect(() => {
    if (!paletteOpen) {
      setPalettePage(null);
      setPalettePageItems([]);
      setPalettePageError(null);
      setPalettePageLoading(false);
    }
  }, [paletteOpen]);

  const paletteRootCommands = useMemo<PaletteCommand[]>(() => {
    return buildDocumentPaletteCommands({
      readOnly,
      isMarkdownDoc,
      suggesting: documentInteractionMode === "suggesting",
      isGitHubBackend,
      hasGitHubNav: Boolean(githubNav),
      files: paletteFiles,
    });
  }, [
    readOnly,
    isMarkdownDoc,
    documentInteractionMode,
    isGitHubBackend,
    githubNav,
    paletteFiles,
  ]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const openBranchesPage = useCallback(async () => {
    if (!githubNav) return;
    const token = getStoredToken();
    if (!token) return;
    setPalettePage("branches");
    setPalettePageError(null);
    setPalettePageLoading(true);
    try {
      const branches = await listBranches(
        token,
        githubNav.owner,
        githubNav.repo,
      );
      setPalettePageItems(
        branches.map((name) => ({
          id: `branch:${name}`,
          title: name,
          group: "Branches",
          hint: name === githubNav.branch ? "current" : undefined,
        })),
      );
    } catch {
      setPalettePageItems([]);
      setPalettePageError("Couldn't load branches.");
    } finally {
      setPalettePageLoading(false);
    }
  }, [githubNav]);

  const openReposPage = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    setPalettePage("repos");
    setPalettePageError(null);
    setPalettePageLoading(true);
    try {
      const repos = await listAccessibleRepos(token);
      setPalettePageItems(
        repos.map((repo) => ({
          id: `repo:${repo.fullName}|${repo.defaultBranch}`,
          title: repo.fullName,
          group: "Repositories",
        })),
      );
    } catch {
      setPalettePageItems([]);
      setPalettePageError("Couldn't load repositories.");
    } finally {
      setPalettePageLoading(false);
    }
  }, []);

  const popPalettePage = useCallback(() => {
    setPalettePage(null);
    setPalettePageItems([]);
    setPalettePageError(null);
  }, []);

  const runPaletteCommand = useCallback(
    (id: string) => {
      if (id.startsWith("file:") && githubNav && onNavigate) {
        closePalette();
        onNavigate(
          gitHubHref({
            owner: githubNav.owner,
            repo: githubNav.repo,
            branch: githubNav.branch,
            path: id.slice("file:".length),
          }),
        );
        return;
      }
      if (id.startsWith("branch:") && githubNav && onNavigate) {
        closePalette();
        onNavigate(
          gitHubHref({
            owner: githubNav.owner,
            repo: githubNav.repo,
            branch: id.slice("branch:".length),
            path: githubNav.path,
          }),
        );
        return;
      }
      if (id.startsWith("repo:") && onNavigate) {
        const [fullName, defaultBranch] = id.slice("repo:".length).split("|");
        const [owner, repo] = (fullName ?? "").split("/");
        if (owner && repo) {
          closePalette();
          onNavigate(gitHubHref({ owner, repo, branch: defaultBranch }));
        }
        return;
      }
      switch (id) {
        case "action:save":
          void documentSession.getSnapshot().saveController?.flushSave();
          closePalette();
          break;
        case "action:suggest":
          setDocumentInteractionMode((mode) =>
            mode === "suggesting" ? "editing" : "suggesting",
          );
          closePalette();
          break;
        case "action:theme":
          setTheme(currentTheme() === "dark" ? "light" : "dark");
          closePalette();
          break;
        case "action:print":
          // Close first: the palette is a fixed overlay, and print CSS hides it
          // anyway — leaving it open would just obscure the page underneath.
          closePalette();
          printDocument();
          break;
        case "action:share":
          closePalette();
          setShareOpen(true);
          break;
        case "action:branches":
          void openBranchesPage();
          break;
        case "action:repos":
          void openReposPage();
          break;
      }
    },
    [
      closePalette,
      githubNav,
      onNavigate,
      documentSession,
      openBranchesPage,
      openReposPage,
    ],
  );
  const [commentsHidden, setCommentsHidden] = useState<boolean>(
    readStoredCommentsHidden,
  );
  const commentsHiddenHydratedRef = useRef(false);

  useEffect(() => {
    // Skip the initial render: only persist once the reader actually toggles,
    // so simply mounting the workspace doesn't write to localStorage.
    if (!commentsHiddenHydratedRef.current) {
      commentsHiddenHydratedRef.current = true;
      return;
    }
    writeStoredCommentsHidden(commentsHidden);
  }, [commentsHidden]);
  const [agentBoxHidden, setAgentBoxHidden] = useState<boolean>(
    readStoredAgentBoxHidden,
  );
  const agentBoxHiddenHydratedRef = useRef(false);

  useEffect(() => {
    // Skip the initial render so merely mounting doesn't write to localStorage.
    if (!agentBoxHiddenHydratedRef.current) {
      agentBoxHiddenHydratedRef.current = true;
      return;
    }
    writeStoredAgentBoxHidden(agentBoxHidden);
  }, [agentBoxHidden]);
  const [reviewHandoffState, setReviewHandoffState] =
    useState<ReviewHandoffState>("idle");
  const [reviewWatcherCount, setReviewWatcherCount] = useState(0);
  const [reviewHandoffPopoverOpen, setReviewHandoffPopoverOpen] =
    useState(false);
  const [fileCopyMenuOpen, setFileCopyMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedFileAction, setCopiedFileAction] =
    useState<FileCopyAction | null>(null);
  const [overallComment, setOverallComment] = useState("");
  const sawNoWatcherAfterNotifiedRef = useRef(false);
  const commitShortcutHint =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.userAgent)
      ? "⌘S"
      : "Ctrl+S";

  const [documentHasComments, setDocumentHasComments] = useState(
    () =>
      !!documentPage?.content &&
      criticMarkdownHasReviewRail(documentPage.content),
  );

  useEffect(() => {
    setDocumentHasComments(
      !!documentPage?.content &&
        criticMarkdownHasReviewRail(documentPage.content),
    );
  }, [documentPage?.content]);

  // ---------------------------------------------------------------------------
  // Guest comment state (public / readOnly path only)
  // ---------------------------------------------------------------------------
  const publicCommentsEnabled =
    readOnly &&
    !!documentPage?.content &&
    getSharingFlags(documentPage.content).comments;

  // Selection detection: show "Leave a comment" button on text selection
  const [guestSelectionText, setGuestSelectionText] = useState<string | null>(
    null,
  );
  const [guestSelectionRect, setGuestSelectionRect] = useState<DOMRect | null>(
    null,
  );
  // Markdown content offset of the selection's start character, used to
  // compute the correct 1-based occurrence for insertPublicComment.
  const [guestSelectionStartOffset, setGuestSelectionStartOffset] = useState<
    number | null
  >(null);
  const publicDocAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!readOnly || !publicCommentsEnabled) return;

    const handleSelectionChange = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!text || !sel || sel.rangeCount === 0) {
        setGuestSelectionText(null);
        setGuestSelectionRect(null);
        setGuestSelectionStartOffset(null);
        return;
      }
      // Only show the button if the selection is inside the doc area
      const range = sel.getRangeAt(0);
      const container = publicDocAreaRef.current;
      if (container && !container.contains(range.commonAncestorContainer)) {
        setGuestSelectionText(null);
        setGuestSelectionRect(null);
        setGuestSelectionStartOffset(null);
        return;
      }

      // Compute a "pre-selection prefix length" by cloning a range from the
      // container start up to the selection start, then counting how many times
      // the selected text appears in that prefix.  This tells us how many
      // rendered occurrences precede the one the user selected, so we can
      // derive the correct 1-based occurrence for insertPublicComment.
      // We store it as a markdown body offset estimate: bodyStart + prefixLength.
      let startOffsetHint: number | null = null;
      if (container && documentPage?.content) {
        try {
          const prefixRange = document.createRange();
          prefixRange.setStart(container, 0);
          prefixRange.setEnd(range.startContainer, range.startOffset);
          const prefixText = prefixRange.toString();
          // bodyStart skips frontmatter — add it so selectionOccurrence sees
          // the right absolute position within the markdown string.
          startOffsetHint =
            commentAnchorBodyStart(documentPage.content) + prefixText.length;
        } catch {
          startOffsetHint = null;
        }
      }

      setGuestSelectionText(text);
      setGuestSelectionRect(range.getBoundingClientRect());
      setGuestSelectionStartOffset(startOffsetHint);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [readOnly, publicCommentsEnabled, documentPage?.content]);

  // Guest comment form state
  const [guestForm, setGuestForm] = useState<{
    mode: "new" | "reply";
    parentId?: string;
    selectedText?: string;
    /** Markdown byte offset of the selection start, used for occurrence counting. */
    selectionStartOffset?: number;
    text: string;
    authorName: string;
    submitting: boolean;
    error: string | null;
  } | null>(null);

  const openGuestCommentForm = useCallback(
    (selectedText: string, selectionStartOffset: number | null) => {
      setGuestForm({
        mode: "new",
        selectedText,
        selectionStartOffset: selectionStartOffset ?? undefined,
        text: "",
        authorName: getGuestName(),
        submitting: false,
        error: null,
      });
      // Clear selection so button hides
      setGuestSelectionText(null);
      setGuestSelectionRect(null);
      setGuestSelectionStartOffset(null);
    },
    [],
  );

  const openGuestReplyForm = useCallback((parentId: string) => {
    setGuestForm({
      mode: "reply",
      parentId,
      text: "",
      authorName: getGuestName(),
      submitting: false,
      error: null,
    });
  }, []);

  const submitGuestComment = useCallback(async () => {
    if (!guestForm || !backend || !publicCommentsEnabled) return;

    const authorName = guestForm.authorName.trim();
    if (!authorName) {
      setGuestForm((f) => (f ? { ...f, error: "Please enter your name." } : f));
      return;
    }
    const text = guestForm.text.trim();
    if (!text) {
      setGuestForm((f) => (f ? { ...f, error: "Please enter a comment." } : f));
      return;
    }

    setGuestName(authorName);
    setGuestForm((f) => (f ? { ...f, submitting: true, error: null } : f));

    try {
      const publicBackend = backend as PublicBackend;

      let anchor: { quote: string; occurrence: number } | undefined;
      if (guestForm.mode === "new" && guestForm.selectedText) {
        const quote = guestForm.selectedText;
        const content = documentPage?.content ?? "";
        // Use the shared helper to find which plain-text, in-body occurrence
        // of `quote` the user selected.  selectionStartOffset is the markdown
        // byte position of the selection start captured at selection time.
        const occurrence =
          guestForm.selectionStartOffset != null
            ? selectionOccurrence(
                content,
                quote,
                guestForm.selectionStartOffset,
              )
            : 1;
        anchor = { quote, occurrence };
      }

      const refreshedPage = await publicBackend.addComment({
        mode: guestForm.mode,
        text,
        authorName,
        anchor,
        parentId: guestForm.parentId,
      });

      onDocumentPageChange?.(refreshedPage);
      setGuestForm(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to submit comment.";
      setGuestForm((f) =>
        f ? { ...f, submitting: false, error: message } : f,
      );
    }
  }, [
    backend,
    documentPage?.content,
    guestForm,
    onDocumentPageChange,
    publicCommentsEnabled,
  ]);

  const cancelGuestComment = useCallback(() => {
    setGuestForm(null);
  }, []);

  // ---------------------------------------------------------------------------

  useEffect(() => {
    const documentIdentity = `${activeDocumentPath ?? ""}:${documentPage?.id ?? ""}`;
    if (!documentIdentity) return;
    setReviewHandoffState("idle");
  }, [activeDocumentPath, documentPage?.id]);

  useEffect(() => {
    if (!backend?.getReviewWatchStatus || !activeDocumentPath) {
      setReviewWatcherCount(0);
      return;
    }

    let cancelled = false;
    const refreshWatchStatus = async () => {
      try {
        const status = await backend.getReviewWatchStatus?.(activeDocumentPath);
        if (!cancelled) {
          setReviewWatcherCount(status?.watcherCount ?? 0);
        }
      } catch {
        if (!cancelled) {
          setReviewWatcherCount(0);
        }
      }
    };

    void refreshWatchStatus();
    const interval = window.setInterval(refreshWatchStatus, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeDocumentPath, backend]);

  useEffect(() => {
    if (reviewHandoffState === "undelivered" && reviewWatcherCount > 0) {
      setReviewHandoffState("idle");
      return;
    }

    if (reviewHandoffState !== "notified") {
      sawNoWatcherAfterNotifiedRef.current = false;
      return;
    }

    if (reviewWatcherCount === 0) {
      sawNoWatcherAfterNotifiedRef.current = true;
      return;
    }

    if (sawNoWatcherAfterNotifiedRef.current) {
      sawNoWatcherAfterNotifiedRef.current = false;
      setReviewHandoffState("idle");
    }
  }, [reviewHandoffState, reviewWatcherCount]);

  useEffect(() => {
    if (!documentPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey;

      if (!isSaveShortcut) return;

      event.preventDefault();
      event.stopPropagation();

      if (documentDiskChangeState !== "clean") return;

      void documentSession.getSnapshot().saveController?.flushSave();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [documentDiskChangeState, documentPage, documentSession]);

  const handleCompleteReview = useCallback(
    async (options?: CompleteReviewOptions) => {
      if (!activeDocumentPath || reviewHandoffState === "notifying") return;

      setReviewHandoffState("notifying");
      try {
        // The button stays enabled while autosave is still pending, so make
        // sure any debounced edits are persisted before handing off.
        const flushResult = await documentSession
          .getSnapshot()
          .saveController?.flushSave();
        if (flushResult && flushResult.status === "error") {
          throw flushResult.error;
        }

        const result = await onCompleteReview(options);
        if (result.delivered) {
          setReviewWatcherCount(0);
          setReviewHandoffState("notified");
          setOverallComment("");
          setReviewHandoffPopoverOpen(true);
        } else {
          setReviewWatcherCount(0);
          setReviewHandoffState("undelivered");
          setReviewHandoffPopoverOpen(true);
        }
      } catch (error) {
        console.error("Failed to complete review:", error);
        setReviewHandoffState("error");
        setReviewHandoffPopoverOpen(true);
      }
    },
    [activeDocumentPath, documentSession, onCompleteReview, reviewHandoffState],
  );

  const handleCopyFileMenuAction = useCallback(
    async (action: FileCopyAction) => {
      if (!documentPage) return;

      const copyTextByAction: Record<
        Exclude<FileCopyAction, "rich-text">,
        string
      > = {
        path: activeDocumentPath ?? documentFilenameLabel,
        filename: documentFilenameLabel,
        markdown: documentPage.content,
      };

      try {
        if (action === "rich-text") {
          await writeRichTextToClipboard(documentPage.content);
        } else {
          await writePlainTextToClipboard(copyTextByAction[action]);
        }

        setCopiedFileAction(action);
        window.setTimeout(() => setCopiedFileAction(null), 1400);
        setFileCopyMenuOpen(false);
      } catch (error) {
        console.error("Failed to copy document data:", error);
      }
    },
    [activeDocumentPath, documentFilenameLabel, documentPage],
  );

  const editorViewModeToggleLabel =
    documentEditorViewMode === "rich-text"
      ? "Switch to code view"
      : "Switch to rich text view";
  const commentsToggleLabel = commentsHidden
    ? "Show comments"
    : "Hide comments";
  const agentBoxToggleLabel = agentBoxHidden
    ? "Show agent box"
    : "Hide agent box";
  const proposeChangesToggleLabel = proposeChanges
    ? "Propose changes: on — saving opens a pull request"
    : "Propose changes: off — saving commits to the branch";
  const activeDocumentInteractionMode = documentInteractionModeOptions.find(
    (option) => option.value === documentInteractionMode,
  );
  const ActiveDocumentInteractionModeIcon =
    activeDocumentInteractionMode?.Icon ?? PencilLine;
  const conflictNotice =
    documentDiskChangeState === "clean"
      ? null
      : conflictNoticeCopy[documentDiskChangeState];
  const showReviewHandoffButton =
    !!activeDocumentPath &&
    (reviewWatcherCount > 0 || reviewHandoffState !== "idle");
  const reviewHandoffButtonLabel =
    reviewHandoffState === "notifying"
      ? "Sending"
      : reviewHandoffState === "notified"
        ? "Sent"
        : reviewHandoffState === "error" || reviewHandoffState === "undelivered"
          ? "Not sent"
          : "I'm done";
  const ReviewHandoffButtonIcon =
    reviewHandoffState === "notifying"
      ? Loader2
      : reviewHandoffState === "error" || reviewHandoffState === "undelivered"
        ? AlertTriangle
        : null;
  const reviewHandoffStatusTitle =
    reviewHandoffState === "undelivered"
      ? "No agent is watching now"
      : reviewHandoffState === "error"
        ? "Could not notify agent"
        : "Your agent is now working";
  const reviewHandoffStatusBody =
    reviewHandoffState === "undelivered"
      ? "The handoff was not delivered because the watcher is no longer connected."
      : reviewHandoffState === "error"
        ? "Roughdraft could not send the handoff. Check that the local server is still running."
        : "It will take the appropriate next action, including replying to comments, questions, and suggestions, and/or directly editing the doc.";
  const reviewHandoffDisabled = isReviewHandoffDisabled({
    saveState,
    documentDiskChangeState,
    reviewHandoffState,
  });
  const trimmedOverallComment = overallComment.trim();

  // Build GitHub breadcrumb data when githubNav is present
  const githubBreadcrumb = githubNav
    ? (() => {
        const { owner, repo, branch, path } = githubNav;
        const repoPart = `${owner}/${repo}`;
        const pathParts = path.split("/");
        const filename = pathParts[pathParts.length - 1] ?? path;
        const folderSegments = pathParts.slice(0, -1); // all but last

        type BreadcrumbSegment =
          | { kind: "repo"; label: string; href: string }
          | { kind: "folder"; label: string; href: string }
          | { kind: "file"; label: string };

        const segments: BreadcrumbSegment[] = [
          {
            kind: "repo",
            label: repoPart,
            href: gitHubHref({ owner, repo, branch }),
          },
          ...folderSegments.map(
            (seg, i): BreadcrumbSegment => ({
              kind: "folder",
              label: seg,
              href: gitHubHref({
                owner,
                repo,
                branch,
                path: folderSegments.slice(0, i + 1).join("/"),
              }),
            }),
          ),
          { kind: "file", label: filename },
        ];

        return segments;
      })()
    : null;

  // Intercept plain left-clicks on breadcrumb links for SPA navigation, but
  // leave modified clicks (new tab / new window / download) to the browser so
  // the `href` still works for open-in-new-tab and middle-click.
  const handleBreadcrumbClick = (
    event: ReactMouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (
      !onNavigate ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };

  return (
    <div
      data-document-scroller
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-8 pb-8 sm:px-12",
        conflictNotice ? "pt-40 sm:pt-28" : "pt-10",
      )}
    >
      {/* GitHub breadcrumb bar — above everything, only in GitHub mode */}
      {githubBreadcrumb ? (
        <div
          data-print-hide
          className="mb-3 -mx-8 sm:-mx-12 px-8 sm:px-12 border-b border-slate-100 dark:border-slate-800 pb-2.5"
        >
          <nav
            aria-label="Document breadcrumb"
            className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs text-stone-400 dark:text-stone-500"
          >
            {githubBreadcrumb.map((seg, i) => (
              <span key={i} className="flex min-w-0 items-center gap-0.5">
                {i > 0 ? (
                  <ChevronRight
                    className="size-3 shrink-0 text-stone-300 dark:text-stone-600"
                    aria-hidden="true"
                  />
                ) : null}
                {seg.kind === "repo" ? (
                  <a
                    href={seg.href}
                    onClick={(event) => handleBreadcrumbClick(event, seg.href)}
                    className="font-die-grotesk-a inline-flex items-center gap-1 rounded px-1 py-0.5 font-bold text-stone-500 dark:text-stone-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-slate-700 dark:hover:text-slate-300"
                  >
                    <ArrowLeft className="size-3 shrink-0" aria-hidden="true" />
                    {seg.label}
                  </a>
                ) : seg.kind === "folder" ? (
                  <a
                    href={seg.href}
                    onClick={(event) => handleBreadcrumbClick(event, seg.href)}
                    className="rounded px-1 py-0.5 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-slate-700 dark:hover:text-slate-300"
                  >
                    {seg.label}
                  </a>
                ) : (
                  <span className="truncate px-1 py-0.5 font-medium text-slate-600 dark:text-slate-300">
                    {seg.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        </div>
      ) : null}
      <RemoteSessionBanner backend={backend} />
      {/* Prominent, always-visible commit action so it isn't missed on scroll. */}
      {manualCommit && saveState !== "saved" ? (
        <Button
          type="button"
          data-testid="github-commit-button"
          size="lg"
          disabled={saveState === "saving"}
          onClick={() =>
            void documentSession.getSnapshot().saveController?.flushSave()
          }
          className="fixed bottom-6 left-1/2 z-[80] h-12 -translate-x-1/2 gap-2 rounded-full border-0 bg-emerald-600 px-6 text-base font-semibold text-white shadow-[0_14px_36px_rgba(5,150,105,0.45)] hover:bg-emerald-700 focus-visible:ring-emerald-300/60"
        >
          {saveState === "saving" ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {proposeChanges ? "Proposing…" : "Committing…"}
            </>
          ) : (
            <>
              {proposeChanges ? "Propose changes" : "Commit changes"}
              <kbd className="rounded bg-white/20 px-1.5 py-0.5 font-sans text-xs font-medium text-white/90">
                {commitShortcutHint}
              </kbd>
            </>
          )}
        </Button>
      ) : null}
      <div
        className={cn(
          "fixed right-3 z-[60] flex max-w-[min(16rem,calc(100vw-1rem))] flex-col items-end gap-1.5",
          conflictNotice ? "top-[19rem] sm:top-[7rem]" : "top-3",
        )}
        data-testid="document-status-stack"
        data-document-status-stack="true"
      >
        <div className="flex max-w-full items-center justify-end gap-1.5">
          {showReviewHandoffButton ? (
            <Popover
              open={reviewHandoffPopoverOpen}
              onOpenChange={setReviewHandoffPopoverOpen}
            >
              <div className="relative flex items-center overflow-hidden rounded-[7px] shadow-[0_10px_28px_rgba(0,0,0,0.18)] after:pointer-events-none after:absolute after:top-px after:right-8 after:bottom-px after:z-10 after:w-px after:bg-[#444] after:content-[''] dark:after:bg-[#444]">
                <Button
                  type="button"
                  data-testid="review-handoff-button"
                  size="lg"
                  className="h-9 rounded-r-none rounded-l-[7px] border-0 bg-black px-3 text-sm font-bold text-white hover:bg-black/85 focus-visible:ring-black/25 dark:bg-black dark:text-white dark:hover:bg-black/85 dark:focus-visible:ring-white/30"
                  disabled={reviewHandoffDisabled}
                  onClick={() =>
                    void handleCompleteReview(
                      trimmedOverallComment
                        ? { overallComment: trimmedOverallComment }
                        : undefined,
                    )
                  }
                >
                  {ReviewHandoffButtonIcon ? (
                    <ReviewHandoffButtonIcon
                      className={cn(
                        "size-4",
                        reviewHandoffState === "notifying" && "animate-spin",
                      )}
                    />
                  ) : null}
                  {reviewHandoffButtonLabel}
                </Button>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      data-testid="review-handoff-comment-trigger"
                      size="icon-lg"
                      className="h-9 w-8 rounded-l-none rounded-r-[7px] border-0 bg-black text-white hover:bg-black/85 focus-visible:ring-black/25 dark:bg-black dark:text-white dark:hover:bg-black/85 dark:focus-visible:ring-white/30"
                      disabled={reviewHandoffDisabled}
                      aria-label="Add overall handoff comment"
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                  }
                />
              </div>
              <PopoverContent
                aria-label={
                  reviewHandoffState === "idle"
                    ? "Review handoff comment"
                    : "Review handoff status"
                }
                data-testid={
                  reviewHandoffState === "idle"
                    ? "review-handoff-comment-popover"
                    : "review-handoff-status"
                }
              >
                {reviewHandoffState === "idle" ? (
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleCompleteReview({
                        overallComment: trimmedOverallComment,
                      });
                    }}
                  >
                    <div>
                      <Textarea
                        id="review-handoff-overall-comment"
                        data-testid="review-handoff-overall-comment"
                        aria-label="Overall comment"
                        placeholder="Overall comment"
                        value={overallComment}
                        onChange={(event) =>
                          setOverallComment(event.currentTarget.value)
                        }
                        maxLength={4000}
                        rows={4}
                        className="min-h-24 resize-y"
                      />
                    </div>
                    <Button
                      type="submit"
                      data-testid="review-handoff-submit-comment"
                      size="lg"
                      className="w-full rounded-[7px] bg-black text-sm font-bold text-white hover:bg-black/85 focus-visible:ring-black/25 dark:bg-white dark:text-black dark:hover:bg-white/90"
                      disabled={!trimmedOverallComment}
                    >
                      <CheckCheck className="size-4" />
                      Submit with comment
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                      {reviewHandoffState === "notifying" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : reviewHandoffState === "error" ||
                        reviewHandoffState === "undelivered" ? (
                        <AlertTriangle className="size-4" />
                      ) : (
                        <CheckCheck className="size-4" />
                      )}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-stone-950 dark:text-slate-50">
                        {reviewHandoffStatusTitle}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-slate-300">
                        {reviewHandoffStatusBody}
                      </p>
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {conflictNotice ? (
        <div
          data-testid="file-conflict-notice"
          role="status"
          aria-label="File conflict"
          className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-3 text-amber-950 dark:text-amber-100 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)] sm:px-4"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-5">
                  {conflictNotice.title}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
                  {conflictNotice.body}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                type="button"
                data-testid="file-conflict-action-reload"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                onClick={() => void onReloadDocumentFromDisk()}
              >
                <RefreshCcw className="size-3.5" />
                Reload from disk
              </Button>
              {documentDiskChangeState !== "paused" ? (
                <Button
                  type="button"
                  data-testid="file-conflict-action-keep-editing"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                  onClick={onKeepEditingWithoutAutosave}
                >
                  <PencilLine className="size-3.5" />
                  Keep editing with autosave paused
                </Button>
              ) : null}
              <Button
                type="button"
                data-testid="file-conflict-action-overwrite"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-amber-900 dark:bg-amber-600 px-2 text-xs text-white hover:bg-amber-800 dark:hover:bg-amber-500"
                onClick={() => {
                  // Persist any deferred serialization into the draft before
                  // overwrite reads it from the session store, so we push the
                  // latest edits to disk.
                  documentSession.getSnapshot().saveController?.flushDraft();
                  void onOverwriteDocumentOnDisk();
                }}
              >
                <Upload className="size-3.5" />
                Overwrite disk file
              </Button>
            </div>
          </div>
          {documentActionError ? (
            <div
              data-testid="document-action-error"
              role="alert"
              className="flex items-start justify-between gap-2.5 rounded-[7px] border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 px-2.5 py-2 text-xs leading-5 text-red-800 dark:text-red-200"
            >
              <span className="min-w-0">{documentActionError}</span>
              {onDismissDocumentActionError ? (
                <button
                  type="button"
                  data-testid="document-action-error-dismiss"
                  className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
                  onClick={onDismissDocumentActionError}
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {!conflictNotice && documentActionError ? (
        <div
          data-testid="document-action-error"
          role="alert"
          className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 items-start justify-between gap-2.5 rounded-[8px] border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-3 py-3 text-xs leading-5 text-red-800 dark:text-red-200 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)] sm:px-4"
        >
          <span className="min-w-0">{documentActionError}</span>
          {onDismissDocumentActionError ? (
            <button
              type="button"
              data-testid="document-action-error-dismiss"
              className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
              onClick={onDismissDocumentActionError}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Guest comment floating button — shown on text selection in public view */}
      {publicCommentsEnabled &&
      guestSelectionText &&
      guestSelectionRect &&
      !guestForm ? (
        <button
          type="button"
          data-testid="guest-add-comment-button"
          className="fixed z-50 inline-flex items-center gap-1.5 rounded-full border border-stone-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-stone-700 dark:text-stone-300 shadow-md transition hover:bg-stone-50 dark:hover:bg-slate-700"
          style={{
            top: Math.max(8, guestSelectionRect.top + window.scrollY - 40),
            left: Math.max(
              8,
              guestSelectionRect.left +
                window.scrollX +
                guestSelectionRect.width / 2 -
                60,
            ),
          }}
          onMouseDown={(e) => {
            // Prevent blur from clearing selection before we capture it
            e.preventDefault();
          }}
          onClick={() => {
            if (guestSelectionText)
              openGuestCommentForm(
                guestSelectionText,
                guestSelectionStartOffset,
              );
          }}
        >
          <MessageSquarePlus className="size-3.5" />
          Leave a comment
        </button>
      ) : null}

      {/* Guest comment form overlay */}
      {guestForm ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) cancelGuestComment();
          }}
        >
          <div className="w-full max-w-sm rounded-xl border border-stone-200 dark:border-slate-600 bg-white dark:bg-slate-900 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
            <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
              {guestForm.mode === "reply"
                ? "Reply to comment"
                : "Leave a comment"}
            </h2>
            {guestForm.mode === "new" && guestForm.selectedText ? (
              <p className="mb-3 rounded-md bg-stone-50 dark:bg-slate-800 px-3 py-2 text-xs italic text-stone-600 dark:text-stone-400 line-clamp-2">
                "{guestForm.selectedText}"
              </p>
            ) : null}
            <label
              htmlFor="guest-name-input"
              className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Your name
            </label>
            <input
              id="guest-name-input"
              type="text"
              data-testid="guest-name-input"
              className="mb-3 w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 outline-none transition focus:border-emerald-300 dark:focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900"
              placeholder="Name"
              value={guestForm.authorName}
              onChange={(e) =>
                setGuestForm((f) =>
                  f ? { ...f, authorName: e.target.value } : f,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <label
              htmlFor="guest-comment-textarea"
              className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Comment
            </label>
            <Textarea
              id="guest-comment-textarea"
              data-testid="guest-comment-textarea"
              value={guestForm.text}
              rows={3}
              className="mb-3 min-h-16 text-sm leading-6"
              placeholder={
                guestForm.mode === "reply"
                  ? "Write a reply…"
                  : "Write a comment…"
              }
              onChange={(e) =>
                setGuestForm((f) => (f ? { ...f, text: e.target.value } : f))
              }
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key.toLowerCase() === "enter"
                ) {
                  e.preventDefault();
                  void submitGuestComment();
                }
              }}
            />
            {guestForm.error ? (
              <p
                role="alert"
                data-testid="guest-comment-error"
                className="mb-3 text-xs text-red-600 dark:text-red-400"
              >
                {guestForm.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="guest-comment-cancel"
                className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-stone-600 dark:text-stone-400 transition hover:bg-stone-100 dark:hover:bg-slate-700"
                onClick={cancelGuestComment}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="guest-comment-submit"
                disabled={guestForm.submitting}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 dark:bg-emerald-700 px-3 text-sm font-medium text-white transition hover:bg-emerald-700 dark:hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void submitGuestComment()}
              >
                {guestForm.submitting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {guestForm.mode === "reply" ? "Reply" : "Comment"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div ref={publicDocAreaRef} className="mx-auto min-h-full max-w-[1280px]">
        {documentPage ? (
          <div
            data-testid="document-page-header"
            data-print-hide
            className={cn(
              "document-page-shell mb-2 flex flex-col gap-6 text-[0.62rem] font-medium tracking-[0.01em] text-stone-400 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,46.5rem)_minmax(24rem,1fr)] min-[1100px]:items-start min-[1100px]:justify-between min-[1100px]:gap-8",
              !documentHasComments &&
                "document-page-shell-no-comments min-[1100px]:grid-cols-[minmax(0,46.5rem)] min-[1100px]:justify-center",
            )}
          >
            <div className="document-page-main w-full max-w-[56rem] min-w-0">
              <div className="flex w-full flex-wrap items-center gap-1.5 px-1">
                {isMarkdownDoc ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-testid="document-editor-view-toggle"
                          className="grid shrink-0 grid-cols-2 rounded-[999px] bg-[#E8E3DB] dark:bg-slate-700 px-[2px] pt-[3px] pb-[2px] shadow-[inset_0_1px_0_rgba(255,251,245,0.72)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                        >
                          <span
                            className={`flex w-[1.375rem] items-center justify-center rounded-full py-[2px] transition ${
                              documentEditorViewMode === "rich-text"
                                ? "bg-[#FFFDFC] dark:bg-slate-500 text-stone-700 dark:text-white shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                                : "text-stone-500 dark:text-slate-400"
                            }`}
                          >
                            <Eye className="size-[0.75rem]" />
                          </span>
                          <span
                            className={`flex w-[1.375rem] items-center justify-center rounded-full py-[2px] transition ${
                              documentEditorViewMode === "code"
                                ? "bg-[#FFFDFC] dark:bg-slate-500 text-stone-700 dark:text-white shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                                : "text-stone-500 dark:text-slate-400"
                            }`}
                          >
                            <CodeXml className="size-[0.75rem]" />
                          </span>
                        </button>
                      }
                      aria-label={editorViewModeToggleLabel}
                      onClick={() => {
                        // Leaving the rich-text editor: serialize the latest
                        // edits into the draft so the code view opens with them
                        // (rich-text serialization is otherwise deferred to save).
                        if (documentEditorViewMode === "rich-text") {
                          documentSession
                            .getSnapshot()
                            .saveController?.flushDraft();
                        }
                        onDocumentEditorViewModeChange(
                          documentEditorViewMode === "rich-text"
                            ? "code"
                            : "rich-text",
                        );
                      }}
                    />
                    <TooltipContent>{editorViewModeToggleLabel}</TooltipContent>
                  </Tooltip>
                ) : null}
                <Popover
                  open={fileCopyMenuOpen}
                  onOpenChange={setFileCopyMenuOpen}
                >
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        data-testid="document-file-menu-trigger"
                        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1 py-0.5 font-mono text-[0.7rem] tracking-[0.01em] text-stone-400 outline-none transition hover:bg-[#EEE9E1] hover:text-stone-600 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300 dark:focus-visible:ring-slate-600/70"
                        title={documentFilenameLabel}
                        aria-label="Document file actions"
                      >
                        <span className="min-w-0 truncate">
                          {documentFilenameLabel}
                        </span>
                        <ChevronDown
                          className="size-[0.62rem] shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    }
                  />
                  <PopoverContent
                    aria-label="Document file actions"
                    data-testid="document-file-menu"
                    className="w-44 p-1"
                    align="start"
                  >
                    <div className="flex flex-col">
                      {fileCopyMenuOptions.map(({ action, label }) => (
                        <button
                          key={action}
                          type="button"
                          data-testid={`document-file-menu-${action}`}
                          className="flex h-8 items-center justify-between rounded-md px-2 text-left text-[0.72rem] leading-none text-stone-700 outline-none transition hover:bg-[#EEE9E1] focus-visible:bg-[#EEE9E1] dark:text-stone-300 dark:hover:bg-slate-700 dark:focus-visible:bg-slate-700"
                          onClick={() => void handleCopyFileMenuAction(action)}
                        >
                          <span>{label}</span>
                          {copiedFileAction === action ? (
                            <Check className="size-3 text-stone-500 dark:text-stone-400" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                {/* In GitHub (manual-commit) mode the doc rests in the "unsaved"
                    state until the user commits, and this indicator spins on
                    "unsaved" — so the Commit button conveys status instead. */}
                {manualCommit ? null : (
                  <DocumentSaveStatusIndicator
                    saveState={saveState}
                    diskChangeState={documentDiskChangeState}
                  />
                )}
                {readOnly ? (
                  <span className="ml-auto font-mono text-[0.7rem] text-stone-400 dark:text-stone-500">
                    Public · read-only
                  </span>
                ) : (
                  <div className="ml-auto inline-flex h-[1.5rem] shrink-0 items-center gap-1">
                    {backend?.capabilities.activityLog && activeDocumentPath ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              data-testid="document-agent-box-toggle"
                              aria-pressed={agentBoxHidden}
                              className="inline-flex h-[1.5rem] items-center justify-center rounded-full px-1 text-stone-400 outline-none transition hover:bg-[#EEE9E1] hover:text-stone-600 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300 dark:focus-visible:ring-slate-600/70"
                            >
                              <Bot className="size-[0.78rem]" />
                            </button>
                          }
                          aria-label={agentBoxToggleLabel}
                          onClick={() => setAgentBoxHidden((hidden) => !hidden)}
                        />
                        <TooltipContent>{agentBoxToggleLabel}</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {canViewHistory ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              data-testid="document-history-toggle"
                              className="inline-flex h-[1.5rem] items-center justify-center rounded-full px-1 text-stone-400 outline-none transition hover:bg-[#EEE9E1] hover:text-stone-600 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300 dark:focus-visible:ring-slate-600/70"
                            >
                              <History className="size-[0.78rem]" />
                            </button>
                          }
                          aria-label="File history"
                          onClick={() => setHistoryOpen(true)}
                        />
                        <TooltipContent>File history</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {isMarkdownDoc ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              data-testid="document-print-button"
                              className="inline-flex h-[1.5rem] items-center justify-center rounded-full px-1 text-stone-400 outline-none transition hover:bg-[#EEE9E1] hover:text-stone-600 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300 dark:focus-visible:ring-slate-600/70"
                            >
                              <Printer className="size-[0.78rem]" />
                            </button>
                          }
                          aria-label="Export as PDF"
                          onClick={printDocument}
                        />
                        <TooltipContent>Export as PDF</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {isMarkdownDoc ? (
                      <>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                data-testid="document-comments-toggle"
                                aria-pressed={commentsHidden}
                                className="inline-flex h-[1.5rem] items-center justify-center rounded-full px-1 text-stone-400 outline-none transition hover:bg-[#EEE9E1] hover:text-stone-600 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300 dark:focus-visible:ring-slate-600/70"
                              >
                                {commentsHidden ? (
                                  <EyeOff className="size-[0.78rem]" />
                                ) : (
                                  <MessageSquarePlus className="size-[0.78rem]" />
                                )}
                              </button>
                            }
                            aria-label={commentsToggleLabel}
                            onClick={() =>
                              setCommentsHidden((hidden) => !hidden)
                            }
                          />
                          <TooltipContent>{commentsToggleLabel}</TooltipContent>
                        </Tooltip>
                        <Select<DocumentInteractionMode>
                          value={documentInteractionMode}
                          onValueChange={(value) => {
                            if (value) setDocumentInteractionMode(value);
                          }}
                        >
                          <SelectTrigger
                            data-testid="document-mode-trigger"
                            aria-label="Document mode"
                            className="h-[1.5rem] px-1 font-mono text-[0.7rem] leading-[1.25rem] font-normal tracking-[0.01em] text-stone-400 dark:text-stone-500 hover:text-stone-500 dark:hover:text-stone-400"
                          >
                            <ActiveDocumentInteractionModeIcon className="size-[0.68rem]" />
                            <span className="truncate">
                              {activeDocumentInteractionMode?.label}
                            </span>
                          </SelectTrigger>
                          <SelectContent>
                            {documentInteractionModeOptions.map(
                              ({ value, label, Icon }) => (
                                <SelectItem
                                  key={value}
                                  value={value}
                                  label={label}
                                >
                                  <Icon className="size-3 text-stone-500 dark:text-stone-400" />
                                  <SelectItemText>{label}</SelectItemText>
                                </SelectItem>
                              ),
                            )}
                          </SelectContent>
                        </Select>
                      </>
                    ) : null}
                    {canProposeChanges && manualCommit && canEdit ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              data-testid="propose-changes-toggle"
                              aria-pressed={proposeChanges}
                              className={cn(
                                "inline-flex h-[1.5rem] items-center justify-center gap-1 rounded-full px-1.5 font-mono text-[0.7rem] outline-none transition focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:focus-visible:ring-slate-600/70",
                                proposeChanges
                                  ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300"
                                  : "text-stone-400 hover:bg-[#EEE9E1] hover:text-stone-600 dark:text-stone-500 dark:hover:bg-slate-800 dark:hover:text-stone-300",
                              )}
                            >
                              <GitPullRequest className="size-[0.78rem]" />
                              {proposeChanges ? "PR" : null}
                            </button>
                          }
                          aria-label={proposeChangesToggleLabel}
                          onClick={() =>
                            onProposeChangesChange?.(!proposeChanges)
                          }
                        />
                        <TooltipContent>
                          {proposeChangesToggleLabel}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                    {backend?.info.kind === "github" ? (
                      <SharePopover
                        canEdit={canEdit}
                        shareUrl={shareUrl}
                        content={documentPage?.content ?? ""}
                        onSetPublic={onSetPublic}
                        onSetComments={onSetComments}
                        open={shareOpen}
                        onOpenChange={setShareOpen}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            </div>
            {documentHasComments ? (
              <div
                className="document-comment-rail pointer-events-none invisible hidden min-[1100px]:block"
                aria-hidden="true"
                data-print-hide
              />
            ) : null}
          </div>
        ) : null}
        {documentPage ? (
          backend ? (
            <>
              {backend?.capabilities.activityLog &&
              activeDocumentPath &&
              !agentBoxHidden ? (
                <div className="mb-4" data-print-hide>
                  <InstructionSender
                    docPath={activeDocumentPath}
                    author={backend.info.authorLabel ?? "you"}
                    readActivityLog={(p) => backend.readActivityLog(p)}
                    appendActivityEntry={(p, entry) =>
                      backend.appendActivityEntry(p, entry)
                    }
                    liveEntries={liveActivityEntries ?? undefined}
                  />
                </div>
              ) : null}
              <PageCard
                key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
                page={documentPage}
                activeDocumentPath={activeDocumentPath}
                selected
                onSave={onSaveDocument}
                onSaveStateChange={documentSession.setSaveState}
                editorViewMode={effectiveEditorViewMode}
                interactionMode={effectiveInteractionMode}
                commentsHidden={commentsHidden}
                backend={backend}
                onCommentRailPresenceChange={setDocumentHasComments}
                onDirtyStateChange={documentSession.setDirty}
                onComposingCommentChange={documentSession.setComposing}
                onLocalContentChange={documentSession.setDraftContent}
                onSaveControllerChange={documentSession.setController}
                saveBlocked={documentDiskChangeState !== "clean"}
                forceResetKey={documentForceResetKey}
                manualCommit={manualCommit}
                onPublicReply={
                  publicCommentsEnabled ? openGuestReplyForm : undefined
                }
              />
              <MermaidOverlays
                key={`mermaid:${documentPage.id}:${activeDocumentPath ?? ""}`}
              />
            </>
          ) : null
        ) : (
          <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Open a file to begin.
          </div>
        )}
        {historyOpen &&
        activeDocumentPath &&
        backend?.listFileHistory &&
        backend.readFileAtRef ? (
          <FileHistoryDialog
            path={activeDocumentPath}
            currentContent={documentPage?.content ?? ""}
            listFileHistory={backend.listFileHistory.bind(backend)}
            readFileAtRef={backend.readFileAtRef.bind(backend)}
            commitUrl={backend.commitUrl?.bind(backend)}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={palettePage === null ? paletteRootCommands : palettePageItems}
        onRun={runPaletteCommand}
        onBack={palettePage === null ? undefined : popPalettePage}
        loading={palettePageLoading}
        emptyMessage={
          palettePageError ??
          (palettePage === "branches"
            ? "No branches found."
            : palettePage === "repos"
              ? "No repositories found."
              : "No matching commands.")
        }
        hideGroupsWhenEmpty={PALETTE_HIDDEN_GROUPS}
        placeholder={
          palettePage === "branches"
            ? "Switch to branch…"
            : palettePage === "repos"
              ? "Switch to repository…"
              : "Type a command or search files…"
        }
      />
    </div>
  );
}
