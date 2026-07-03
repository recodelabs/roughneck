"""Readiness check for the strict session's blocking wait (RUN-1 fix).

`inbox.json` stays the single source of truth (no rename, no new sentinel) so
`guard.py` and the margins-runner SKILL are untouched. The problem this closes:
`wait-for-task.sh` used to return as soon as `inbox.json` existed, but the
poller clears the inbox LAST (after commit + push, see poller.py
`process_one` / `clear_task`). So right after the session writes `done.json`
and loops back to the wait, the just-answered inbox is still on disk and the
old check would return immediately, causing the session to re-read and
re-apply the same instruction.

The fix: a task is only "new" if the inbox has not already been answered by
the done.json sitting next to it (`done.replyTo == inbox.instructionId`).
"""

from __future__ import annotations

import json
import os
import sys


def _load_json(path: str) -> object | None:
    """Return the parsed JSON at `path`, or None if it's missing, unreadable,
    or not valid JSON. Never raises."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def is_new_task(state_dir: str) -> bool:
    """True iff `<state_dir>/inbox.json` names a task that has not already
    been answered by `<state_dir>/done.json`.

    ready ⟺ inbox.json present & valid (non-empty instructionId)
            AND NOT (done.json present with replyTo == inbox.instructionId)
    """
    inbox_path = os.path.join(state_dir, "inbox.json")
    inbox = _load_json(inbox_path)
    if not isinstance(inbox, dict):
        # Missing, unreadable, malformed JSON, or not a JSON object -> never
        # serve a bad inbox.
        return False
    instruction_id = inbox.get("instructionId")
    if not isinstance(instruction_id, str) or not instruction_id:
        return False

    done_path = os.path.join(state_dir, "done.json")
    done = _load_json(done_path)
    if done is None:
        # done.json missing, OR present but corrupt/invalid JSON (_load_json
        # returns None for both) -> either way we can't read a replyTo to
        # compare, so treat as a genuinely fresh task. Same liveness-favoring
        # rationale as the not-a-dict branch just below: a done sentinel we
        # can't trust must not be allowed to permanently block a real task.
        return True
    if not isinstance(done, dict):
        # done.json exists but isn't a JSON object (e.g. a partial write
        # caught mid-rewrite). Favor liveness: a done sentinel we can't trust
        # must not be allowed to permanently block a real task.
        return True

    reply_to = done.get("replyTo")
    if reply_to == instruction_id:
        # The exactly-once case this fix exists for: the session already
        # answered this instruction and looped back before the poller
        # cleared the inbox. Block the re-loop.
        return False

    # done.json present but unparseable-as-relevant (no replyTo, or replyTo
    # for a different/older instruction): a stale or foreign done sentinel
    # must not block a genuine new task. We favor liveness over strictness
    # here because the poller always clears done.json before dispatching a
    # new instruction (see poller.py process_one), so in practice a mismatch
    # only happens transiently, never as a stuck state.
    return True


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    state_dir = argv[0] if argv else os.environ.get("MARGINS_RUNNER_STATE", "")
    if not state_dir:
        return 1
    return 0 if is_new_task(state_dir) else 1


if __name__ == "__main__":
    sys.exit(main())
