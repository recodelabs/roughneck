import { describe, expect, it } from "vitest";
// The server-side reader lives in the repo-root lib/ (bundled into the
// Cloudflare Function that serves public docs). It is dependency-free and cannot
// import the `yaml` package the app uses, so it re-implements the same predicate
// by hand. This test pins the two to identical, fail-closed behaviour on a shared
// fixture set — the analogue of runner/tests/test_parity.py for the sharing-flag
// semantics. If they ever drift, a doc could be served publicly while its owner's
// UI still shows it private (or vice versa).
import { readSharingFlags } from "../../lib/sharing-flags";
import { getSharingFlags } from "./sharing-frontmatter";

interface Fixture {
  name: string;
  markdown: string;
  expected: { public: boolean; comments: boolean; suggestions: boolean };
}

const FIXTURES: Fixture[] = [
  {
    name: "public: true (the happy path)",
    markdown: "---\npublic: true\n---\n\n# Body\n",
    expected: { public: true, comments: false, suggestions: false },
  },
  {
    name: "Public: true (capitalized key is NOT the flag — the reported bug)",
    markdown: "---\nPublic: true\n---\n\n# Body\n",
    expected: { public: false, comments: false, suggestions: false },
  },
  {
    name: 'public: "true" (quoted ⇒ YAML string, not boolean)',
    markdown: '---\npublic: "true"\n---\n',
    expected: { public: false, comments: false, suggestions: false },
  },
  {
    name: "public: false",
    markdown: "---\npublic: false\n---\n",
    expected: { public: false, comments: false, suggestions: false },
  },
  {
    name: "public: yes (a string in YAML 1.2, not a boolean)",
    markdown: "---\npublic: yes\n---\n",
    expected: { public: false, comments: false, suggestions: false },
  },
  {
    name: "public: TRUE (core-schema boolean spelling)",
    markdown: "---\npublic: TRUE\n---\n",
    expected: { public: true, comments: false, suggestions: false },
  },
  {
    name: "no frontmatter at all",
    markdown: "# Just a body\n\npublic: true\n",
    expected: { public: false, comments: false, suggestions: false },
  },
  {
    name: "malformed YAML with unbalanced flow collection ⇒ fail closed",
    markdown: "---\npublic: true\ntags: [a, b\n---\n",
    expected: { public: false, comments: false, suggestions: false },
  },
  {
    name: "all three flags, mixed, alongside a balanced list value",
    markdown:
      "---\ntags: [a, b]\npublic: true\ncomments: true\nsuggestions: false\n---\n# Body\n",
    expected: { public: true, comments: true, suggestions: false },
  },
  {
    name: "comments + suggestions true, public false",
    markdown: "---\ncomments: true\nsuggestions: true\npublic: false\n---\n",
    expected: { public: false, comments: true, suggestions: true },
  },
  {
    name: "public: true # inline comment",
    markdown: "---\npublic: true # opt in\n---\n",
    expected: { public: true, comments: false, suggestions: false },
  },
];

describe("sharing-flag parity: readSharingFlags (server) vs getSharingFlags (app)", () => {
  for (const { name, markdown, expected } of FIXTURES) {
    it(`agrees on: ${name}`, () => {
      const server = readSharingFlags(markdown);
      const app = getSharingFlags(markdown);
      // Both must equal the fail-closed expectation...
      expect(app).toEqual(expected);
      expect(server).toEqual(expected);
      // ...and therefore each other.
      expect(server).toEqual(app);
    });
  }

  it("never serves public when the app calls it private (fail-closed invariant)", () => {
    // Spot-check the security direction directly: server.public ⇒ app.public.
    for (const { markdown } of FIXTURES) {
      const server = readSharingFlags(markdown);
      const app = getSharingFlags(markdown);
      if (server.public) expect(app.public).toBe(true);
    }
  });
});
