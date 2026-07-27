import { describe, expect, it } from "vitest";
import {
  buildDocumentPaletteCommands,
  type DocumentPaletteContext,
  filterCommands,
  fuzzyScore,
  type PaletteCommand,
} from "./command-palette";

const markdownDoc: DocumentPaletteContext = {
  readOnly: false,
  isMarkdownDoc: true,
  suggesting: false,
  isGitHubBackend: false,
  hasGitHubNav: false,
  files: [],
};

describe("buildDocumentPaletteCommands", () => {
  it("offers PDF export for a markdown document", () => {
    const ids = buildDocumentPaletteCommands(markdownDoc).map((c) => c.id);
    expect(ids).toContain("action:print");
  });

  it("offers PDF export to read-only viewers too", () => {
    const commands = buildDocumentPaletteCommands({
      ...markdownDoc,
      readOnly: true,
    });
    expect(commands.map((c) => c.id)).toContain("action:print");
  });

  it("omits PDF export for non-markdown files", () => {
    const commands = buildDocumentPaletteCommands({
      ...markdownDoc,
      isMarkdownDoc: false,
    });
    expect(commands.map((c) => c.id)).not.toContain("action:print");
  });

  it("finds PDF export by searching for 'print'", () => {
    const commands = buildDocumentPaletteCommands(markdownDoc);
    const ids = filterCommands(commands, "print").map((c) => c.id);
    expect(ids).toContain("action:print");
  });
});

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("Toggle theme", "xyz")).toBeNull();
    expect(fuzzyScore("abc", "abcd")).toBeNull();
  });

  it("matches a subsequence case-insensitively", () => {
    expect(fuzzyScore("Toggle theme", "tgt")).not.toBeNull();
    expect(fuzzyScore("Toggle Theme", "TOGGLE")).not.toBeNull();
  });

  it("returns a neutral (non-null) score for an empty query", () => {
    expect(fuzzyScore("anything", "")).not.toBeNull();
  });

  it("scores an exact match above a prefix match", () => {
    const exact = fuzzyScore("save", "save");
    const prefix = fuzzyScore("save document", "save");
    expect(exact).not.toBeNull();
    expect(prefix).not.toBeNull();
    expect(exact as number).toBeGreaterThan(prefix as number);
  });

  it("scores a prefix match above a scattered subsequence", () => {
    const prefix = fuzzyScore("share", "sh");
    const scattered = fuzzyScore("switch theme", "sh"); // s...h
    expect(prefix).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix as number).toBeGreaterThan(scattered as number);
  });

  it("rewards word-boundary matches (acronym-style)", () => {
    // "sb" hits the start of each word in "Switch branch".
    const boundary = fuzzyScore("Switch branch", "sb");
    const scattered = fuzzyScore("subtle", "sb"); // s...b mid-word
    expect(boundary).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(boundary as number).toBeGreaterThan(scattered as number);
  });
});

describe("filterCommands", () => {
  const commands: PaletteCommand[] = [
    { id: "save", title: "Save", group: "Actions" },
    {
      id: "theme",
      title: "Toggle theme",
      group: "Actions",
      keywords: ["dark"],
    },
    { id: "suggest", title: "Toggle suggesting mode", group: "Actions" },
    { id: "branch", title: "Switch branch", group: "Actions" },
    { id: "share", title: "Open share", group: "Actions" },
  ];

  it("returns all commands in original order for an empty query", () => {
    expect(filterCommands(commands, "").map((c) => c.id)).toEqual([
      "save",
      "theme",
      "suggest",
      "branch",
      "share",
    ]);
    expect(filterCommands(commands, "   ").map((c) => c.id)).toEqual(
      commands.map((c) => c.id),
    );
  });

  it("drops commands that do not match", () => {
    const ids = filterCommands(commands, "save").map((c) => c.id);
    expect(ids).toEqual(["save"]);
  });

  it("ranks a prefix match above a scattered one", () => {
    // "sh" prefixes "share" and is scattered in "Switch ... " / "suggesting".
    const ids = filterCommands(commands, "sh").map((c) => c.id);
    expect(ids[0]).toBe("share");
  });

  it("matches via keywords as well as the title", () => {
    const ids = filterCommands(commands, "dark").map((c) => c.id);
    expect(ids).toContain("theme");
  });

  it("is stable for commands that score equally", () => {
    const tie: PaletteCommand[] = [
      { id: "a", title: "Toggle alpha", group: "Actions" },
      { id: "b", title: "Toggle bravo", group: "Actions" },
    ];
    // "toggle" prefixes both equally → original order preserved.
    expect(filterCommands(tie, "toggle").map((c) => c.id)).toEqual(["a", "b"]);
  });
});
