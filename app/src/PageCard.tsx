import type { JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { relativeAssetRef, resolveRepoAssetPath } from "./asset-path";
import { CommentEditorList } from "./CommentEditorList";
import { alignElementToTarget } from "./comment-scroll";
import { shouldShowReviewRail } from "./comment-visibility";
import {
  type CriticChangeAttrs,
  type CriticComment,
  createCriticChange,
  createCriticComment,
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
  markdownEquivalent,
} from "./critic-markup";
import {
  type CriticChangeRailItem,
  DocumentReviewRail,
} from "./DocumentReviewRail";
import {
  getPreferredCommentId,
  getRootThreadIdForCommentId,
  parseCommentIds,
} from "./document-comments";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  commentHighlightPluginKey,
  createEditorExtensions,
  criticChangeHighlightPluginKey,
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";
import { cn } from "./lib/utils";
import { type MarkdownOptions, toHtml } from "./markdown";
import { runWithErrorFeedback } from "./run-with-error-feedback";
import type { Page, StorageBackend } from "./storage";
import {
  buildSuggestionDeleteTransaction,
  buildSuggestionInputTransaction,
  buildSuggestionMarkAdditionTransaction,
  computeKeyboardDeleteRange,
} from "./suggesting-mode";
import { useCommentAnchorLayout } from "./useCommentAnchorLayout";

// CodeMirror is only needed for the opt-in code view, so load it lazily to
// keep it out of the initial bundle (see PERF-2).
const MarkdownCodeEditor = lazy(() =>
  import("./MarkdownCodeEditor").then((module) => ({
    default: module.MarkdownCodeEditor,
  })),
);

export type DocumentSaveState = "saved" | "unsaved" | "saving" | "error";

export type ManualSaveResult =
  | { status: "saved" }
  | { status: "blocked" }
  | { status: "error"; error: unknown };

export interface DocumentSaveController {
  flushSave: () => Promise<ManualSaveResult>;
  // Serialize the live editor content into the pending draft (and notify via
  // onLocalContentChange) without triggering a network save. Used before reads
  // that persist the draft directly — e.g. overwrite-on-disk — so a debounced
  // serialization can't leak stale content.
  flushDraft: () => void;
}

// Stable fallback so `PageCardEditorSurface` (which requires `onSaveStateChange`)
// can be rendered without a save-state consumer — e.g. the format demo — without
// breaking the memoized surface on every render.
const NOOP_SAVE_STATE_CHANGE = (): void => {};

type EditorViewMode = "rich-text" | "code";
export type DocumentInteractionMode = "viewing" | "suggesting" | "editing";

interface PageCardProps {
  page: Page;
  activeDocumentPath?: string | null;
  selected?: boolean;
  layout?: "default" | "embedded-demo";
  focusRequestKey?: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  editorViewMode?: EditorViewMode;
  interactionMode?: DocumentInteractionMode;
  commentsHidden?: boolean;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onComposingCommentChange?: (id: string, composing: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
  manualCommit?: boolean;
  /**
   * When provided in public (readOnly) viewing mode, called instead of the
   * editor-integrated replyToComment when the user clicks Reply on a thread.
   */
  onPublicReply?: (commentId: string) => void;
}

interface PageCardEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: DocumentSaveState) => void;
  editorViewMode: EditorViewMode;
  interactionMode: DocumentInteractionMode;
  commentsHidden: boolean;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onComposingCommentChange?: (id: string, composing: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
  manualCommit?: boolean;
  onPublicReply?: (commentId: string) => void;
}

interface RichTextEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  sourceMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
  interactionMode: DocumentInteractionMode;
  commentsHidden: boolean;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onComposingCommentChange?: (id: string, composing: boolean) => void;
  // Fired on every edit transaction — cheap signal that the document changed.
  onContentTouched?: () => void;
  // Registers a serializer the parent calls on demand (at save time) to get
  // the current document as critic markdown. Passing null clears it.
  onSerializeReady?: (serialize: (() => string | null) | null) => void;
  onPublicReply?: (commentId: string) => void;
}

interface CodeEditorSurfaceProps {
  markdown: string;
  /** Open document path/name — drives the code editor's syntax highlighting. */
  filePath: string | null;
  hasCommentRailSpace: boolean;
  interactionMode: DocumentInteractionMode;
  layout: "default" | "embedded-demo";
  onMarkdownChange: (markdown: string) => void;
}

export interface DraftSuggestionState {
  type: "insertion" | "replacement";
  from: number;
  to: number;
  sourceText: string;
  text: string;
}

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
}

function getSelectionCommentIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directAttributes = editor.getAttributes("commentRef").commentIds;

  if (Array.isArray(directAttributes) && directAttributes.length > 0) {
    return directAttributes;
  }

  const { from, to, empty, $from } = editor.state.selection;
  const commentIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "commentRef") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "commentRef") continue;

        for (const commentId of mark.attrs.commentIds ?? []) {
          commentIds.add(commentId);
        }
      }
    });
  }

  return [...commentIds];
}

function getSelectionCriticChangeIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directChangeId = editor.getAttributes("criticChange").changeId;

  if (typeof directChangeId === "string" && directChangeId.length > 0) {
    return [directChangeId];
  }

  const { from, to, empty, $from } = editor.state.selection;
  const changeIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId === "string") {
        changeIds.add(mark.attrs.changeId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "criticChange") continue;
        if (typeof mark.attrs.changeId === "string") {
          changeIds.add(mark.attrs.changeId);
        }
      }
    });
  }

  return [...changeIds];
}

function getPreferredCriticChangeId(
  changeIds: string[],
  currentChangeId: string | null,
): string | null {
  if (currentChangeId && changeIds.includes(currentChangeId)) {
    return currentChangeId;
  }

  return changeIds[0] ?? null;
}

function prefersReducedMotion(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

/** The rail card element for a comment thread (tagged with its root id). */
function findCommentCardElement(rootCommentId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(
    `[data-comment-root-id="${rootCommentId}"]`,
  );
}

function getBodyScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>("[data-document-scroller]");
}

function getRailScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>("[data-comment-rail-scroller]");
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    if (closed || !node.isText) return false;

    const hasCommentId = node.marks.some(
      (mark) =>
        mark.type === commentMarkType &&
        Array.isArray(mark.attrs.commentIds) &&
        mark.attrs.commentIds.includes(commentId),
    );

    if (!hasCommentId) {
      if (from != null && to != null && pos >= to) {
        closed = true;
      }
      return;
    }

    if (from == null || to == null) {
      from = pos;
      to = pos + node.nodeSize;
      return;
    }

    if (pos <= to) {
      to = pos + node.nodeSize;
      return;
    }

    closed = true;
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function findCommentAnchorElement(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    ".comment-anchor[data-comment-ids]",
  );

  return (
    [...anchors].find((anchor) =>
      parseCommentIds(anchor.dataset.commentIds).includes(commentId),
    ) ?? null
  );
}

function getAnchorCommentIds(
  editor: Editor | null,
  commentId: string,
): string[] {
  const anchorElement = findCommentAnchorElement(editor, commentId);
  if (!anchorElement) return [];
  return parseCommentIds(anchorElement.dataset.commentIds);
}

function addCommentIdsToAnchor(
  editor: Editor | null,
  anchorCommentId: string,
  commentIdsToAdd: string[],
): string[] | null {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  const anchorCommentIds = getAnchorCommentIds(editor, anchorCommentId);
  const nextCommentIds = [
    ...new Set([...anchorCommentIds, ...commentIdsToAdd]),
  ];
  if (!commentMarkType || anchorCommentIds.length === 0) return null;

  let found = false;
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === commentMarkType &&
        Array.isArray(candidate.attrs.commentIds) &&
        candidate.attrs.commentIds.includes(anchorCommentId),
    );

    if (!mark) return;

    found = true;

    const from = pos;
    const to = pos + node.nodeSize;
    tr.removeMark(from, to, commentMarkType);
    tr.addMark(
      from,
      to,
      commentMarkType.create({ ...mark.attrs, commentIds: nextCommentIds }),
    );
  });

  if (!found) return null;

  editor.view.dispatch(tr);
  return nextCommentIds;
}

