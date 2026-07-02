import type {
  MarkType,
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

import { type CriticChangeAttrs, createCriticChange } from "./critic-markup";

/**
 * Pure transaction-building engine for suggesting mode.
 *
 * `PageCard.tsx` hosts four editor-prop handlers — paste, text input, cut and
 * backspace/delete — that all manipulate critic-change marks while editing in
 * suggesting mode. They previously hand-copied the same segment/mark logic four
 * times. These functions are the single source of truth: each takes an
 * `EditorState`, a range and a {@link SuggestionContext} and returns a
 * `Transaction` the caller dispatches. They never read React refs or dispatch
 * themselves, so `suggesting-mode.test.ts` can exercise them directly.
 */

/** A run of text inside a range, flagged as suggested-insertion or original. */
export type SuggestionSegment = {
  from: number;
  to: number;
  isAddition: boolean;
};

/**
 * Everything the engine needs to mint critic-change marks, supplied by the
 * caller so the functions stay pure.
 *
 * - `markType` is the `criticChange` mark type from the editor schema.
 * - `changeAttrs` seeds {@link createCriticChange} (production passes
 *   `{ authorId }`; tests pass `undefined`).
 * - `existingChanges` lets {@link createCriticChange} avoid id collisions.
 */
export interface SuggestionContext {
  markType: MarkType;
  changeAttrs?: Partial<CriticChangeAttrs>;
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>;
}

const isAdditionKindFor = (markType: MarkType) => (mark: ProseMirrorMark) =>
  mark.type === markType &&
  (mark.attrs.kind === "addition" || mark.attrs.kind === "substitution-new");

/**
 * Walk the text nodes in `[from, to)` and coalesce them into contiguous
 * segments, each flagged as suggested-insertion (addition / substitution-new)
 * or original text. This is the routine that was duplicated across all four
 * handlers and their test forks.
 */
export function collectSuggestionSegments(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  markType: MarkType,
): SuggestionSegment[] {
  const isAdditionKind = isAdditionKindFor(markType);
  const segments: SuggestionSegment[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const isAdd = node.marks.some(isAdditionKind);
    const prev = segments[segments.length - 1];
    if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
      prev.to = segTo;
    } else {
      segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
    }
  });

  return segments;
}

/**
 * Find an adjacent addition / substitution-new mark at `position` so newly
 * typed or pasted text joins the existing suggestion instead of starting a new
 * one. Looks before the position first, then after.
 */
export function findReusableInputMark(
  doc: ProseMirrorNode,
  position: number,
  markType: MarkType,
): ProseMirrorMark | null {
  const isReusable = (mark: ProseMirrorMark) =>
    mark.type === markType &&
    (mark.attrs.kind === "addition" || mark.attrs.kind === "substitution-new");
  const $position = doc.resolve(position);

  return (
    $position.nodeBefore?.marks.find(isReusable) ??
    $position.nodeAfter?.marks.find(isReusable) ??
    null
  );
}

/**
 * Find an adjacent deletion mark spanning `[from, to)` so a fresh deletion
 * coalesces with an existing one rather than fragmenting it.
 */
export function findReusableDeletionMark(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  markType: MarkType,
): ProseMirrorMark | null {
  const isReusable = (mark: ProseMirrorMark) =>
    mark.type === markType && mark.attrs.kind === "deletion";

  return (
    doc.resolve(from).nodeBefore?.marks.find(isReusable) ??
    doc.resolve(to).nodeAfter?.marks.find(isReusable) ??
    null
  );
}

/**
 * Build the transaction for inserting `text` in suggesting mode — the shared
 * engine behind `handlePaste` and `handleTextInput`.
 *
 * - Collapsed caret: insert `text` carrying a reused or fresh addition mark.
 * - Range over original text: delete addition segments, mark original segments
 *   `substitution-old`, then insert `text` as `substitution-new`.
 * - Range over only addition text: delete it, then insert `text` as a fresh /
 *   reused addition.
 */
export function buildSuggestionInputTransaction(
  state: EditorState,
  range: { from: number; to: number },
  text: string,
  ctx: SuggestionContext,
): Transaction {
  const { from, to } = range;
  const { markType } = ctx;
  const tr = state.tr;

  if (from !== to) {
    const segments = collectSuggestionSegments(state.doc, from, to, markType);
    const hasOriginalText = segments.some((s) => !s.isAddition);

    if (hasOriginalText) {
      const oldChange = createCriticChange(
        "substitution-old",
        ctx.changeAttrs,
        {
          existingChanges: ctx.existingChanges,
        },
      );
      const newMark = markType.create({
        ...oldChange,
        kind: "substitution-new",
      });

      for (const seg of [...segments].reverse()) {
        if (seg.isAddition) {
          tr.delete(seg.from, seg.to);
        } else {
          tr.addMark(seg.from, seg.to, markType.create(oldChange));
        }
      }

      const insertPos = tr.mapping.map(to, -1);
      tr.insert(insertPos, state.schema.text(text, [newMark]));
      tr.setSelection(TextSelection.create(tr.doc, insertPos + text.length));
    } else {
      for (const seg of [...segments].reverse()) {
        tr.delete(seg.from, seg.to);
      }
      const insertPos = tr.mapping.map(from, -1);
      const mark =
        findReusableInputMark(state.doc, insertPos, markType) ??
        markType.create(
          createCriticChange("addition", ctx.changeAttrs, {
            existingChanges: ctx.existingChanges,
          }),
        );
      tr.insert(insertPos, state.schema.text(text, [mark]));
      tr.setSelection(TextSelection.create(tr.doc, insertPos + text.length));
    }
  } else {
    const mark =
      findReusableInputMark(state.doc, from, markType) ??
      markType.create(
        createCriticChange("addition", ctx.changeAttrs, {
          existingChanges: ctx.existingChanges,
        }),
      );
    tr.insert(from, state.schema.text(text, [mark]));
    tr.setSelection(TextSelection.create(tr.doc, from + text.length));
  }

  return tr;
}

