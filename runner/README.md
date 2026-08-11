# margins runner (SP2)

A local runner that applies margins instructions to your docs with a strict
Claude Code session billed to your own subscription. Two processes:

- **Poller** (`poller.py`) — polls the repo's `.margins/**/*.activity.jsonl`,
  hands one pending instruction to the session, then commits the edited doc and
  appends the agent's reply. Owns all git/GitHub I/O.
- **Strict session** (`launch-session.sh`) — an idle `claude` session that the
  guard hook restricts to editing the doc and running the wait script. No Bash,
  no network: a malicious instruction has no destructive tool to call.

## One-time setup

1. **Clone the repo** somewhere with your GitHub auth working (so `git pull` /
   `git push` succeed non-interactively):
   ```bash
   git clone <repo-url> ~/margins-clone
   ```
2. **Copy and edit the config:**
   ```bash
   cp runner/config.example.json runner/config.json
   # set clonePath to ~/margins-clone and stateDir to e.g. ~/.margins-runner/<repo>
   ```
3. **Start the strict session** (uses your Claude subscription — a normal
   interactive `claude`, not the API). Requires `tmux`:
   ```bash
   ./runner/launch-session.sh ~/margins-clone ~/.margins-runner/<repo>
   ```
   It launches the session **inside a tmux session** (`margins-runner-<repo>`)
   and auto-submits the kickoff prompt, then sits idle (zero tokens) until a task
   arrives. (tmux is used because Claude Code does not auto-run a positional
   prompt in interactive mode — without it the session sits at a blank prompt and
   never enters the loop.) It also symlinks the `margins-runner` skill into
   `~/.claude/skills/` on first run if it isn't already installed.

   Watch it with `tmux attach -t margins-runner-<repo>` (detach: `Ctrl-b` then
   `d`); stop it with `tmux kill-session -t margins-runner-<repo>`.
4. **Start the poller** in another terminal:
   ```bash
   python3 -m runner.poller runner/config.json
   ```

Now send instructions from margins (the doc workspace). Within `pollSeconds` the
poller picks them up, the session applies them, and the reply appears in the
doc's activity log.

## Watching & operating (tmux)

`launch-session.sh` already runs the strict session inside tmux. Run the poller in
tmux too so both survive the terminal (or your Claude session) closing and you can
re-attach to either:

```bash
# poller in its own tmux session (mirrors the strict session):
tmux new-session -d -s margins-poller-<repo> \
  "cd <repo-with-runner> && python3 -u -m runner.poller runner/config.<repo>.json"
```

Day-to-day:

| Action | Command |
|---|---|
| Watch the session | `tmux attach -t margins-runner-<repo>` |
| Watch the poller | `tmux attach -t margins-poller-<repo>` |
| Detach (leave running) | `Ctrl-b` then `d` |
| Restart the session (e.g. after editing the skill) | re-run `./runner/launch-session.sh <clonePath> <stateDir>` — it kills the old tmux session and starts fresh |
| Stop the session | `tmux kill-session -t margins-runner-<repo>` |
| Stop the poller | `tmux kill-session -t margins-poller-<repo>` |
| List running sessions | `tmux ls` |

tmux sessions keep running after you close the terminal or your Claude session;
they stop only on reboot or an explicit `kill-session`.

## Safety model

The session runs under `runner/settings.json`, whose `PreToolUse` hook
(`runner/guard.py`) allows Read anywhere inside the clone (plus the state dir),
but confines Edit/Write to the single doc named in the current task's
`inbox.json` (plus the state dir), and allows only the one `wait-for-task.sh`
command. Everything else — `rm`, `curl`, other files, the network — is denied.
The poller, which does have git/network, is a plain script and cannot be
prompt-injected.

## Tests

```bash
python3 -m unittest discover -s runner/tests -t . -v
```

## Dry run (verify safety before trusting it)

See the checklist in `docs/superpowers/plans/2026-06-13-agent-runner-sp2.md`,
Task 12.
