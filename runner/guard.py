"""PreToolUse hook: hard allowlist for the strict runner session.

The session may ONLY:
  - Read/Edit/Write files inside the clone, or read/write the state dir
  - run one exact Bash wait command (and nothing else)
Everything else is denied. This is the safety guarantee: destructive tools are
never permitted, so a prompt-injection instruction has nothing to call.

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
        if path and (_within(path, clone) or _within(path, state_dir)):
            return ("allow", "")
        return ("deny", f"{tool_name} is restricted to the clone and state dir")

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