function getDocumentCriticChanges(
  editor: Editor,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  const changes = new Map<string, Pick<CriticChangeAttrs, "changeId">>();

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId !== "string") continue;

      changes.set(mark.attrs.changeId, { changeId: mark.attrs.changeId });
    }
  });

  return [...changes.values()];
}

function getDocumentCriticChangeRailItems(
  editor: Editor | null,
  comments: ReadonlyMap<string, CriticComment>,
): CriticChangeRailItem[] {
  if (!editor) return [];

  const changes = new Map<string, CriticChangeRailItem>();
  const anchors = new Map<
    string,
    {
      anchorTop: number;
      anchorBottom: number;
    }
  >();
  let editorElement: HTMLElement;

  try {
    editorElement = editor.view.dom as HTMLElement;
  } catch {
    return [];
  }

  const changeElements = editorElement.querySelectorAll<HTMLElement>(
    ".critic-change[data-critic-change-id]",
  );
  const editorRect = editorElement.getBoundingClientRect();

  for (const element of changeElements) {
    const changeId = element.dataset.criticChangeId;
    if (!changeId) continue;

    const rect = element.getBoundingClientRect();
    const existing = anchors.get(changeId);
    const anchorTop = rect.top - editorRect.top;
    const anchorBottom = rect.bottom - editorRect.top;

    if (existing) {
      existing.anchorTop = Math.min(existing.anchorTop, anchorTop);
      existing.anchorBottom = Math.max(existing.anchorBottom, anchorBottom);
    } else {
      anchors.set(changeId, {
        anchorTop,
        anchorBottom,
      });
    }
  }

  editor.state.doc.descendants((node) => {
    if (!node.isText || !node.text) return;

    const changeMark = node.marks.find(
      (mark) =>
        mark.type.name === "criticChange" &&
        typeof mark.attrs.changeId === "string",
    );
    if (!changeMark) return;

    const change = changeMark.attrs as CriticChangeAttrs;
    const changeId = change.changeId;
    const kind =
      change.kind === "substitution-new" ? "substitution-old" : change.kind;
    const existing =
      changes.get(changeId) ??
      ({
        changeId,
        change,
        kind,
        oldText: "",
        newText: "",
        commentIds: [],
        anchorTop: anchors.get(changeId)?.anchorTop ?? 0,
        anchorBottom: anchors.get(changeId)?.anchorBottom ?? 24,
      } satisfies CriticChangeRailItem);

    existing.change = {
      ...change,
      kind,
    };
    existing.kind = kind;

    if (change.kind === "addition" || change.kind === "substitution-new") {
      existing.newText += node.text;
    } else {
      existing.oldText += node.text;
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "commentRef") continue;
      if (!Array.isArray(mark.attrs.commentIds)) continue;

      existing.commentIds = [
        ...new Set([...existing.commentIds, ...mark.attrs.commentIds]),
      ];
    }

    changes.set(changeId, existing);
  });

  for (const change of changes.values()) {
    const rootCommentIds = [...comments.values()]
      .filter((comment) => comment.parentCommentId === change.changeId)
      .map((comment) => comment.id);
    const descendantIds = rootCommentIds.flatMap((commentId) =>
      getCommentDescendantIds(commentId, comments),
    );

    change.commentIds = [
      ...new Set([...change.commentIds, ...rootCommentIds, ...descendantIds]),
    ];
  }

  return [...changes.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

function getCriticChangeRange(editor: Editor | null, changeId: string) {
  if (!editor) return null;

  let from: number | null = null;
  let to: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasChange = node.marks.some(
      (mark) =>
        mark.type.name === "criticChange" && mark.attrs.changeId === changeId,
    );
    if (!hasChange) return;

    from = from == null ? pos : Math.min(from, pos);
    to = to == null ? pos + node.nodeSize : Math.max(to, pos + node.nodeSize);
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function addCommentIdsToCriticChange(
  editor: Editor | null,
  changeId: string,
  commentIdsToAdd: string[],
) {
  if (!editor) return false;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return false;

  let found = false;
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasChange = node.marks.some(
      (mark) =>
        mark.type.name === "criticChange" && mark.attrs.changeId === changeId,
    );
    if (!hasChange) return;

    found = true;
    const existingMark = node.marks.find(
      (mark) => mark.type === commentMarkType,
    );
    const existingCommentIds = Array.isArray(existingMark?.attrs.commentIds)
      ? existingMark.attrs.commentIds
      : [];
    const nextCommentIds = [
      ...new Set([...existingCommentIds, ...commentIdsToAdd]),
    ];
    const from = pos;
    const to = pos + node.nodeSize;

    if (existingMark) {
      tr.removeMark(from, to, commentMarkType);
    }
    tr.addMark(
      from,
      to,
      commentMarkType.create({ commentIds: nextCommentIds }),
    );
  });

  if (!found) return false;

  editor.view.dispatch(tr);
  return true;
}

export function shouldDismissCommentThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;

  return !target.closest(
    '[data-comment-thread-container="true"], [data-suggestion-thread-container="true"], .comment-anchor[data-comment-ids], .critic-change[data-critic-change-id]',
  );
}