/**
 * Build a transaction that flags an already-inserted range `[from, to)` as a
 * suggested addition. Used for insertions that cannot flow through
 * {@link buildSuggestionInputTransaction} because the content is applied
 * out-of-band: the context-menu "Paste Markdown" action inserts rich HTML, and
 * IME/composition input is committed by the browser on `compositionend` without
 * ever reaching `handleTextInput`.
 *
 * Runs already carrying an addition / substitution-new mark are left untouched
 * so we never re-mint change ids or double-mark; only original or unmarked runs
 * receive a reused (adjacent) or fresh addition mark. Returns an unchanged
 * transaction when the range is collapsed or already fully marked, so callers
 * can guard on `tr.docChanged`.
 */
export function buildSuggestionMarkAdditionTransaction(
  state: EditorState,
  range: { from: number; to: number },
  ctx: SuggestionContext,
): Transaction {
  const { from, to } = range;
  const { markType } = ctx;
  const tr = state.tr;

  if (from >= to) return tr;

  const segments = collectSuggestionSegments(state.doc, from, to, markType);
  // Reuse one mark across every gap: an adjacent addition if present, otherwise
  // a single fresh addition so the whole insertion shares one change id.
  const mark =
    findReusableInputMark(state.doc, from, markType) ??
    markType.create(
      createCriticChange("addition", ctx.changeAttrs, {
        existingChanges: ctx.existingChanges,
      }),
    );

  for (const seg of segments) {
    if (seg.isAddition) continue;
    tr.addMark(seg.from, seg.to, mark);
  }

  return tr;
}

/**
 * Build the transaction for deleting `[from, to)` in suggesting mode — the
 * shared engine behind cut and backspace/delete. Addition / substitution-new
 * segments are truly removed; original segments get a deletion mark.
 *
 * `selectionBasePos` controls the resulting caret: backspace/delete pass the
 * anchor position (`from` for Backspace, `to` for Delete) to re-place the
 * caret; cut passes `null`/omits it to leave the selection alone.
 */
export function buildSuggestionDeleteTransaction(
  state: EditorState,
  range: { from: number; to: number },
  ctx: SuggestionContext,
  options?: { selectionBasePos?: number | null },
): Transaction {
  const { from, to } = range;
  const { markType } = ctx;
  const segments = collectSuggestionSegments(state.doc, from, to, markType);
  const tr = state.tr;

  // Process right-to-left so earlier positions stay valid.
  for (const seg of [...segments].reverse()) {
    if (seg.isAddition) {
      tr.delete(seg.from, seg.to);
    } else {
      const deletionMark =
        findReusableDeletionMark(state.doc, seg.from, seg.to, markType) ??
        markType.create(
          createCriticChange("deletion", ctx.changeAttrs, {
            existingChanges: ctx.existingChanges,
          }),
        );
      tr.addMark(seg.from, seg.to, deletionMark);
    }
  }

  const basePos = options?.selectionBasePos;
  if (basePos != null) {
    const mappedPos = tr.mapping.map(basePos, -1);
    tr.setSelection(TextSelection.create(tr.doc, mappedPos));
  }

  return tr;
}

/**
 * Resolve the range a Backspace/Delete keypress should act on when the
 * selection is an empty caret, expanding by one character or — when
 * `byWord` (Ctrl/Alt held) — to the adjacent word, without crossing the
 * surrounding textblock's boundaries. Non-empty selections are returned as-is.
 */
export function computeKeyboardDeleteRange(
  state: EditorState,
  key: "Backspace" | "Delete",
  byWord: boolean,
): { from: number; to: number } {
  const { selection } = state;
  let from = selection.from;
  let to = selection.to;

  if (selection.empty) {
    const $pos = state.doc.resolve(selection.from);
    const blockStart = $pos.start($pos.depth);
    const blockEnd = $pos.end($pos.depth);

    if (key === "Backspace") {
      if (byWord) {
        const textBefore = state.doc.textBetween(blockStart, selection.from);
        const match = textBefore.match(/\S+\s*$/);
        from = match
          ? selection.from - match[0].length
          : Math.max(blockStart, selection.from - 1);
      } else {
        from = Math.max(blockStart, selection.from - 1);
      }
    } else {
      if (byWord) {
        const textAfter = state.doc.textBetween(selection.to, blockEnd);
        const match = textAfter.match(/^\s*\S+/);
        to = match
          ? selection.to + match[0].length
          : Math.min(blockEnd, selection.to + 1);
      } else {
        to = Math.min(blockEnd, selection.to + 1);
      }
    }
  }

  return { from, to };
}
