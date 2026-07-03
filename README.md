# margins

A repo browser and enhancement layer for [Roughdraft](https://www.roughdraft.md/) — the local-first
markdown review app for coding agents.

`margins` lets you serve any folder's markdown over your LAN and review it in Roughdraft, with a
set of quality-of-life enhancements layered on top:

- **Repo file browser** at the server root (`/`) — browse folders & markdown files, click to open.
- **Mermaid diagrams** rendered inline, with **click-to-zoom** (pan + wheel zoom modal).
- **Obsidian `[[wikilinks]]`** rendered as real links (color, no brackets) that open the linked note.
- **Wider content column** (incl. when the comment view is open).
- **Light / Auto theme toggle** (defaults to light).
- **Reliability fixes** for Roughdraft's SPA routing (deep-link reloads, URL flip-flop).
- One server **per folder**, network-exposed (`0.0.0.0`) so other devices on your LAN can review.

> **Note on the name:** the project (repo, CLI, assets, and hosted app) was formerly named
> `roughneck`; it has since been renamed to **margins**, and the GitHub repository itself is now
> `recodelabs/margins`.

## Install

Requires `node`, `jq`, `curl`, and a global Roughdraft install (`npm i -g roughdraft`).

```bash
git clone https://github.com/recodelabs/margins.git
ln -sf "$PWD/margins/margins" /opt/homebrew/bin/margins   # or anywhere on your PATH
```

> Upgrading from the old `roughneck` CLI? This is a clean break — there is no `roughneck` alias.
> Re-point your symlink at the renamed binary and drop the old one:
> `ln -sf "$PWD/margins/margins" /opt/homebrew/bin/margins && rm -f /opt/homebrew/bin/roughneck`.

## Usage

```bash
margins [--local] [--no-open] [FOLDER] [FILE.md]   # serve FOLDER (default: cwd); optionally open FILE
margins list                                       # show running servers
margins stop [FOLDER|all]                          # stop a server
margins enhance                                    # (re)apply the in-browser enhancements
```

- Default binds to `0.0.0.0` so devices on your LAN can reach it at `http://<host>.local:<port>/`.
  Use `--local` to bind loopback only.
- The root URL (`http://<host>.local:<port>/`) is the **repo browser**.
- A subtle **⬡ margins** chip (top-left, on doc pages) returns you to the browser.

## How it works

`margins` is a thin shell wrapper around Roughdraft's own server (`child.js`), plus a set of
**patches applied to the installed Roughdraft** on every run (idempotent, re-applied after
upgrades, in place — no backup files):

| Patch | Target | Why |
|---|---|---|
| Enhancement script | `app/dist/index.html` (injects `assets/margins-enhance.js`) | All the in-browser features below |
| SPA fallback fix | `server/dist/index.js` | `res.sendFile(absolutePath)` 404s under Express 5 → deep-link reloads broke |
| URL normalization | `app/dist/assets/index-*.js` (`patch-url.mjs`) | The app flip-flopped `/x` ↔ `/?path=/x` on reload and sometimes dropped to the landing page |

The enhancement patch is a clean break from the old `roughneck` injection: when it finds a stale
`roughneck-enhance` script tag in a previously-patched install, it strips it before injecting
`margins-enhance.js`, so the renamed CLI re-patches cleanly instead of double-injecting.

### The ProseMirror constraint (important for contributors)

Roughdraft renders documents in a **ProseMirror** editor that **actively reverts any change to its
own DOM** — inline styles, injected nodes, everything. So `margins-enhance.js` follows two rules:

1. **Never mutate the editor DOM.** Diagrams and wikilinks are drawn as **overlays appended to the
   page's scroll container** (so they scroll natively) and positioned over the source text.
2. **Reserve space / hide source via an external stylesheet**, not inline styles — ProseMirror can't
   see stylesheet rules, so it won't fight them. Per-element sizing is done with `nth-child` rules
   keyed to each block's position.

Everything is plain ES5-ish browser JS in `assets/margins-enhance.js`, organized in sections
(1: width, 2: theme, 3: mermaid, 4: wikilinks, 5: browser).

## Files

```
margins                         # the CLI
assets/margins-enhance.js       # in-browser enhancements (the bulk of the logic)
assets/mermaid.min.js           # bundled mermaid (fallback renderer; primary is mermaid via CDN)
assets/patch-url.mjs            # the SPA URL-normalization patch
```

## The hosted app

`app/` is the **hosted margins app** — a browser-only, GitHub-backed fork of the Roughdraft
CriticMarkup editor. It opens a markdown file straight from a GitHub repo, lets you comment and
suggest edits in [Roughdraft-flavored Markdown](https://www.roughdraft.md/), and commits your
review back to the branch. It runs entirely client-side (no server of its own) and is deployed as a
static SPA plus one stateless OAuth Function — see [`app/README.md`](app/README.md) for development
and [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md) for deployment.

## Answering instructions automatically (the runner)

When someone reading a doc in the hosted app sends an instruction ("apply these comments",
"rewrite this section"), the app commits it to a log file **in that doc's own repo** —
`.margins/<docPath>.activity.jsonl` — and then polls that log for a reply. Nothing answers it
until you run the **runner** (`runner/`), which watches those logs, applies the instruction, and
pushes the reply back. See [`runner/README.md`](runner/README.md) for the full walkthrough and the
safety model; the essentials:

- **Two processes.** A **poller** (`runner/poller.py`, plain Python — does all the git/network and
  cannot be prompt-injected) hands one pending instruction to a **strict session**
  (`runner/launch-session.sh`, a locked-down `claude` session that the `runner/guard.py` hook
  confines to editing the one doc — no git, no network, no other shell). The poller then commits the
  edited doc and appends the agent's reply.
- **Replies push straight to the doc's branch** (often `main`) — there is no PR flow. That's
  intended: the app reads the reply from that same branch. Point the runner only at repos where that
  is acceptable.
- **Install once, one watcher per repo.** Keep a single copy of `runner/` (here) and run a
  clone + config + poller + session **per repo you want answered**. The runner only sees `.margins/`
  logs in the clone it's pointed at, and only pushes to that clone's `origin` — so the clone must be
  the same repo whose docs you open in the app, with working push auth.

```bash
# one-time, per repo: a config naming its clone + a private state dir (both gitignored)
cp runner/config.example.json runner/config.<repo>.json
#   clonePath -> a checkout of THAT repo;  stateDir -> e.g. ~/.margins-runner/<repo>

# then run the two processes (separate terminals):
python3 -m runner.poller runner/config.<repo>.json          # poller (git I/O)
./runner/launch-session.sh <clonePath> <stateDir>           # strict responder session
```

Per-repo configs (`runner/config.*.json`) hold local absolute paths and stay out of git; only
`config.example.json` is tracked.

> **Running the poller from a Claude Code session?** A plain terminal is simplest (and the process
> outlives the session). But if you launch the poller from *inside* a Claude Code session, its
> auto-mode classifier blocks it as an unattended loop that pushes to a branch. Pre-authorize it once
> by adding a permission rule to `.claude/settings.local.json` (gitignored — stays on your machine):
>
> ```json
> { "permissions": { "allow": ["Bash(python3 -m runner.poller:*)"] } }
> ```

**Watching & operating (tmux).** `launch-session.sh` runs the strict session inside a tmux session
(`margins-runner-<repo>`) and auto-submits its kickoff prompt (Claude Code won't auto-run a
positional prompt, so without tmux the session sits idle at a blank prompt). Run the poller in tmux
too so both survive your terminal — or your Claude session — closing, and you can re-attach to either:

| Action | Command |
|---|---|
| Run the poller in tmux | `tmux new-session -d -s margins-poller-<repo> "python3 -u -m runner.poller runner/config.<repo>.json"` |
| Watch the session | `tmux attach -t margins-runner-<repo>` |
| Watch the poller | `tmux attach -t margins-poller-<repo>` |
| Detach (leave it running) | `Ctrl-b` then `d` |
| Restart the session | re-run `./runner/launch-session.sh <clonePath> <stateDir>` (it kills the old tmux session and starts fresh) |
| Stop the session / poller | `tmux kill-session -t margins-runner-<repo>` · `tmux kill-session -t margins-poller-<repo>` |
| List running sessions | `tmux ls` |

tmux sessions keep running after you close the terminal or your Claude session; they stop only on
reboot or an explicit `kill-session`.

## Notes / known limits

- Big documents (hundreds of KB) are slow to load — that's ProseMirror parsing, not margins.
- Mermaid loads from a CDN by default (falls back to the bundled copy); diagrams need network the
  first time unless the bundle is used.
- macOS-oriented (uses `scutil`, `/opt/homebrew`); easily adapted for Linux.

## License

MIT (same as Roughdraft). See [LICENSE](LICENSE).

## The margins skill (Claude Code)

`skills/margins/` ships a [Claude Code skill](https://agentskills.io) that teaches an agent the
roughdraft.md collaboration workflow: the human writes and annotates the doc with CriticMarkup
comments (`{==span==}{>>comment<<}`); the agent runs explicitly-triggered **review passes**
(reply to comments only, +0.0.1 version bump) and **rewrite passes** (apply edits, resolve
comments, +0.1 bump), keeps the frontmatter + visible version stamp in sync, and commits/pushes
directly back to the doc's branch. All agent↔human communication happens in the doc itself.

Install it:

```bash
curl -fsSL https://raw.githubusercontent.com/recodelabs/margins/main/skills/margins/install.sh | bash
```

or as a plugin: `/plugin marketplace add recodelabs/margins` then `/plugin install margins@margins`.
