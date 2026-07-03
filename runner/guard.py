"""PreToolUse hook: hard allowlist for the strict runner session.

The session may ONLY:
  - Read files inside the clone, or read/write the state dir
  - Edit/Write the single doc named by the current task's inbox.json
    (`$MARGINS_RUNNER_STATE/inbox.json`, key "docPath"), or read/write the
    state dir (e.g. its done.json sentinel) — never any other file in the
    clone
  - run one exact Bash wait command (and nothing else)
Everything else is denied. This is the safety guarantee: destructive tools are
never permitted, and a prompt-injected instruction cannot widen its own blast
radius to a second file, so it has nothing to call and nothing to touch
beyond the one doc it was handed.

Env (set by launch-session.sh):
  MARGINS_RUNNER_CLONE  - absolute path to the clone
  MARGINS_RUNNER_STATE  - absolute path to the state dir
"""

from __future__ import annotations

import json
import os
import sys

# The exact Bash invocations the session is allowed to run (the blocking wait).
WAIT_COMMANDS = (
    "bash runner/wait-for-task.sh",
    "bash ./runner/wait-for-task.sh",
)


def _within(path: str, base: str) -> bool:
    # Fail closed: an empty base (unset env var) must never match — otherwise
    # os.path.realpath("") would resolve to cwd and silently widen the sandbox.
    if not base or not path:
        return False
    real_base = os.path.realpath(base)
    real_path = os.path.realpath(path)
    return real_path == real_base or real_path.startswith(real_base + os.sep)


def _inbox_doc_target(clone: str, state_dir: str) -> str | None:
    """Return the realpath of the single doc the current task's inbox names,
    or None if it cannot be determined safely.

    Learns docPath the same way the session does: from
    `$MARGINS_RUNNER_STATE/inbox.json` (see poller.py write_inbox /
    runner_io.py StateIO). Any ambiguity — missing state dir, missing or
    unreadable inbox, malformed JSON, a non-dict payload, a missing/empty/
    non-str docPath, or a docPath that escapes the clone (e.g. via `..` or an
    absolute path) — returns None so the caller fails closed rather than
    trusting an untrustworthy or absent doc target.
    """
    if not clone or not state_dir:
        return None
    inbox_path = os.path.join(state_dir, "inbox.json")
    try:
        with open(inbox_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    doc_path = payload.get("docPath")
    if not isinstance(doc_path, str) or not doc_path:
        return None

    real_clone = os.path.realpath(clone)
    target = os.path.realpath(os.path.join(real_clone, doc_path))
    # Reject any docPath that resolves outside the clone (e.g. "../secret" or
    # an absolute path) — trusting it would let the inbox widen the sandbox
    # rather than narrow it. Also reject a docPath that resolves to the clone
    # root itself (e.g. "." or "") — a real doc is always a file strictly
    # inside the clone, never the clone directory.
    if not target.startswith(real_clone + os.sep):
        return None
    return target


def enforce(tool_name: str, tool_input: dict, clone: str, state_dir: str) -> tuple[str, str]:
    """Return ("allow"|"deny", reason)."""
    if tool_name in ("Read", "Edit", "Write"):
        path = tool_input.get("file_path", "")
        # Never touch the clone's .git dir: a prompt-injected doc could write
        # .git/hooks/post-commit or rewrite .git/config, which the trusted
        # poller would then execute on its next git op. Check via realpath so a
        # symlink can't dodge the block. This is checked before the allow so it
        # overrides the clone allowance.
        if path and clone and _within(path, os.path.join(os.path.realpath(clone), ".git")):
            return ("deny", f"{tool_name} into the clone's .git directory is forbidden")

        if tool_name == "Read":
            # Reads are lookups the session legitimately needs (e.g. reading
            # the inbox itself, or checking other docs for context) — stay
            # clone-wide, same as before.
            if path and (_within(path, clone) or _within(path, state_dir)):
                return ("allow", "")
            return ("deny", "Read is restricted to the clone and state dir")

        # Edit/Write: the one-doc restriction. The state dir is always
        # writable (that's where the session writes its done.json sentinel);
        # everything else in the clone is allowed ONLY if it's exactly the
        # doc named by the current task's inbox.json. If that target can't be
        # determined, fail closed and deny all clone writes — state-dir
        # writes don't depend on docPath, so they're unaffected.
        if path and _within(path, state_dir):
            return ("allow", "")
        doc_target = _inbox_doc_target(clone, state_dir)
        if path and doc_target and os.path.realpath(path) == doc_target:
            return ("allow", "")
        return (
            "deny",
            f"{tool_name} is restricted to the single inbox doc and state dir",
        )

    if tool_name == "Bash":
        command = (tool_input.get("command") or "").strip()
        if command in WAIT_COMMANDS:
            return ("allow", "")
        return ("deny", "the session may only run the wait script")

    if tool_name == "Skill":
        # Loading the runner's own playbook is just reading instructions; every
        # action it then takes is still gated by this guard. Scope to that one
        # skill so a prompt-injected instruction can't pull in some other skill.
        if (tool_input.get("skill") or tool_input.get("command") or "") == "margins-runner":
            return ("allow", "")
        return ("deny", "only the margins-runner skill may be loaded")

    # Harmless, no file/network side effects — lets the session track its loop
    # without the guard spamming denials on a normal startup behavior.
    if tool_name == "TodoWrite":
        return ("allow", "")

    return ("deny", f"tool '{tool_name}' is not permitted in strict runner mode")


def main() -> int:
    clone = os.environ.get("MARGINS_RUNNER_CLONE", "")
    state_dir = os.environ.get("MARGINS_RUNNER_STATE", "")
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        payload = {}
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str):
        tool_name = ""
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    decision, reason = enforce(tool_name, tool_input, clone, state_dir)
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