const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  sourceMarkdown,
  onMarkdownChange,
  interactionMode,
  commentsHidden,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onComposingCommentChange,
  onContentTouched,
  onSerializeReady,
  onPublicReply,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const criticChangeFrameRef = useRef<number | null>(null);
  const onContentTouchedRef = useRef<(() => void) | undefined>(
    onContentTouched,
  );
  onContentTouchedRef.current = onContentTouched;
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const compositionAnchorRef = useRef<number | null>(null);
  const commentsRef = useRef<Map<string, CriticComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  const selectedCommentIdRef = useRef<string | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  // Set when a comment is selected by clicking its rail card: that gesture
  // scrolls the BODY to line the text up with the (still) card, so the
  // selection-driven effect below must NOT also scroll the rail.
  const suppressRailAlignRef = useRef(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [hoveredChangeId, setHoveredChangeId] = useState<string | null>(null);
  const [criticChanges, setCriticChanges] = useState<CriticChangeRailItem[]>(
    [],
  );
  const [draftSuggestion, setDraftSuggestion] =
    useState<DraftSuggestionState | null>(null);
  const [pendingFocusCommentId, setPendingFocusCommentId] = useState<
    string | null
  >(null);
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);

  const authorId = backend?.info.authorLabel ?? "user";

  // Repo collaborators power the comment @mention menu. Fetched once per backend
  // (the backend caches/falls back internally); failures degrade to no menu.
  useEffect(() => {
    let cancelled = false;
    const pending = backend.listCollaborators?.();
    if (!pending) {
      setMentionCandidates([]);
      return;
    }
    pending
      .then((logins) => {
        if (!cancelled) setMentionCandidates(logins);
      })
      .catch(() => {
        if (!cancelled) setMentionCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  // Resolve an asset reference relative to the *document's* folder (matching
  // github.com) into a repo-root path before building its raw URL. External
  // refs (absolute URLs, data URLs) are left untouched.
  const resolveFileUrl = useCallback(
    (path: string) => {
      const repoPath = resolveRepoAssetPath(activeDocumentPath ?? "", path);
      if (repoPath == null) return path;
      return backend.resolveFileUrl(repoPath);
    },
    [activeDocumentPath, backend],
  );

  // Recovery for images whose raw URL fails to load — chiefly private repos,
  // where `raw.githubusercontent.com` 404s without auth. Fetches the bytes with
  // the user's token and returns a `data:` URL. Tries the document-relative
  // path first, then a repo-root interpretation so legacy `./assets/...` refs
  // (which pointed at repo-root assets) still resolve.
  const loadAuthedImageSrc = useCallback(
    async (markdownSrc: string): Promise<string | null> => {
      if (!backend.readAssetDataUrl) return null;
      const candidates: string[] = [];
      const resolved = resolveRepoAssetPath(
        activeDocumentPath ?? "",
        markdownSrc,
      );
      if (resolved) candidates.push(resolved);
      const rootRelative = markdownSrc
        .trim()
        .replace(/^\/+/, "")
        .replace(/^(?:\.\.?\/)+/, "");
      if (rootRelative && !candidates.includes(rootRelative)) {
        candidates.push(rootRelative);
      }
      for (const candidate of candidates) {
        const url = await backend.readAssetDataUrl(candidate);
        if (url) return url;
      }
      return null;
    },
    [activeDocumentPath, backend],
  );
  // Keep a stable identity for the editor (created once) while always calling
  // the latest resolver, so it tracks the current document/backend.
  const loadAuthedImageSrcRef = useRef(loadAuthedImageSrc);
  loadAuthedImageSrcRef.current = loadAuthedImageSrc;
  const stableLoadAuthedImageSrc = useCallback(
    (markdownSrc: string) => loadAuthedImageSrcRef.current(markdownSrc),
    [],
  );

  const resolveLinkUrl = useCallback(
    (path: string) =>
      buildLocationForLinkedMarkdownDocument({
        projectPath: backend.info.projectPath,
        currentDocumentPath: activeDocumentPath,
        href: path,
      }),
    [activeDocumentPath, backend],
  );

  const parsedContent = useMemo(
    () =>
      criticMarkdownToEditorState(sourceMarkdown, {
        resolveFileUrl,
        resolveLinkUrl,
      }),
    [resolveFileUrl, resolveLinkUrl, sourceMarkdown],
  );
  const [comments, setComments] = useState<Map<string, CriticComment>>(
    () => parsedContent.comments,
  );
  const frontmatterRef = useRef<string | null>(parsedContent.frontmatter);
  const endmatterRef = useRef<string | null>(parsedContent.endmatter);

  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    onCommentRailPresenceChange?.(
      shouldShowReviewRail(comments.size, criticChanges.length, commentsHidden),
    );
  }, [
    commentsHidden,
    comments.size,
    criticChanges.length,
    onCommentRailPresenceChange,
  ]);

  // Serializing the whole document (JSON → HTML → Turndown) is expensive, so
  // we never run it on every keystroke. The typing path only signals that the
  // content changed (see `onContentTouched`); the parent serializes once, on
  // demand, when it actually needs the markdown to save.
  const serializeCurrentMarkdown = useCallback(
    (
      doc?: JSONContent,
      nextComments?: Map<string, CriticComment>,
    ): string | null => {
      const currentEditor = editorRef.current;
      const currentDoc = doc ?? currentEditor?.getJSON();
      if (!currentDoc) return null;

      return editorStateToCriticMarkdown(
        currentDoc,
        nextComments ?? commentsRef.current,
        {
          frontmatter: frontmatterRef.current,
          endmatter: endmatterRef.current,
        },
      );
    },
    [],
  );

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, CriticComment>) => {
      const markdown = serializeCurrentMarkdown(doc, nextComments);
      if (markdown == null) return;
      onMarkdownChange(markdown);
    },
    [onMarkdownChange, serializeCurrentMarkdown],
  );

  const [uploadError, setUploadError] = useState<string | null>(null);

  const insertFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || files.length === 0) return;

      setUploadError(null);
      const assets = await Promise.all(
        files.map((file) => backend.saveAsset(file)),
      );
      const markdown = assets
        .map((asset, index) => {
          const file = files[index];
          // Reference the asset relative to this document's folder so the link
          // works in margins AND when the .md is viewed on github.com.
          const ref = relativeAssetRef(
            activeDocumentPath ?? "",
            asset.markdownPath,
          );
          if (asset.mimeType.startsWith("image/")) {
            return `![${file?.name || "Image"}](${ref})`;
          }
          return `[${file?.name || "Attachment"}](${ref})`;
        })
        .join("\n\n");

      currentEditor
        .chain()
        .focus()
        .insertContent(
          toHtml(markdown, {
            resolveFileUrl,
            resolveLinkUrl,
          }),
        )
        .run();
    },
    [activeDocumentPath, backend, resolveFileUrl, resolveLinkUrl],
  );

  const refreshCriticChanges = useCallback(() => {
    if (criticChangeFrameRef.current != null) {
      cancelAnimationFrame(criticChangeFrameRef.current);
    }

    criticChangeFrameRef.current = requestAnimationFrame(() => {
      criticChangeFrameRef.current = null;
      setCriticChanges(
        getDocumentCriticChangeRailItems(
          editorRef.current,
          commentsRef.current,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return () => {
      if (criticChangeFrameRef.current != null) {
        cancelAnimationFrame(criticChangeFrameRef.current);
      }
    };
  }, []);

  const editor = useEditor(
    {
      extensions: createEditorExtensions("Start writing...", {
        loadAuthedImageSrc: stableLoadAuthedImageSrc,
      }),
      content: parsedContent.doc,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: "tiptap min-h-[70vh]",
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void runWithErrorFeedback(
            () => insertFiles(files),
            setUploadError,
            "Could not add the dropped file(s).",
          );
          return true;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void runWithErrorFeedback(
              () => insertFiles(files),
              setUploadError,
              "Could not add the pasted file(s).",
            );
            return true;
          }

          if (interactionModeRef.current !== "suggesting") return false;

          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          event.preventDefault();

          const { selection } = view.state;
          const tr = buildSuggestionInputTransaction(
            view.state,
            { from: selection.from, to: selection.to },
            text,
            {
              markType: view.state.schema.marks.criticChange,
              changeAttrs: { authorId },
              existingChanges: getDocumentCriticChanges(currentEditor),
            },
          );

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleTextInput: (view, from, to, text) => {
          if (interactionModeRef.current !== "suggesting") return false;
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const tr = buildSuggestionInputTransaction(
            view.state,
            { from, to },
            text,
            {
              markType: view.state.schema.marks.criticChange,
              changeAttrs: { authorId },
              existingChanges: getDocumentCriticChanges(currentEditor),
            },
          );

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleKeyDown: (view, event) => {
          if (interactionModeRef.current !== "suggesting") return false;

          if (event.key === "Enter") {
            event.preventDefault();

            const currentEditor = editorRef.current;
            if (!currentEditor) return true;

            const { selection } = view.state;
            if (!selection.empty) return true;

            const $from = selection.$from;
            if (!$from.parent.isTextblock) return true;
            if ($from.parentOffset !== $from.parent.content.size) return true;

            const change = createCriticChange(
              "addition",
              { authorId },
              {
                existingChanges: getDocumentCriticChanges(currentEditor),
              },
            );
            const mark = view.state.schema.marks.criticChange.create(change);
            const tr = view.state.tr.split(selection.from);
            const insertPos = tr.selection.from;

            tr.insert(
              insertPos,
              view.state.schema.text(SUGGESTED_PARAGRAPH_SENTINEL, [mark]),
            );
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                insertPos + SUGGESTED_PARAGRAPH_SENTINEL.length,
              ),
            );
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
          }

          // Handle Cut (Ctrl+X / Cmd+X)
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "x"
          ) {
            const { selection } = view.state;
            if (selection.empty) return false;

            const currentEditor = editorRef.current;
            if (!currentEditor) return false;

            event.preventDefault();
            const from = selection.from;
            const to = selection.to;
            const selectedText = view.state.doc.textBetween(from, to);
            void navigator.clipboard.writeText(selectedText);

            const tr = buildSuggestionDeleteTransaction(
              view.state,
              { from, to },
              {
                markType: view.state.schema.marks.criticChange,
                changeAttrs: { authorId },
                existingChanges: getDocumentCriticChanges(currentEditor),
              },
            );
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          if (event.key !== "Backspace" && event.key !== "Delete") return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const deleteKey = event.key === "Backspace" ? "Backspace" : "Delete";
          const byWord = event.ctrlKey || event.altKey;
          const { from, to } = computeKeyboardDeleteRange(
            view.state,
            deleteKey,
            byWord,
          );

          if (from === to) {
            event.preventDefault();
            return true;
          }

          event.preventDefault();

          const tr = buildSuggestionDeleteTransaction(
            view.state,
            { from, to },
            {
              markType: view.state.schema.marks.criticChange,
              changeAttrs: { authorId },
              existingChanges: getDocumentCriticChanges(currentEditor),
            },
            { selectionBasePos: deleteKey === "Backspace" ? from : to },
          );
          tr.scrollIntoView();

          view.dispatch(tr);
          return true;
        },
        handleDOMEvents: {
          compositionstart: (view) => {
            if (interactionModeRef.current === "suggesting") {
              compositionAnchorRef.current = view.state.selection.from;
            }
            return false;
          },
          compositionend: () => {
            if (interactionModeRef.current !== "suggesting") {
              compositionAnchorRef.current = null;
              return false;
            }

            const anchor = compositionAnchorRef.current;
            compositionAnchorRef.current = null;
            if (anchor == null) return false;

            // ProseMirror commits IME-composed text (CJK, dead keys, dictation)
            // out-of-band shortly after `compositionend` — via a microtask flush
            // or a ~20ms fallback timer — so it never reaches `handleTextInput`.
            // Defer past that flush, then flag the composed range as a tracked
            // addition. We only extend forward from the caret recorded at
            // `compositionstart`, so a stray caret move can never mis-mark
            // already-committed text; the engine also skips runs that are
            // already additions, so nothing is double-marked.
            window.setTimeout(() => {
              const currentEditor = editorRef.current;
              if (!currentEditor) return;
              if (interactionModeRef.current !== "suggesting") return;

              const activeView = currentEditor.view;
              if (activeView.composing) return;

              const caret = activeView.state.selection.from;
              if (caret <= anchor) return;

              const tr = buildSuggestionMarkAdditionTransaction(
                activeView.state,
                { from: anchor, to: caret },
                {
                  markType: activeView.state.schema.marks.criticChange,
                  changeAttrs: { authorId },
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              if (tr.docChanged) {
                activeView.dispatch(tr.scrollIntoView());
              }
            }, 50);

            return false;
          },
        },
      },
      onUpdate: () => {
        if (suppressNextMarkdownUpdateRef.current) {
          suppressNextMarkdownUpdateRef.current = false;
          return;
        }

        // Cheap signal only — the parent schedules the save and serializes
        // once, lazily, when the save actually fires.
        onContentTouchedRef.current?.();
        refreshCriticChanges();
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  selectedCommentIdRef.current = selectedCommentId;
  selectedChangeIdRef.current = selectedChangeId;

  useEffect(() => {
    editor?.setEditable(interactionMode !== "viewing", false);
  }, [editor, interactionMode]);

  const activeCommentIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCommentIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];
  const activeChangeIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCriticChangeIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, comments.size > 0);

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  // Expose the serializer so the parent can pull the current document as
  // markdown on demand — when a save fires or is flushed (manual commit,
  // Cmd+S, complete-review) — instead of on every keystroke.
  useEffect(() => {
    onSerializeReady?.(() => serializeCurrentMarkdown());

    return () => {
      onSerializeReady?.(null);
    };
  }, [onSerializeReady, serializeCurrentMarkdown]);

  useEffect(() => {
    setSelectedCommentId((current) =>
      getPreferredCommentId(activeCommentIds, current),
    );
  }, [activeCommentIds]);

  // Dual-scroll: when selection moves to a comment from the BODY (clicking a
  // highlight, or adding a comment), scroll only the RAIL so the comment lines
  // up with its text — the body stays put. Card-clicks set the suppress flag
  // (they scroll the body instead), so this skips them.
  useEffect(() => {
    if (!selectedCommentId) return;
    if (suppressRailAlignRef.current) {
      suppressRailAlignRef.current = false;
      return;
    }
    const rootCommentId = getRootThreadIdForCommentId(
      selectedCommentId,
      commentsRef.current,
    );
    if (!rootCommentId) return;
    const reduced = prefersReducedMotion();
    // A brand-new comment's card renders a frame or two after selection (the
    // rail re-renders, then measures heights, then positions it). Retry across
    // a few frames until both the card and its highlight exist, then align once,
    // so "add comment" scrolls to the new comment instead of no-op'ing early.
    let attempts = 0;
    let raf = 0;
    const tryAlign = () => {
      const card = findCommentCardElement(rootCommentId);
      const anchor = findCommentAnchorElement(
        editorRef.current,
        selectedCommentId,
      );
      if (card && anchor) {
        alignElementToTarget(getRailScroller(), card, anchor, reduced);
        return;
      }
      if (attempts++ < 10) raf = requestAnimationFrame(tryAlign);
    };
    raf = requestAnimationFrame(tryAlign);
    return () => cancelAnimationFrame(raf);
  }, [selectedCommentId]);

  useEffect(() => {
    setSelectedChangeId((current) =>
      getPreferredCriticChangeId(activeChangeIds, current),
    );
  }, [activeChangeIds]);

  useEffect(() => {
    if (!editor) return;

    frontmatterRef.current = parsedContent.frontmatter;
    endmatterRef.current = parsedContent.endmatter;
    commentsRef.current = parsedContent.comments;
    setComments(parsedContent.comments);
    setSelectedCommentId(null);
    setHoveredCommentId(null);
    setSelectedChangeId(null);
    setHoveredChangeId(null);
    setDraftSuggestion(null);
    setPendingFocusCommentId(null);

    const nextDoc = parsedContent.doc;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
      editor.commands.setContent(nextDoc, { emitUpdate: false });
    }

    refreshCriticChanges();
  }, [editor, parsedContent, refreshCriticChanges]);

  useEffect(() => {
    if (!editor || !selected || !focusRequestKey) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;

    requestAnimationFrame(() => {
      editor.chain().focus("end").run();
    });
  }, [editor, focusRequestKey, selected]);

  useEffect(() => {
    if (selectedCommentId && !comments.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }

    if (hoveredCommentId && !comments.has(hoveredCommentId)) {
      setHoveredCommentId(null);
    }
    refreshCriticChanges();
  }, [comments, hoveredCommentId, refreshCriticChanges, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredCommentId = selectedCommentId
      ? hoveredCommentId
      : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredChangeId = selectedChangeId ? hoveredChangeId : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(criticChangeHighlightPluginKey, {
        selectedChangeId,
        hoveredChangeId: effectiveHoveredChangeId,
      }),
    );
  }, [editor, hoveredChangeId, selectedChangeId]);

  useEffect(() => {
    if (!editor) return;

    const anchorElements = editor.view.dom.querySelectorAll<HTMLElement>(
      ".comment-anchor[data-comment-ids]",
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const anchor of anchorElements) {
      const commentIds = parseCommentIds(anchor.dataset.commentIds);
      if (commentIds.length === 0) continue;

      const handleMouseEnter = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setHoveredCommentId(nextCommentId);
        }
      };

      const handleMouseLeave = () => {
        setHoveredCommentId((current) =>
          current && commentIds.includes(current) ? null : current,
        );
      };

      const handleClick = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setSelectedCommentId(nextCommentId);
        }
      };

      anchor.addEventListener("mouseenter", handleMouseEnter);
      anchor.addEventListener("mouseleave", handleMouseLeave);
      anchor.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        anchor.removeEventListener("mouseenter", handleMouseEnter);
        anchor.removeEventListener("mouseleave", handleMouseLeave);
        anchor.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    const changeElements = editor.view.dom.querySelectorAll<HTMLElement>(
      ".critic-change[data-critic-change-id]",
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const element of changeElements) {
      const changeId = element.dataset.criticChangeId;
      if (!changeId) continue;

      const handleMouseEnter = () => {
        setHoveredChangeId(changeId);
      };

      const handleMouseLeave = () => {
        setHoveredChangeId((current) =>
          current === changeId ? null : current,
        );
      };

      const handleClick = () => {
        setSelectedChangeId(changeId);
      };

      element.addEventListener("mouseenter", handleMouseEnter);
      element.addEventListener("mouseleave", handleMouseLeave);
      element.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        element.removeEventListener("mouseenter", handleMouseEnter);
        element.removeEventListener("mouseleave", handleMouseLeave);
        element.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!selectedCommentIdRef.current && !selectedChangeIdRef.current) return;
      if (!shouldDismissCommentThread(event.target)) return;

      setSelectedCommentId(null);
      setHoveredCommentId(null);
      setSelectedChangeId(null);
      setHoveredChangeId(null);
      setPendingFocusCommentId(null);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
    };
  }, []);

  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const existingIds = getSelectionCommentIds(currentEditor);
    const comment = createCriticComment(
      { authorId },
      {
        existingComments: commentsRef.current.values(),
      },
    );
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    setComments(nextComments);

    suppressNextMarkdownUpdateRef.current = true;
    currentEditor
      .chain()
      .focus()
      .setCommentRef({ commentIds: [...existingIds, comment.id] })
      .run();
    if (suppressNextMarkdownUpdateRef.current) {
      suppressNextMarkdownUpdateRef.current = false;
    }

    // New comment: leave the suppress flag false so the selection-driven effect
    // centers its freshly-rendered card in view (so it's clear where it landed
    // and its pending-focus editor is on screen).
    setSelectedCommentId(comment.id);
    setPendingFocusCommentId(comment.id);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [measureLayout]);

  const handleSuggestDeletion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const change = createCriticChange(
      "deletion",
      { authorId },
      {
        existingChanges: getDocumentCriticChanges(currentEditor),
      },
    );

    currentEditor.chain().focus().setCriticChange(change).run();
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestReplacement = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const { from, to } = currentEditor.state.selection;
    setDraftSuggestion({
      type: "replacement",
      from,
      to,
      sourceText: currentEditor.state.doc.textBetween(from, to, "\n"),
      text: "",
    });
  }, []);

  // Routes the context menu's Paste / Paste Markdown items through the
  // suggestion-capture engine while in suggesting mode, so programmatic inserts
  // are tracked as additions rather than landing untracked.
  const insertSuggestion = useCallback(
    (
      content: { type: "text"; text: string } | { type: "html"; html: string },
    ) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;
      const { view } = currentEditor;

      if (content.type === "text") {
        const { selection } = view.state;
        const tr = buildSuggestionInputTransaction(
          view.state,
          { from: selection.from, to: selection.to },
          content.text,
          {
            markType: view.state.schema.marks.criticChange,
            changeAttrs: { authorId },
            existingChanges: getDocumentCriticChanges(currentEditor),
          },
        );
        view.dispatch(tr.scrollIntoView());
        return;
      }

      // Rich HTML can't flow through the plain-text engine. First convert any
      // selected original text into a tracked deletion (so it isn't silently
      // dropped), then insert the HTML and flag the inserted range as an
      // addition.
      const { selection } = view.state;
      if (!selection.empty) {
        const deleteTr = buildSuggestionDeleteTransaction(
          view.state,
          { from: selection.from, to: selection.to },
          {
            markType: view.state.schema.marks.criticChange,
            changeAttrs: { authorId },
            existingChanges: getDocumentCriticChanges(currentEditor),
          },
          { selectionBasePos: selection.to },
        );
        view.dispatch(deleteTr);
      }

      const insertFrom = currentEditor.state.selection.from;
      currentEditor.chain().focus().insertContent(content.html).run();
      const insertTo = currentEditor.state.selection.from;

      if (insertTo > insertFrom) {
        const markTr = buildSuggestionMarkAdditionTransaction(
          currentEditor.state,
          { from: insertFrom, to: insertTo },
          {
            markType: currentEditor.state.schema.marks.criticChange,
            changeAttrs: { authorId },
            existingChanges: getDocumentCriticChanges(currentEditor),
          },
        );
        if (markTr.docChanged) {
          currentEditor.view.dispatch(markTr.scrollIntoView());
        }
      }
    },
    [authorId],
  );

  const applyDraftSuggestion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || !draftSuggestion) return;

    const nextText = draftSuggestion.text;
    if (!nextText) {
      setDraftSuggestion(null);
      return;
    }

    if (draftSuggestion.type === "insertion") {
      const change = createCriticChange(
        "addition",
        { authorId },
        {
          existingChanges: getDocumentCriticChanges(currentEditor),
        },
      );

      currentEditor
        .chain()
        .focus()
        .insertContentAt(draftSuggestion.from, {
          type: "text",
          text: nextText,
          marks: [
            {
              type: "criticChange",
              attrs: change,
            },
          ],
        })
        .run();
      setSelectedChangeId(change.changeId);
      setDraftSuggestion(null);
      emitMarkdownChange(currentEditor.getJSON());
      refreshCriticChanges();
      return;
    }

    const change = createCriticChange(
      "substitution-old",
      { authorId },
      {
        existingChanges: getDocumentCriticChanges(currentEditor),
      },
    );
    const replacementChange: CriticChangeAttrs = {
      ...change,
      kind: "substitution-new",
    };

    currentEditor
      .chain()
      .focus()
      .setTextSelection({ from: draftSuggestion.from, to: draftSuggestion.to })
      .setCriticChange(change)
      .insertContentAt(draftSuggestion.to, {
        type: "text",
        text: nextText,
        marks: [
          {
            type: "criticChange",
            attrs: replacementChange,
          },
        ],
      })
      .run();
    setSelectedChangeId(change.changeId);
    setDraftSuggestion(null);
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [draftSuggestion, emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestInsertion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    const { from } = currentEditor.state.selection;
    const before = currentEditor.state.doc.textBetween(
      Math.max(1, from - 24),
      from,
      " ",
    );
    const after = currentEditor.state.doc.textBetween(
      from,
      Math.min(currentEditor.state.doc.content.size, from + 24),
      " ",
    );

    setDraftSuggestion({
      type: "insertion",
      from,
      to: from,
      sourceText: `${before}▮${after}`.trim(),
      text: "",
    });
  }, []);

  const updateComment = useCallback(
    (commentId: string, updater: (comment: CriticComment) => CriticComment) => {
      const existingComment = commentsRef.current.get(commentId);
      if (!existingComment) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(commentId, updater(existingComment));
      commentsRef.current = nextComments;
      setComments(nextComments);
      emitMarkdownChange(undefined, nextComments);
    },
    [emitMarkdownChange],
  );

  const toggleResolveComment = useCallback(
    (commentId: string, resolved: boolean) => {
      updateComment(commentId, (current) => ({
        ...current,
        resolved,
        resolvedBy: resolved ? authorId : null,
        resolvedAt: resolved ? new Date().toISOString() : null,
      }));
    },
    [authorId, updateComment],
  );

  const replyToComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createCriticComment(
        {
          authorId,
          parentCommentId: commentId,
        },
        {
          existingComments: commentsRef.current.values(),
        },
      );
      suppressNextMarkdownUpdateRef.current = true;
      const nextAnchorCommentIds = addCommentIdsToAnchor(
        currentEditor,
        commentId,
        [comment.id],
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!nextAnchorCommentIds) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      // Replying opens the editor in place — the reply belongs to the thread
      // that's already in view, so don't let the selection-driven rail align
      // scroll it.
      suppressRailAlignRef.current = true;
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [measureLayout],
  );

  const removeSuggestionComments = useCallback(
    (changeId: string, currentEditor: Editor) => {
      const directCommentIds = [...commentsRef.current.values()]
        .filter((comment) => comment.parentCommentId === changeId)
        .map((comment) => comment.id);
      const commentIdsToDelete = [
        ...directCommentIds,
        ...directCommentIds.flatMap((commentId) =>
          getCommentDescendantIds(commentId, commentsRef.current),
        ),
      ];

      if (commentIdsToDelete.length === 0) return commentsRef.current;

      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();

      commentsRef.current = nextComments;
      setComments(nextComments);
      return nextComments;
    },
    [],
  );

  const acceptSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().acceptCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const rejectSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().rejectCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const replyToSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createCriticComment(
        {
          authorId,
          parentCommentId: changeId,
        },
        {
          existingComments: commentsRef.current.values(),
        },
      );
      suppressNextMarkdownUpdateRef.current = true;
      const didAddCommentId = addCommentIdsToCriticChange(
        currentEditor,
        changeId,
        [comment.id],
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!didAddCommentId) {
        return;
      }

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedChangeId(changeId);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      refreshCriticChanges();
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [measureLayout, refreshCriticChanges],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const descendantIds = getCommentDescendantIds(
        commentId,
        commentsRef.current,
      );
      const commentIdsToDelete = [commentId, ...descendantIds];
      const deletedIds = new Set(commentIdsToDelete);
      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }
      commentsRef.current = nextComments;
      setComments(nextComments);

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();
      setSelectedCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setHoveredCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const selectComment = useCallback((commentId: string) => {
    setSelectedCommentId(commentId);
  }, []);

  const selectSuggestion = useCallback((changeId: string) => {
    setSelectedChangeId(changeId);
    setSelectedCommentId(null);
  }, []);

  const focusComment = useCallback((commentId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    // Card-click: the card stays put; scroll the BODY so its highlighted text
    // lines up with the card. Suppress the rail-align effect (it's for
    // body-clicks). Setting the editor selection (below) drives that effect, so
    // the flag must be set first.
    suppressRailAlignRef.current = true;
    setSelectedCommentId(commentId);

    const range = findCommentRange(currentEditor, commentId);
    if (range) {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
      currentEditor.view.dispatch(
        currentEditor.state.tr.setSelection(
          TextSelection.create(currentEditor.state.doc, range.from, range.to),
        ),
      );
    } else if (!findCommentAnchorElement(currentEditor, commentId)) {
      return;
    } else {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
    }

    const reduced = prefersReducedMotion();
    const rootCommentId = getRootThreadIdForCommentId(
      commentId,
      commentsRef.current,
    );
    requestAnimationFrame(() => {
      alignElementToTarget(
        getBodyScroller(),
        findCommentAnchorElement(editorRef.current, commentId),
        rootCommentId ? findCommentCardElement(rootCommentId) : null,
        reduced,
      );
    });
  }, []);

  const focusSuggestion = useCallback((changeId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedChangeId(changeId);
    setSelectedCommentId(null);

    const range = getCriticChangeRange(currentEditor, changeId);
    if (!range) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
    currentEditor.view.dispatch(
      currentEditor.state.tr.setSelection(
        TextSelection.create(currentEditor.state.doc, range.from, range.to),
      ),
    );
  }, []);

  const hasReviewRail = shouldShowReviewRail(
    comments.size,
    criticChanges.length,
    commentsHidden,
  );
  const activeComments = activeCommentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));
  const contentCardClass =
    "rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-700 bg-white dark:bg-card shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)]";
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "flex flex-col gap-6 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,56rem)_minmax(24rem,1fr)] min-[1100px]:items-start min-[1100px]:justify-between min-[1100px]:gap-8",
    !hasReviewRail && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasReviewRail &&
      "min-[1100px]:grid-cols-[minmax(0,56rem)] min-[1100px]:justify-center",
    commentsHidden && "comments-hidden",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo" ? "max-w-none" : "max-w-[56rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const fallbackClass = cn(
    "document-comment-fallback mb-4",
    layout === "embedded-demo" ? "hidden" : "min-[1100px]:hidden",
  );
  const reviewRailClass = cn(
    "document-comment-rail",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : // The rail is its own scroll area (sticky), independent of the body, so
        // clicking one side can line the other up without dragging it along.
        "hidden min-[1100px]:block min-[1100px]:sticky min-[1100px]:top-2 min-[1100px]:max-h-[calc(100dvh-7rem)] min-[1100px]:overflow-y-auto",
  );

  return (
    <div
      className="cursor-text bg-transparent"
      data-testid="page-card-rich-text"
    >
      <div data-testid="document-page-shell" className={documentShellClass}>
        <div className={documentMainClass}>
          {!commentsHidden && activeComments.length > 0 ? (
            <CommentEditorList
              comments={activeComments}
              className={fallbackClass}
              testId="document-comment-fallback"
              mentionCandidates={mentionCandidates}
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              onDeleteComment={deleteComment}
              onUpdateComment={(commentId, nextContent) => {
                updateComment(commentId, (current) => ({
                  ...current,
                  content: nextContent,
                }));
              }}
              onToggleResolveComment={toggleResolveComment}
              onReplyComment={
                interactionMode === "viewing" && onPublicReply
                  ? onPublicReply
                  : replyToComment
              }
              onSelectComment={selectComment}
              onHoverComment={setHoveredCommentId}
              pendingFocusCommentId={pendingFocusCommentId}
              onAutoFocusComment={(commentId) => {
                setPendingFocusCommentId((current) =>
                  current === commentId ? null : current,
                );
              }}
              onComposingChange={onComposingCommentChange}
            />
          ) : null}
          <div className={contentInsetClass}>
            <div
              data-testid="document-content-card"
              className={cn(contentCardClass, "px-10 py-10 sm:px-14 sm:py-14")}
            >
              <EditorContextMenu
                editor={editor}
                backend={backend}
                resolveLinkUrl={resolveLinkUrl}
                onAddComment={
                  interactionMode === "viewing" ? undefined : handleAddComment
                }
                onSuggestDeletion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestDeletion
                }
                onSuggestReplacement={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestReplacement
                }
                onSuggestInsertion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestInsertion
                }
                onInsertSuggestion={
                  interactionMode === "suggesting"
                    ? insertSuggestion
                    : undefined
                }
              >
                <div data-testid="rich-text-editor">
                  {uploadError && (
                    <div
                      role="alert"
                      data-testid="upload-error"
                      className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
                    >
                      {uploadError}
                    </div>
                  )}
                  <EditorContent editor={editor} />
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        {hasReviewRail ? (
          <DocumentReviewRail
            className={reviewRailClass}
            layout={layout === "embedded-demo" ? "flow" : "anchored"}
            testId="document-review-rail"
            commentGroups={commentGroups}
            comments={comments}
            suggestions={criticChanges}
            selectedCommentId={selectedCommentId}
            hoveredCommentId={hoveredCommentId}
            selectedChangeId={selectedChangeId}
            hoveredChangeId={hoveredChangeId}
            contentHeight={contentHeight}
            mentionCandidates={mentionCandidates}
            onDeleteComment={deleteComment}
            onUpdateComment={(commentId, nextContent) => {
              updateComment(commentId, (current) => ({
                ...current,
                content: nextContent,
              }));
            }}
            onToggleResolveComment={toggleResolveComment}
            onReplyComment={
              interactionMode === "viewing" && onPublicReply
                ? onPublicReply
                : replyToComment
            }
            onSelectComment={selectComment}
            onFocusComment={focusComment}
            onHoverComment={setHoveredCommentId}
            onAcceptSuggestion={acceptSuggestion}
            onRejectSuggestion={rejectSuggestion}
            onReplySuggestion={replyToSuggestion}
            onSelectSuggestion={selectSuggestion}
            onFocusSuggestion={focusSuggestion}
            onHoverSuggestion={setHoveredChangeId}
            pendingFocusCommentId={pendingFocusCommentId}
            onAutoFocusComment={(commentId) => {
              setPendingFocusCommentId((current) =>
                current === commentId ? null : current,
              );
            }}
            draftSuggestion={draftSuggestion}
            onDraftSuggestionTextChange={(text) => {
              setDraftSuggestion((current) =>
                current ? { ...current, text } : current,
              );
            }}
            onApplyDraftSuggestion={applyDraftSuggestion}
            onCancelDraftSuggestion={() => setDraftSuggestion(null)}
            editor={editor}
            onComposingChange={onComposingCommentChange}
          />
        ) : null}
      </div>
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  markdown,
  filePath,
  hasCommentRailSpace,
  interactionMode,
  layout,
  onMarkdownChange,
}: CodeEditorSurfaceProps) {
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "flex flex-col gap-6 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,56rem)_minmax(24rem,1fr)] min-[1100px]:items-start min-[1100px]:justify-between min-[1100px]:gap-8",
    !hasCommentRailSpace && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasCommentRailSpace &&
      "min-[1100px]:grid-cols-[minmax(0,56rem)] min-[1100px]:justify-center",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo" ? "max-w-none" : "max-w-[56rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const reviewRailClass = cn(
    "document-comment-rail pointer-events-none invisible",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "hidden min-[1100px]:block",
  );

  return (
    <div className="cursor-text bg-transparent" data-testid="page-card-code">
      <div data-testid="document-page-shell" className={documentShellClass}>
        <div className={documentMainClass}>
          <div className={contentInsetClass}>
            <div
              className="min-h-[calc(70vh+4rem)] rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-700 bg-white dark:bg-card py-10 pr-6 pl-5 shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)] sm:py-14 sm:pr-10 sm:pl-8"
              data-testid="document-content-card"
            >
              <Suspense fallback={null}>
                <MarkdownCodeEditor
                  testId="markdown-code-editor"
                  value={markdown}
                  path={filePath ?? undefined}
                  onChange={onMarkdownChange}
                  readOnly={interactionMode === "viewing"}
                  autoFocus
                />
              </Suspense>
            </div>
          </div>
        </div>
        {hasCommentRailSpace ? (
          <div
            data-testid="document-review-rail"
            className={reviewRailClass}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  onSave,
  onSaveStateChange,
  editorViewMode,
  interactionMode,
  commentsHidden,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onComposingCommentChange,
  onLocalContentChange,
  onSaveControllerChange,
  saveBlocked = false,
  forceResetKey = null,
  manualCommit = false,
  onPublicReply,
}: PageCardEditorSurfaceProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveRef = useRef<Promise<ManualSaveResult> | null>(null);
  const pendingMarkdownRef = useRef(page.content);
  const serializeFromEditorRef = useRef<(() => string | null) | null>(null);
  const recentMarkdownRef = useRef<Set<string>>(new Set());
  const previousEditorViewModeRef = useRef<EditorViewMode>(editorViewMode);
  const lastAcceptedMarkdownRef = useRef(page.content);
  const localDirtyRef = useRef(false);
  const forceResetKeyRef = useRef(forceResetKey);
  const [markdown, setMarkdown] = useState(page.content);
  const [richTextSourceMarkdown, setRichTextSourceMarkdown] = useState(
    page.content,
  );

  const reportDirtyState = useCallback(
    (isDirty: boolean) => {
      if (localDirtyRef.current === isDirty) return;
      localDirtyRef.current = isDirty;
      onDirtyStateChange?.(isDirty);
    },
    [onDirtyStateChange],
  );

  // Same parse options the rich-text editor uses, so canonicalization produces
  // byte-identical output to the editor's own serialization (URLs included).
  const markdownComparisonOptions = useMemo<MarkdownOptions | undefined>(() => {
    if (!backend) return undefined;
    return {
      resolveFileUrl: (path: string) => backend.resolveFileUrl(path),
      resolveLinkUrl: (path: string) =>
        buildLocationForLinkedMarkdownDocument({
          projectPath: backend.info.projectPath,
          currentDocumentPath: activeDocumentPath,
          href: path,
        }),
    };
  }, [activeDocumentPath, backend]);

  // True when the candidate Markdown is the same document as the baseline,
  // ignoring the cosmetic normalization the editor applies on round-trip.
  // Loading an untouched document serializes to non-identical bytes; comparing
  // raw strings here is what made the manual-commit button appear on every load.
  const sameContent = useCallback(
    (candidate: string, baseline: string) =>
      markdownEquivalent(candidate, baseline, markdownComparisonOptions),
    [markdownComparisonOptions],
  );

  const acceptMarkdown = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      lastAcceptedMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      setRichTextSourceMarkdown(nextMarkdown);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(false);
      onSaveStateChange("saved");
    },
    [onLocalContentChange, onSaveStateChange, reportDirtyState],
  );

  const rememberRecentMarkdown = useCallback((nextMarkdown: string) => {
    recentMarkdownRef.current.add(nextMarkdown);
    if (recentMarkdownRef.current.size > 10) {
      const iterator = recentMarkdownRef.current.values();
      recentMarkdownRef.current.delete(iterator.next().value as string);
    }
  }, []);

  const performSave = useCallback(
    async (nextMarkdown: string): Promise<ManualSaveResult> => {
      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return { status: "blocked" };
      }

      rememberRecentMarkdown(nextMarkdown);
      onSaveStateChange("saving");

      try {
        await onSave(page.id, nextMarkdown);
        lastAcceptedMarkdownRef.current = nextMarkdown;
        reportDirtyState(pendingMarkdownRef.current !== nextMarkdown);
        onSaveStateChange(
          pendingMarkdownRef.current === nextMarkdown ? "saved" : "saving",
        );
        return { status: "saved" };
      } catch (error) {
        console.error("Failed to save page:", error);
        onSaveStateChange("error");
        return { status: "error", error };
      }
    },
    [
      onSave,
      onSaveStateChange,
      page.id,
      rememberRecentMarkdown,
      reportDirtyState,
      saveBlocked,
    ],
  );

  const scheduleSave = useCallback(
    (nextMarkdown: string) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      if (manualCommit || saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return;
      }

      onSaveStateChange("saving");
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        inFlightSaveRef.current = performSave(nextMarkdown).finally(() => {
          inFlightSaveRef.current = null;
        });
        void inFlightSaveRef.current;
      }, 500);
    },
    [manualCommit, onSaveStateChange, performSave, saveBlocked],
  );

  // Serialize the live editor document on demand (the rich-text path never
  // serializes per keystroke) and record it as the pending content to save.
  const commitSerializedFromEditor = useCallback((): string | null => {
    const serialize = serializeFromEditorRef.current;
    if (!serialize) return null;
    const nextMarkdown = serialize();
    if (nextMarkdown == null) return null;
    pendingMarkdownRef.current = nextMarkdown;
    setMarkdown(nextMarkdown);
    onLocalContentChange?.(nextMarkdown);
    reportDirtyState(
      !sameContent(nextMarkdown, lastAcceptedMarkdownRef.current),
    );
    return nextMarkdown;
  }, [onLocalContentChange, reportDirtyState, sameContent]);

  // Rich-text typing path: flip save state immediately (cheap) and schedule
  // the autosave, which serializes once when it fires instead of per keystroke.
  const scheduleSaveFromEditor = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    if (manualCommit || saveBlocked) {
      // Don't flag "unsaved" on the bare editor update: tables, code blocks,
      // mermaid, and task lists each dispatch a benign post-load transaction
      // that fires onUpdate without changing the serialized document. Serialize
      // once (debounced) and only flag unsaved when the markdown actually
      // differs from the accepted baseline.
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        const serialize = serializeFromEditorRef.current;
        const next = serialize?.();
        if (next == null) return;
        pendingMarkdownRef.current = next;
        const changed = !sameContent(next, lastAcceptedMarkdownRef.current);
        reportDirtyState(changed);
        onSaveStateChange(changed ? "unsaved" : "saved");
      }, 250);
      return;
    }

    reportDirtyState(true);
    onSaveStateChange("saving");
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const nextMarkdown = commitSerializedFromEditor();
      if (nextMarkdown == null) return;
      inFlightSaveRef.current = performSave(nextMarkdown).finally(() => {
        inFlightSaveRef.current = null;
      });
      void inFlightSaveRef.current;
    }, 500);
  }, [
    commitSerializedFromEditor,
    manualCommit,
    onSaveStateChange,
    performSave,
    reportDirtyState,
    sameContent,
    saveBlocked,
  ]);

  const flushSave = useCallback(async (): Promise<ManualSaveResult> => {
    // Serialize the live editor content first so we save the latest edits,
    // not a stale snapshot.
    commitSerializedFromEditor();

    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const currentMarkdown = pendingMarkdownRef.current;

    if (
      sameContent(currentMarkdown, lastAcceptedMarkdownRef.current) &&
      !inFlightSaveRef.current
    ) {
      onSaveStateChange("saved");
      return { status: "saved" };
    }

    if (inFlightSaveRef.current) {
      await inFlightSaveRef.current;
      if (
        sameContent(pendingMarkdownRef.current, lastAcceptedMarkdownRef.current)
      ) {
        onSaveStateChange("saved");
        return { status: "saved" };
      }
    }

    return await performSave(pendingMarkdownRef.current);
  }, [commitSerializedFromEditor, onSaveStateChange, performSave, sameContent]);

  const flushDraft = useCallback(() => {
    commitSerializedFromEditor();
  }, [commitSerializedFromEditor]);

  useEffect(() => {
    onSaveControllerChange?.({ flushSave, flushDraft });
    return () => onSaveControllerChange?.(null);
  }, [flushDraft, flushSave, onSaveControllerChange]);

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(nextMarkdown !== lastAcceptedMarkdownRef.current);
      scheduleSave(nextMarkdown);
    },
    [onLocalContentChange, reportDirtyState, scheduleSave],
  );

  const handleContentTouched = useCallback(() => {
    scheduleSaveFromEditor();
  }, [scheduleSaveFromEditor]);

  const handleSerializeReady = useCallback(
    (serialize: (() => string | null) | null) => {
      serializeFromEditorRef.current = serialize;
    },
    [],
  );

  useEffect(() => {
    const forceResetChanged = forceResetKeyRef.current !== forceResetKey;
    forceResetKeyRef.current = forceResetKey;

    if (forceResetChanged) {
      recentMarkdownRef.current.delete(page.content);
      acceptMarkdown(page.content);
      return;
    }

    if (recentMarkdownRef.current.has(page.content)) {
      recentMarkdownRef.current.delete(page.content);
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = markdown;
      reportDirtyState(markdown !== page.content);
      return;
    }

    if (localDirtyRef.current && markdown !== page.content) {
      return;
    }

    // The editor holds content we just saved locally; the matching disk echo
    // (a `page.content` update) hasn't arrived yet. Don't revert to the stale
    // prop while we wait for it.
    if (recentMarkdownRef.current.has(markdown) && markdown !== page.content) {
      return;
    }

    if (markdown === page.content) {
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = page.content;
      reportDirtyState(false);
      return;
    }

    acceptMarkdown(page.content);
  }, [acceptMarkdown, forceResetKey, markdown, page.content, reportDirtyState]);

  useEffect(() => {
    if (!saveBlocked || !saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    onSaveStateChange(
      pendingMarkdownRef.current === lastAcceptedMarkdownRef.current
        ? "saved"
        : "unsaved",
    );
  }, [onSaveStateChange, saveBlocked]);

  useEffect(() => {
    const previousEditorViewMode = previousEditorViewModeRef.current;
    previousEditorViewModeRef.current = editorViewMode;

    if (previousEditorViewMode !== "code" || editorViewMode !== "rich-text") {
      return;
    }

    setRichTextSourceMarkdown(markdown);
  }, [editorViewMode, markdown]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  const hasCommentRailSpace = useMemo(
    () => criticMarkdownHasReviewRail(markdown),
    [markdown],
  );

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onCommentRailPresenceChange?.(hasCommentRailSpace);
  }, [editorViewMode, hasCommentRailSpace, onCommentRailPresenceChange]);

  if (editorViewMode === "code") {
    return (
      <CodeEditorSurface
        markdown={markdown}
        filePath={activeDocumentPath}
        hasCommentRailSpace={hasCommentRailSpace}
        interactionMode={interactionMode}
        layout={layout}
        onMarkdownChange={handleMarkdownChange}
      />
    );
  }

  const effectiveRichTextSourceMarkdown =
    !localDirtyRef.current &&
    !recentMarkdownRef.current.has(page.content) &&
    markdown !== page.content
      ? page.content
      : richTextSourceMarkdown;

  return (
    <RichTextEditorSurface
      key={page.id}
      page={page}
      activeDocumentPath={activeDocumentPath}
      selected={selected}
      layout={layout}
      focusRequestKey={focusRequestKey}
      sourceMarkdown={effectiveRichTextSourceMarkdown}
      onMarkdownChange={handleMarkdownChange}
      interactionMode={interactionMode}
      commentsHidden={commentsHidden}
      onCommentRailPresenceChange={onCommentRailPresenceChange}
      onComposingCommentChange={onComposingCommentChange}
      backend={backend}
      onEditorReady={onEditorReady}
      onContentTouched={handleContentTouched}
      onSerializeReady={handleSerializeReady}
      onPublicReply={onPublicReply}
    />
  );
});

