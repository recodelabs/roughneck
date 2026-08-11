import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { createEditorExtensions } from "./editor-extensions";
import {
  buildSuggestionDeleteTransaction,
  buildSuggestionInputTransaction,
  buildSuggestionMarkAdditionTransaction,
  computeKeyboardDeleteRange,
} from "./suggesting-mode";

/**
 * Helper: build a tiptap Editor in JSDOM with the standard Roughdraft
 * extensions. Returns the editor after `onCreate` has fired.
 */
function createTestEditor(html?: string): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: html,
  });
}

/**
 * Helper: simulate one character of text input in suggesting mode.
 *
 * Drives the production `buildSuggestionInputTransaction` engine for the
 * collapsed-caret case, matching PageCard's handleTextInput.
 */
function suggestingTypeChar(editor: Editor, char: string) {
  const { state } = editor.view;
  if (state.selection.from !== state.selection.to) {
    throw new Error("suggestingTypeChar does not support range selections");
  }

  const tr = buildSuggestionInputTransaction(
    state,
    { from: state.selection.from, to: state.selection.to },
    char,
    { markType: state.schema.marks.criticChange, existingChanges: [] },
  );
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate a Backspace press in suggesting mode.
 *
 * Drives the production `computeKeyboardDeleteRange` +
 * `buildSuggestionDeleteTransaction` engine — the same calls PageCard's
 * handleKeyDown makes.
 */
function suggestingBackspace(editor: Editor) {
  const { state } = editor.view;
  const { from, to } = computeKeyboardDeleteRange(state, "Backspace", false);
  if (from === to) return;

  const tr = buildSuggestionDeleteTransaction(
    state,
    { from, to },
    { markType: state.schema.marks.criticChange, existingChanges: [] },
    { selectionBasePos: from },
  );
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate Ctrl+Backspace (word-delete backward) in suggesting mode.
 */
function suggestingCtrlBackspace(editor: Editor) {
  const { state } = editor.view;
  const { from, to } = computeKeyboardDeleteRange(state, "Backspace", true);
  if (from === to) return;

  const tr = buildSuggestionDeleteTransaction(
    state,
    { from, to },
    { markType: state.schema.marks.criticChange, existingChanges: [] },
    { selectionBasePos: from },
  );
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate Ctrl+Delete (word-delete forward) in suggesting mode.
 */
function suggestingCtrlDelete(editor: Editor) {
  const { state } = editor.view;
  const { from, to } = computeKeyboardDeleteRange(state, "Delete", true);
  if (from === to) return;

  const tr = buildSuggestionDeleteTransaction(
    state,
    { from, to },
    { markType: state.schema.marks.criticChange, existingChanges: [] },
    { selectionBasePos: to },
  );
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate Cut (Ctrl+X) in suggesting mode.
 *
 * Drives the production `buildSuggestionDeleteTransaction` engine with no
 * `selectionBasePos`, matching PageCard's cut handler: addition text is truly
 * deleted, original text gets a deletion mark, and the selection is left alone.
 */
function suggestingCut(editor: Editor) {
  const { state } = editor.view;
  const { selection } = state;
  if (selection.empty) return;

  const tr = buildSuggestionDeleteTransaction(
    state,
    { from: selection.from, to: selection.to },
    { markType: state.schema.marks.criticChange, existingChanges: [] },
  );
  editor.view.dispatch(tr.scrollIntoView());
}

/**
 * Helper: simulate type-with-selection in suggesting mode.
 *
 * Drives the production `buildSuggestionInputTransaction` engine for the
 * range case, matching PageCard's handleTextInput: addition text is truly
 * deleted, original text becomes a substitution.
 */
function suggestingTypeWithSelection(editor: Editor, text: string) {
  const { state } = editor.view;
  const tr = buildSuggestionInputTransaction(
    state,
    { from: state.selection.from, to: state.selection.to },
    text,
    { markType: state.schema.marks.criticChange, existingChanges: [] },
  );
  editor.view.dispatch(tr.scrollIntoView());
}

function getMarks(editor: Editor): Array<{ text: string; kind: string }> {
  const marks: Array<{ text: string; kind: string }> = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === "criticChange") {
        marks.push({ text: node.text ?? "", kind: mark.attrs.kind as string });
      }
    }
  });
  return marks;
}

