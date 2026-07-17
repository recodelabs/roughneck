import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocationForLinkedMarkdownDocument,
  getRequestedPathState,
  PREVIEW_PATH,
  ROUGHDRAFT_FLAVORED_MARKDOWN_PATH,
  resolveDocumentFilenameLabel,
  syncRequestedPathInUrl,
} from "./app-navigation";

describe("app navigation", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("reads absolute markdown paths from the path query parameter", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2F.claude%2Fplans%2Fexample.md",
    );

    expect(getRequestedPathState()).toEqual({
      rawPath: "/Users/me/.claude/plans/example.md",
      projectPath: "/Users/me/.claude/plans",
      documentPath: "example.md",
    });
  });

  it("keeps absolute paths in the path query parameter", () => {
    window.history.replaceState(null, "", "/");

    syncRequestedPathInUrl("/Users/me/.claude/plans/example.md");

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe(
      "?path=%2FUsers%2Fme%2F.claude%2Fplans%2Fexample.md",
    );
  });

  it("does not treat reserved app pages as file paths", () => {
    window.history.replaceState(null, "", ROUGHDRAFT_FLAVORED_MARKDOWN_PATH);

    expect(getRequestedPathState()).toEqual({
      rawPath: null,
      projectPath: null,
      documentPath: null,
    });

    window.history.replaceState(null, "", PREVIEW_PATH);

    expect(getRequestedPathState()).toEqual({
      rawPath: null,
      projectPath: null,
      documentPath: null,
    });
  });

  it("builds Roughdraft routes for linked markdown documents", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2Fproject%2F.context%2Flocal-link-source.md",
    );

    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project/.context",
        currentDocumentPath: "local-link-source.md",
        href: "local-link-target.md",
      }),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2F.context%2Flocal-link-target.md");
  });

  it("resolves nested markdown links relative to the current document", () => {
    window.history.replaceState(null, "", "/");

    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project",
        currentDocumentPath: "notes/source.md",
        href: "../index.md#summary",
      }),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2Findex.md#summary");
  });

  it("leaves non-markdown links for the file resolver", () => {
    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project",
        currentDocumentPath: "source.md",
        href: "diagram.png",
      }),
    ).toBeNull();
  });
});

describe("resolveDocumentFilenameLabel", () => {
  it("names the file inside the project folder for a local backend", () => {
    expect(
      resolveDocumentFilenameLabel({
        activeDocumentPath: "notes/todo.md",
        projectPath: "/Users/me/project",
        rawPath: "/Users/me/project/notes/todo.md",
      }),
    ).toBe("todo.md");
  });

  // REC-519 follow-up: rawPath is captured once at mount, and the GitHub
  // backend exposes no projectPath. Preferring rawPath left the toolbar naming
  // whichever document the tab first opened, forever.
  it("tracks the open document when the backend has no project path", () => {
    expect(
      resolveDocumentFilenameLabel({
        activeDocumentPath: "docs/deploy-cloudflare.md",
        projectPath: undefined,
        rawPath: "/recodelabs/margins/README.md",
      }),
    ).toBe("deploy-cloudflare.md");
  });

  it("falls back to the requested path before a document is open", () => {
    expect(
      resolveDocumentFilenameLabel({
        activeDocumentPath: null,
        projectPath: undefined,
        rawPath: "/recodelabs/margins/README.md",
      }),
    ).toBe("README.md");
  });

  it("labels an untitled document when nothing is known", () => {
    expect(
      resolveDocumentFilenameLabel({
        activeDocumentPath: null,
        projectPath: undefined,
        rawPath: null,
      }),
    ).toBe("Untitled.md");
  });
});