export function PageCard({
  page,
  activeDocumentPath = null,
  selected = false,
  layout = "default",
  focusRequestKey = null,
  onSave,
  onSaveStateChange,
  editorViewMode = "rich-text",
  interactionMode = "editing",
  commentsHidden = false,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onComposingCommentChange,
  onLocalContentChange,
  onSaveControllerChange,
  saveBlocked,
  forceResetKey,
  manualCommit,
  onPublicReply,
}: PageCardProps) {
  return (
    <div className="w-full">
      <PageCardEditorSurface
        page={page}
        activeDocumentPath={activeDocumentPath}
        selected={selected}
        layout={layout}
        focusRequestKey={focusRequestKey}
        onSave={onSave}
        onSaveStateChange={onSaveStateChange ?? NOOP_SAVE_STATE_CHANGE}
        editorViewMode={editorViewMode}
        interactionMode={interactionMode}
        commentsHidden={commentsHidden}
        backend={backend}
        onEditorReady={onEditorReady}
        onCommentRailPresenceChange={onCommentRailPresenceChange}
        onDirtyStateChange={onDirtyStateChange}
        onComposingCommentChange={onComposingCommentChange}
        onLocalContentChange={onLocalContentChange}
        onSaveControllerChange={onSaveControllerChange}
        saveBlocked={saveBlocked}
        forceResetKey={forceResetKey}
        manualCommit={manualCommit}
        onPublicReply={onPublicReply}
      />
    </div>
  );
}