describe("suggesting mode type-over inside an insertion", () => {
  it("should replace addition text in-place when typing over a selection that is entirely within an addition", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    for (const char of " threr") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello threr world");

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 9, 12),
      ),
    );

    suggestingTypeWithSelection(editor, "ere");

    expect(editor.state.doc.textContent).toBe("Hello there world");

    const marks = getMarks(editor);
    expect(
      marks.some(
        (mark) =>
          mark.kind === "substitution-old" || mark.kind === "substitution-new",
      ),
    ).toBe(false);
    expect(marks.some((mark) => mark.kind === "addition")).toBe(true);

    editor.destroy();
  });

  it("should still create a substitution when typing over original text", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 7, 12),
      ),
    );

    suggestingTypeWithSelection(editor, "planet");

    expect(editor.state.doc.textContent).toBe("Hello worldplanet");

    const marks = getMarks(editor);
    expect(marks.some((mark) => mark.kind === "substitution-old")).toBe(true);
    expect(marks.some((mark) => mark.kind === "substitution-new")).toBe(true);

    editor.destroy();
  });
});

describe("suggesting mode backspace inside an insertion", () => {
  it("should delete the last character of a suggested insertion rather than marking it as a deletion", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor at end of "Hello" (position 6 in ProseMirror)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    // Type " there" in suggesting mode → creates an addition mark
    for (const char of " there") {
      suggestingTypeChar(editor, char);
    }

    // Verify the addition mark exists
    let hasAdditionMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "addition"
        ) {
          hasAdditionMark = true;
        }
      }
    });
    expect(hasAdditionMark).toBe(true);

    // The full text should now be "Hello there world"
    expect(editor.state.doc.textContent).toBe("Hello there world");

    // Now press Backspace — this should delete "e" from the addition,
    // leaving "Hello ther world" with "addition" mark on " ther"
    suggestingBackspace(editor);

    // Correct behaviour: "e" is simply removed because it was part of the
    // user's own suggested insertion — it was never committed content.
    expect(editor.state.doc.textContent).toBe("Hello ther world");

    // No deletion mark should exist
    let hasDeletionMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "deletion"
        ) {
          hasDeletionMark = true;
        }
      }
    });
    expect(hasDeletionMark).toBe(false);

    editor.destroy();
  });

  it("should still mark original text as a deletion when backspacing", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor after "Hello " (position 7)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)),
    );

    // Backspace on original text → should create a deletion mark
    suggestingBackspace(editor);

    // The text content stays the same (deletion marks don't remove text)
    expect(editor.state.doc.textContent).toBe("Hello world");

    // There should be a deletion mark on the space character
    let hasDeletionMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "deletion"
        ) {
          hasDeletionMark = true;
        }
      }
    });
    expect(hasDeletionMark).toBe(true);

    editor.destroy();
  });

  it("should fully remove a suggested insertion when all characters are backspaced", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    // Type "X" in suggesting mode
    suggestingTypeChar(editor, "X");
    expect(editor.state.doc.textContent).toBe("HelloX world");

    // Backspace "X" — should completely remove it
    suggestingBackspace(editor);
    expect(editor.state.doc.textContent).toBe("Hello world");

    // No critic marks should remain
    let hasCriticMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (mark.type.name === "criticChange") {
          hasCriticMark = true;
        }
      }
    });
    expect(hasCriticMark).toBe(false);

    editor.destroy();
  });
});

describe("Ctrl+Backspace should not cross paragraph boundaries", () => {
  it("should not mark text from the previous paragraph when Ctrl+Backspace is pressed at the start of a paragraph", () => {
    const editor = createTestEditor(
      "<p>First paragraph</p><p>Second paragraph</p>",
    );

    // Place cursor at the start of "Second paragraph"
    // Doc structure: <doc><p>First paragraph</p><p>Second paragraph</p></doc>
    // Position 1: start of first paragraph
    // Position 16: end of "First paragraph" (15 chars)
    // Position 17: after first paragraph close
    // Position 18: start of second paragraph content
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 18)),
    );

    // Ctrl+Backspace should not reach into the first paragraph
    suggestingCtrlBackspace(editor);

    // The first paragraph should be untouched — no deletion marks
    const marks = getMarks(editor);
    const firstParagraphDeletions = marks.filter(
      (m) => m.kind === "deletion" && "First paragraph".includes(m.text),
    );
    expect(firstParagraphDeletions).toHaveLength(0);

    editor.destroy();
  });
});

describe("Ctrl+Delete should not cross paragraph boundaries", () => {
  it("should not mark text from the next paragraph when Ctrl+Delete is pressed at the end of a paragraph", () => {
    const editor = createTestEditor(
      "<p>First paragraph</p><p>Second paragraph</p>",
    );

    // Place cursor at the end of "First paragraph" (position 16)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 16)),
    );

    // Ctrl+Delete should not reach into the second paragraph
    suggestingCtrlDelete(editor);

    // The second paragraph should be untouched — no deletion marks
    const marks = getMarks(editor);
    const secondParagraphDeletions = marks.filter(
      (m) => m.kind === "deletion" && "Second paragraph".includes(m.text),
    );
    expect(secondParagraphDeletions).toHaveLength(0);

    editor.destroy();
  });
});

