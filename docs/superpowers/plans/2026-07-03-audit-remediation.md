# Audit Remediation — Quick Wins + Milestone 0 + Milestone 1

Executes the actionable, well-scoped findings from the 2026-07-03 re-audit
(`.claude/audit/summaries/`). Excludes the M2 god-file refactors (PageCard /
DocumentWorkspace decomposition, autosave state machine) — those are a
separate high-risk effort. Excludes public-comment rate limiting (owner
deferred it). The runner guard is TIGHTENED to one doc (owner: "one doc is
fine"), not softened in docs.

## Global Constraints

- **Do not modify** `app/src/PageCard.tsx`, `app/src/DocumentWorkspace.tsx`,
  or the editor decoration layer in this branch — the god-file/perf refactors
  are out of scope here.
- **Never blind-replace `roughdraft`.** Only our own stale branding
  (`recodelabs/roughneck` repo references, `REPO="recodelabs/roughneck"`)
  changes to `margins`. Leave every reference to the upstream roughdraft.md
  product, CriticMarkup, and historical `docs/superpowers/*roughneck*.md`
  files untouched.
- The repo is now `github.com/recodelabs/margins.git` (verified). Fixes must
  match that reality.
- Every code task follows TDD: write/adjust the failing test first, then the
  fix. Runner tests run via `python3 -m unittest discover -s runner/tests -t .`
  from repo root. App/lib/auth tests run via `npx vitest run` from `app/`.
- After each task the full relevant suite must be green: app tasks →
  `cd app && npx vitest run && npx tsc -b`; runner tasks → the unittest
  discover command above.
- Do not weaken existing fail-closed behavior in the guard or sharing flags.
- Keep commits scoped to the task; conventional-commit messages.

## Task 1: Repo hygiene — untrack build junk, fix coverage path, patch CVE

**Description.** Remove tracked build/debug artifacts, stop them recurring,
fix the mis-pointed coverage output directory, and patch the one production
CVE. All mechanical, no product-code logic.

**Files/areas affected.**
- `.gitignore` (root) — add `__pycache__/`, `*.pyc`, `.playwright-mcp/`.
- `git rm --cached` the 16 tracked `runner/**/__pycache__/*.pyc` files and
  the 29 tracked `.playwright-mcp/*.yml` / `*.log` files (untrack only —
  leave working-tree copies; they're now ignored).
- `app/vitest.config.ts:18` — `coverage.reportsDirectory` is currently
  `"../../coverage/app"` which writes OUTSIDE the repo (verified it created
  `/Users/claudius/github/coverage/`). Change to `"../coverage/app"` (inside
  `app/`). Ensure `app/.gitignore` (or root) ignores `coverage/`.
- `app/package-lock.json` + `app/package.json` — run `cd app && npm audit fix`
  to resolve `dompurify` ≤3.4.10 (GHSA-cmwh-pvxp-8882, moderate) pulled via
  `mermaid@11`. If `npm audit fix` cannot resolve it without a breaking major
  bump, STOP and report instead of forcing `--force`.

**Acceptance criteria.**
- `git ls-files | grep -E '__pycache__|\.pyc$|\.playwright-mcp/'` returns
  nothing.
- `cd app && npx vitest run --coverage` writes to `app/coverage/`, not the
  parent of the repo; that path is gitignored.
- `cd app && npm audit --omit=dev` reports 0 vulnerabilities (or, if
  unavoidable without a breaking change, the residual is reported with
  rationale).
- `cd app && npx vitest run` still green.

**Effort:** S · **Risk:** Low · **Deps:** none.

## Task 2: Documentation truth fixes

**Description.** Correct three doc/string inaccuracies the audit confirmed
against code. No behavior change.

**Files/areas affected.**
- `README.md:52` — deletes/qualifies the false claim that patches are applied
  "with `.margins-bak` backups". The CLI makes NO backups (all three patchers
  use in-place `perl -0pi -e` / `fs.writeFileSync`). Either remove the
  "`.margins-bak` backups" phrase, or state plainly that patches are applied
  in place with no backup. (Do NOT implement backups — docs-only task.)
- `README.md` ~L17-19 and L26-32 — the "the GitHub repository is still
  `recodelabs/roughneck`" note and the `git clone .../roughneck.git` /
  re-link instructions are now stale: the repo IS `recodelabs/margins`. Update
  clone URLs and remove/adjust the "still roughneck" framing. Keep the
  historical note that the binary was formerly `roughneck` only if it's about
  the CLI rename, not the repo.
- `app/README.md:60-63` — describes the retired token-in-URL-fragment auth
  flow ("passes the token to the SPA in the URL fragment. The token is stored
  in `sessionStorage`… the fragment is immediately stripped"). Production and
  the dev middleware now use a same-origin code→POST exchange
  (`functions/api/auth/[[route]].ts:20-44`, `app/vite.config.ts:67-81`); the
  token never rides a URL fragment. Rewrite steps 3 to match the code→POST flow.
- `skills/margins/install.sh` — `REPO="recodelabs/roughneck"` and any
  `roughneck-*` tarball/dir assumptions: update to `recodelabs/margins` and
  `margins-*` to match the renamed repo. Verify the codeload tarball URL and
  the extracted-dir glob are internally consistent after the change.

**Acceptance criteria.**
- No occurrence of `.margins-bak` remains in `README.md` (grep clean) except
  as an accurate statement (there is none, so it should be gone).
- `git grep -n 'recodelabs/roughneck'` returns nothing in `README.md` or
  `skills/margins/install.sh` (historical `docs/superpowers/` untouched).
- `app/README.md` auth section describes the code→POST exchange with no
  "URL fragment" token language.
- `bash -n skills/margins/install.sh` passes.

**Effort:** S · **Risk:** Low · **Deps:** none.

## Task 3: Typecheck + lint gate over lib/, auth/, functions/

**Description.** These deployed TS files (public-sharing security modules,
OAuth Function) are executed by Vitest via esbuild (types stripped, unchecked)
and are excluded from `app/tsconfig.json` (`include: ["src"]`) and from CI's
`biome check` (runs in `app/`). Add a real typecheck + lint gate so a type
error in `lib/`/`auth/`/`functions/` fails CI instead of failing at runtime.

**Files/areas affected.**
- New root `tsconfig.json`: `include: ["lib", "auth", "functions"]`,
  `noEmit: true`, `strict: true`. Add Cloudflare Workers types so the
  Functions' `Request`/`Response`/`crypto.subtle` typecheck against the right
  lib — add `@cloudflare/workers-types` as a devDependency (root or app;
  whichever CI can resolve) and reference it via `compilerOptions.types` or
  `lib`. Resolve any REAL type errors surfaced (these are latent bugs — fix
  them minimally; if a fix is non-trivial or risky, report it rather than
  guessing).
- `.github/workflows/ci.yml` — add steps that typecheck and lint the root TS.
  Note the audit gotcha: bare `npx biome` from the repo root resolves a
  squatted `biome@0.3.3`. Use the app's installed Biome binary
  (`app/node_modules/.bin/biome check ../lib ../auth ../functions` run with
  `working-directory: app`) or an equivalent that uses `@biomejs/biome`.
  Typecheck similarly: `working-directory: app`, `npx tsc -p ../tsconfig.json`.
- If Biome flags pre-existing issues in these dirs, fix the auto-fixable ones
  and report any that need judgment; do not disable rules wholesale.

**Acceptance criteria.**
- Introducing a deliberate type error into `lib/public-doc.ts` makes
  `npx tsc -p ../tsconfig.json` (from `app/`) exit non-zero (demonstrate in
  the report, then revert the deliberate error).
- CI has a step that runs this typecheck and a Biome lint over
  `lib/`/`auth/`/`functions/`, both gating (not `continue-on-error`).
- Existing `cd app && npx tsc -b` and `npx vitest run` remain green.

**Effort:** M · **Risk:** Low · **Deps:** Task 1 (lockfile settled).

## Task 4: Bring lib/, auth/, functions/ into coverage visibility

**Description.** The coverage report and thresholds only see `app/src`, so a
regression in the security-sensitive server modules' test reach is invisible
to the gate. Include them.

**Files/areas affected.**
- `app/vitest.config.ts` — the tests already run (`include` has
  `../lib/**/*.test.ts`, `../auth/**/*.test.ts`). Add `lib/`, `auth/`, and the
  testable parts of `functions/` to `coverage.include` (paths relative to the
  vitest root; mirror how the test `include` reaches `..`). Ensure
  `coverage.include`/`all` picks up untested files so they count against
  reach. Do NOT raise thresholds in this task — just make these dirs visible;
  if adding them drops overall % below current thresholds, report the new
  numbers and leave thresholds as-is unless they now fail (if they fail,
  report — a threshold decision is the owner's).

**Acceptance criteria.**
- `cd app && npx vitest run --coverage` lists files under `lib/` and `auth/`
  (and any covered `functions/`) in the coverage report.
- The run still exits 0 (thresholds still met) OR the report clearly states
  the new percentages and which threshold would need adjustment.

**Effort:** S · **Risk:** Low · **Deps:** Task 1 (coverage dir fix).

## Task 5: Test the OAuth Function + stop leaking exception text

**Description.** `functions/api/auth/[[route]].ts` (50 lines) has zero tests
despite real branching and a security-critical no-store guarantee, and its 500
path returns raw `e.message` to the client.

**Files/areas affected.**
- `functions/api/auth/[[route]].ts:46` — the POST catch returns
  `e instanceof Error ? e.message : String(e)` in the 500 body. Change to a
  generic constant message (e.g. `"Token exchange failed"`); keep the 500
  status. Do not log the secret; logging the detail server-side is fine.
- New test file (e.g. `functions/api/auth/route.test.ts`, matched by the
  vitest root `include` — extend the include glob if needed so it runs).
  Cover: `GET /api/auth/login` builds the correct GitHub authorize URL
  (client_id, redirect_uri = `${origin}/api/auth/callback`, state passthrough)
  and carries `Cache-Control: no-store`; `GET /api/auth/callback` forwards
  `code`+`state` to `/?code=…&state=…` with `no-store` and never includes a
  token; `POST /api/auth/token` returns `{access_token}` on success and a
  GENERIC message (not `e.message`) with `no-store` on failure; unknown paths
  → 404 + `no-store`. Inject/stub `exchangeCodeForToken` or `fetch` at the
  boundary — no live network.

**Acceptance criteria.**
- New tests run in the vitest suite (visible in `npx vitest run` output) and
  assert the four behaviors above, including that the 500 body does NOT echo
  the thrown message.
- `cd app && npx vitest run` green.

**Effort:** M · **Risk:** Low · **Deps:** Task 3 (root TS typechecked),
Task 4 (functions in include glob).

## Task 6: Down-scope installation tokens to the single repo + contents:write

**Description.** `lib/installation-token.ts:55-64` mints installation tokens
with a bodyless POST, so the token carries the org-wide install's full
permission/repo set. Scope it to the one repo and contents:write — the widest
blast-radius reduction in the public-sharing path.

**Files/areas affected.**
- `lib/installation-token.ts` — the caller knows `owner`/`repo`; pass a JSON
  body `{ repositories: [repo], permissions: { contents: "write" } }` to
  `POST /app/installations/{id}/access_tokens`. Verify the callers
  (`lib/public-doc.ts`, `lib/public-comment.ts`) supply the repo name to reach
  here; thread it through if the current signature doesn't carry it. `doc.ts`
  only reads — if the function is shared, `contents: "write"` still covers
  reads, so a single write-scoped token is acceptable; do not create two code
  paths unless trivial.
- Update/extend `lib/installation-token.test.ts` to assert the request body
  now contains the scoping (`repositories` + `permissions.contents`), and that
  the existing caching/skew behavior is unchanged.

**Acceptance criteria.**
- The `access_tokens` request asserts a body scoping to `[repo]` +
  `contents:write` in the test.
- Existing token-cache/expiry tests still pass; `cd app && npx vitest run`
  green (this test lives under `lib/`, already in the vitest include).

**Effort:** S · **Risk:** Low (behavior depends on the GitHub App actually
having contents:write — it does today) · **Deps:** Task 3.

## Task 7: Runner config bounds validation

**Description.** `config.py:19-32` only checks `clonePath`/`stateDir` are
truthy. Bad intervals silently create footguns: `pollSeconds: 0` → tight
`git pull` loop; `taskTimeoutSeconds: 0` → every task instantly times out;
nonexistent `clonePath` → an error every cycle forever.

**Files/areas affected.**
- `runner/config.py` — in `load_config`, validate: `pollSeconds` is a number
  ≥ 1; `taskTimeoutSeconds` is a number > 0; `clonePath` exists and is a
  directory (and is a git working tree if cheap to check — at minimum exists);
  `stateDir` exists or is creatable. Raise the same error type the existing
  validation uses, with a clear message naming the bad field.
- `runner/tests/test_config.py` — add cases: zero/negative `pollSeconds`,
  zero `taskTimeoutSeconds`, nonexistent `clonePath` each raise with a helpful
  message; happy path still passes. Use `tmp_path`/tempdir for the
  exists-checks.

**Acceptance criteria.**
- New tests assert each invalid config raises; existing config tests pass.
- `python3 -m unittest discover -s runner/tests -t .` green.

**Effort:** S · **Risk:** Low · **Deps:** none.

## Task 8: Enforce the guard's one-doc restriction + assert it's wired

**Description.** Two gaps: (a) `guard.py:39-50` allows Edit/Write to ANY path
in the clone (except `.git`), but the advertised guarantee is "only the one
doc" — owner wants the guard to actually enforce one doc; (b) nothing tests
that `runner/settings.json` wires `guard.py` as the PreToolUse hook, and the
session runs `defaultMode: acceptEdits`, so a broken hook = unconfined
auto-accepting session.

**Files/areas affected.**
- `runner/guard.py` — restrict Edit/Write (the file-mutating tools) to the
  single doc named for the current task. The doc path is available to the
  poller via `inbox.json` (see `runner_io.py` / `poller.py` inbox schema);
  the guard must learn it the same way the session does — read the inbox
  doc path from the state dir (the guard already reads env for the clone/state
  roots; extend it to read the inbox's `docPath` and confine writes to that
  file). Reads may stay clone-wide (the session legitimately looks things up);
  only Edit/Write narrow to the one doc. Preserve ALL existing fail-closed
  behavior: empty/unset env → deny; unknown tool → deny; `.git` → deny;
  malformed inbox → deny writes (fail closed, not open). If the inbox is
  absent, deny writes.
- `runner/settings.json` / `skills/margins-runner/SKILL.md` — update the
  SKILL text so it matches the now-true one-doc enforcement (it currently says
  "the guard will block it anyway" about editing other docs — that becomes
  true).
- `runner/tests/test_guard.py` — add: Edit/Write to the inbox doc is allowed;
  Edit/Write to a DIFFERENT doc in the clone is denied; malformed/absent inbox
  → writes denied (fail closed); reads to other files still allowed;
  `.git`/traversal/empty-env denials still hold.
- New parity/wiring test (in `runner/tests/`, e.g. `test_settings_wiring.py`):
  load `runner/settings.json`, assert it registers a `PreToolUse` hook with a
  `*` matcher whose command invokes `guard.py`. Fails if the hook is removed,
  the matcher narrowed, or the command no longer points at the guard.

**Acceptance criteria.**
- New guard tests prove one-doc write confinement with fail-closed edges;
  existing guard tests unchanged and green.
- The wiring test fails if `settings.json` stops invoking `guard.py` via a
  `*` PreToolUse hook (demonstrate by temporarily breaking a copy in-test or
  asserting on the parsed structure).
- SKILL.md no longer overstates enforcement.
- `python3 -m unittest discover -s runner/tests -t .` green.

**Effort:** M · **Risk:** Med (guard is the security boundary — fail closed on
every ambiguity) · **Deps:** none.

## Task 9: Fix poller failure paths — double-apply, conflict wedge, staged no-op, unpushed replies

**Description.** Four related correctness gaps in the poller/git layer, all in
the failure paths that were never designed:
- **RUN-1 (double-apply):** the session's trigger is `inbox.json` merely
  existing (`wait-for-task.sh:9`); the poller clears it LAST, after commit +
  network push (`poller.py:110-133`), so a session that loops re-reads and
  re-applies the same instruction.
- **RUN-2/6 (conflict wedge):** `fetch_and_merge` aborts + re-raises on
  conflict (`git_ops.py:35-44`); `pull()` re-hits it every cycle forever
  (`poller.py:72`), and `pull()` runs before the doc is reset, so a crashed
  mid-edit also wedges.
- **RUN-3 (no-op crash):** `commit()` keys no-op detection off whole-repo
  `git status --porcelain` (`git_ops.py:68-75`), so an unchanged doc + any
  unrelated dirty file → `git commit` with nothing staged → raises.
- **RUN-4 (unpushed replies):** a push failure after local commit leaves
  replies committed-but-unpushed with no proactive re-push
  (`poller.py:63-67,132-133`).

**Files/areas affected.**
- `runner/wait-for-task.sh` + `runner/poller.py` (+ `runner_io.py` if the
  inbox/sentinel schema needs a claim state) — make instruction handoff
  exactly-once. Recommended (from the audit sketch): `wait-for-task.sh`
  atomically claims via `mv inbox.json inbox.claimed.json` (atomic on one FS)
  and the session reads the claimed file; the poller writes a fresh
  `inbox.json` per dispatch and `clear_task` removes both. Keep the existing
  `replyTo` matching as the second defense — do not remove it. If the guard's
  Bash allowlist (Task 8 / existing) must permit the `mv`, update it; prefer
  doing the claim inside the already-allowlisted `wait-for-task.sh`.
- `runner/git_ops.py` — `commit()` no-op check uses staged scope
  (`git diff --cached --quiet` after `git add -- <paths>`), not whole-repo
  status. `fetch_and_merge`/conflict: on merge conflict, abort and surface a
  typed "conflict" outcome the poller can turn into an error reply, rather than
  an exception that re-wedges every cycle. Reset the known doc path(s) before
  the merge in `pull()` so a stale dirty doc doesn't block it.
- `runner/poller.py` — on conflict, append an error reply + clear the task and
  continue to the next cycle (never permanent wedge). Proactively re-push any
  committed-but-unpushed state at loop start (or defer `clear_task` until push
  succeeds so a failed push retries next cycle — pick one and make it robust).
  Improve `run_forever` error logging to include a traceback (currently
  `str(exc)` only) so these paths are diagnosable.
- `runner/tests/test_process.py` + `test_git_ops.py` — add: (1) an immediate
  session re-poll between `done.json` and `clear_task` does NOT re-apply
  (double-apply guard); (2) a real same-region merge conflict yields an error
  reply and the poller proceeds to the next task (no wedge); (3) `commit()`
  no-ops cleanly when the doc is unchanged but an unrelated file is dirty
  (no raise); (4) a push failure leaves state that is re-pushed on the next
  cycle (or replies aren't marked resolved until pushed).

**Acceptance criteria.**
- Each of the four scenarios has a test that fails against the old behavior
  and passes against the new.
- No busy-loop introduced; the poller continues past a conflict instead of
  re-raising forever.
- `python3 -m unittest discover -s runner/tests -t .` green.

**Effort:** L · **Risk:** Med (touches the git-mutating core; keep changes
minimal and test-first) · **Deps:** Task 8 (guard allowlist may need the `mv`).

## Out of scope (follow-up branch)

- M2 refactors: decompose `RichTextEditorSurface` (`PageCard.tsx`) and
  `DocumentWorkspace.tsx`; replace the 5-routine/4-ref autosave with an
  explicit state machine; `DecorationSet.map` + memoized callout decorations
  (PERF-N1). High-risk, large; own effort with its own review.
- Public-comment rate limiting (SEC-N1) — owner deferred.
- CLI robustness (CLI-1 phantom-success on boot failure), activity-poll
  hidden-tab pause, capabilities adoption at remaining `info.kind` sites,
  `sneak-peek.png` compression, Vite/Tiptap bumps — Milestone 3 polish.
- OAuth client-secret rotation (QW-7) — owner action, cannot be done in-repo.