describe("Cut in suggesting mode should delete addition text, not mark it", () => {
  it("should truly delete addition text when cutting a selection that includes it", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor at end of "Hello" and type " new" as suggestion
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select " new" (positions 6..10 — the addition text)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 6, 10),
      ),
    );

    // Cut — addition text should be deleted, not marked as deletion
    suggestingCut(editor);

    // The addition text should be gone
    expect(editor.state.doc.textContent).toBe("Hello world");

    // No deletion marks should exist (the addition text was never committed)
    const marks = getMarks(editor);
    const deletionMarks = marks.filter((m) => m.kind === "deletion");
    expect(deletionMarks).toHaveLength(0);

    editor.destroy();
  });

  it("should mark original text as deletion and delete addition text in a mixed selection", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Type " new" after "Hello"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select "o new w" — includes original "o", addition " new", and original " w"
    // In the doc: "Hello new world"
    //              ^    ^^^^
    // Position 5 = "o", positions 6-9 = " new" (addition), position 10 = " ", position 11 = "w"
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 5, 12),
      ),
    );

    suggestingCut(editor);

    // Addition text " new" should be deleted; "o" and " w" should have deletion marks
    const marks = getMarks(editor);
    const additionMarks = marks.filter((m) => m.kind === "addition");
    expect(additionMarks).toHaveLength(0);

    const deletionMarks = marks.filter((m) => m.kind === "deletion");
    expect(deletionMarks.length).toBeGreaterThan(0);

    editor.destroy();
  });
});

describe("buildSuggestionMarkAdditionTransaction captures out-of-band inserts", () => {
  function additionChangeIds(editor: Editor): Set<string> {
    const ids = new Set<string>();
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "addition"
        ) {
          ids.add(mark.attrs.changeId as string);
        }
      }
    });
    return ids;
  }

  it("marks a programmatically inserted (untracked) range as an addition", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Simulate a context-menu paste / IME commit: text lands with no mark.
    editor.view.dispatch(
      editor.state.tr.insert(6, editor.state.schema.text("brave ")),
    );

    const tr = buildSuggestionMarkAdditionTransaction(
      editor.state,
      { from: 6, to: 6 + "brave ".length },
      { markType: editor.state.schema.marks.criticChange, existingChanges: [] },
    );
    expect(tr.docChanged).toBe(true);
    editor.view.dispatch(tr);

    const marks = getMarks(editor);
    expect(
      marks.some((m) => m.kind === "addition" && m.text.includes("brave")),
    ).toBe(true);
    // Original text must not be swept into the addition.
    expect(marks.some((m) => m.text.includes("Hello"))).toBe(false);

    editor.destroy();
  });

  it("reuses an adjacent addition mark so the inserted run coalesces", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of "new") {
      suggestingTypeChar(editor, char);
    }
    // Caret now sits at 9, just after the "new" addition.
    editor.view.dispatch(
      editor.state.tr.insert(9, editor.state.schema.text("er")),
    );

    const tr = buildSuggestionMarkAdditionTransaction(
      editor.state,
      { from: 9, to: 11 },
      { markType: editor.state.schema.marks.criticChange, existingChanges: [] },
    );
    editor.view.dispatch(tr);

    // "new" + "er" should belong to a single addition, not two change ids.
    expect(additionChangeIds(editor).size).toBe(1);

    editor.destroy();
  });

  it("leaves an already-tracked addition untouched (no re-mark, no re-mint)", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of "new") {
      suggestingTypeChar(editor, char);
    }
    const idsBefore = additionChangeIds(editor);

    const tr = buildSuggestionMarkAdditionTransaction(
      editor.state,
      { from: 6, to: 9 },
      { markType: editor.state.schema.marks.criticChange, existingChanges: [] },
    );
    expect(tr.docChanged).toBe(false);

    expect([...additionChangeIds(editor)]).toEqual([...idsBefore]);

    editor.destroy();
  });

  it("returns an unchanged transaction for a collapsed range", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    const tr = buildSuggestionMarkAdditionTransaction(
      editor.state,
      { from: 3, to: 3 },
      { markType: editor.state.schema.marks.criticChange, existingChanges: [] },
    );
    expect(tr.docChanged).toBe(false);

    editor.destroy();
  });
});

describe("Type-with-selection should delete addition text, not mark as substitution-old", () => {
  it("should delete addition text and insert new addition when typing over a suggestion", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Type " new" after "Hello"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select " new" (the addition text at positions 6-10)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 6, 10),
      ),
    );

    // Type " replaced" over the selection
    suggestingTypeWithSelection(editor, " replaced");

    // The addition text should be replaced, not marked as substitution-old
    const marks = getMarks(editor);
    const subOldMarks = marks.filter((m) => m.kind === "substitution-old");
    expect(subOldMarks).toHaveLength(0);

    // The new text should be an addition (or substitution-new if mixed)
    expect(editor.state.doc.textContent).toContain("replaced");

    editor.destroy();
  });
});
