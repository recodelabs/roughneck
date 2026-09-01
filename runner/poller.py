"""Runner orchestration: poll for pending instructions, hand each to the strict
session, then commit the result and append the reply. The poller is the only
component that runs git/network; it is not an LLM and cannot be prompt-injected.
"""

from __future__ import annotations

import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from runner.config import Config, load_config
from runner.git_ops import GitOps
from runner.margins_log import (
    append_activity_line,
    build_reply_entry,
    find_pending,
    parse_activity_log,
)
from runner.runner_io import StateIO
from runner.sanitize import unwrap_block_highlights


@dataclass
class Deps:
    git: object       # GitOps or a fake (pull/push/read_file/write_file/checkout_file/commit/list_activity_logs)
    state: object     # StateIO or a fake (write_inbox/task_pending/read_done/clear_task)
    now: Callable[[], str]
    uuid: Callable[[], str]
    sleep: Callable[[float], None]


def _doc_path_from_log(log_path: str) -> str:
    """`.margins/<docPath>.activity.jsonl` -> `<docPath>`."""
    inner = log_path[len(".margins/"):] if log_path.startswith(".margins/") else log_path
    return inner[: -len(".activity.jsonl")] if inner.endswith(".activity.jsonl") else inner


def _first_pending(git) -> tuple[str, str, dict] | None:
    """Return (log_path, doc_path, instruction) for the first pending instruction,
    scanning logs in deterministic (sorted) order; None if nothing is pending."""
    for log_path, text in git.list_activity_logs().items():
        pending = find_pending(parse_activity_log(text))
        if pending:
            return (log_path, _doc_path_from_log(log_path), pending[0])
    return None


def _push_reconciling(git, branch: str, attempts: int = 6) -> None:
    """Push the agent's commits; if rejected because origin advanced (the hosted
    app committing concurrently), merge origin in and retry. Keeps the poller
    self-healing instead of stalling on every divergence."""
    for _ in range(max(1, attempts - 1)):
        if git.try_push(branch):
            return
        git.fetch_and_merge(branch)  # merge origin/branch; raises on conflict
    git.push(branch)  # final attempt — raise if it still won't go


def _append_reply(git, log_path: str, reply: dict, branch: str) -> None:
    text = git.read_file(log_path)
    git.write_file(log_path, append_activity_line(text, reply))
    git.commit([log_path], "chore(margins): agent reply")
    _push_reconciling(git, branch)


def process_one(deps: Deps, config: Config) -> bool:
    """Handle at most one pending instruction. Return True if one was handled."""
    deps.git.pull(config.branch)

    found = _first_pending(deps.git)
    if found is None:
        return False
    log_path, doc_path, instruction = found

    # Reset the doc to a clean committed state (crash-safe restart).
    deps.git.checkout_file(doc_path)

    # Drop any leftover done.json BEFORE dispatching the new instruction. A
    # timeout or crash between read-done and clear-task can leave a stale
    # sentinel; if we didn't clear it, _wait_for_done could instantly attribute
    # the previous task's summary to this instruction and discard its real edit.
    deps.state.clear_task()

    deps.state.write_inbox(
        {
            "instructionId": instruction["id"],
            "docPath": doc_path,
            "type": instruction["type"],
            "instruction": instruction["instruction"],
        }
    )

    done = _wait_for_done(deps, config.task_timeout_seconds, instruction["id"])

    if done is None:
        reply = build_reply_entry(
            instruction_id=instruction["id"], status="error",
            summary="agent did not respond before the timeout",
            by=config.agent_by, at=deps.now(), uid=deps.uuid(),
            error="timeout",
        )
        _append_reply(deps.git, log_path, reply, config.branch)
        deps.state.clear_task()
        return True

    if done.get("status") == "done":
        # Defensively unwrap any block-spanning CriticMarkup highlights the agent
        # may have left (they leak raw {== in the renderer). Pure text cleanup;
        # only rewrites the file when something actually changed.
        edited = deps.git.read_file(doc_path)
        cleaned = unwrap_block_highlights(edited)
        if cleaned != edited:
            deps.git.write_file(doc_path, cleaned)
        sha = deps.git.commit([doc_path], f"agent: {done.get('summary', 'apply instruction')}")
        reply = build_reply_entry(
            instruction_id=instruction["id"], status="done",
            summary=done.get("summary", ""),
            by=config.agent_by, at=deps.now(), uid=deps.uuid(), commit=sha,
        )
    else:
        reply = build_reply_entry(
            instruction_id=instruction["id"], status="error",
            summary=done.get("summary", "the agent reported an error"),
            by=config.agent_by, at=deps.now(), uid=deps.uuid(),
            error=done.get("error", "unspecified error"),
        )

    _append_reply(deps.git, log_path, reply, config.branch)
    deps.state.clear_task()
    return True


def _wait_for_done(deps: Deps, timeout_seconds: int, instruction_id: str) -> dict | None:
    """Poll for the session's done sentinel; return it, or None on timeout.

    Only accept a sentinel whose ``replyTo`` matches the dispatched instruction.
    A leftover done.json from a previous task (mismatched replyTo) is treated as
    "not done yet" so we never commit an unmodified doc under the wrong id."""
    def _fresh() -> dict | None:
        done = deps.state.read_done()
        if done is not None and done.get("replyTo") == instruction_id:
            return done
        return None

    waited = 0
    while waited < timeout_seconds:
        done = _fresh()
        if done is not None:
            return done
        deps.sleep(2)
        waited += 2
    return _fresh()


def run_forever(deps: Deps, config: Config) -> None:  # pragma: no cover - thin loop
    while True:
        try:
            handled = process_one(deps, config)
        except Exception as exc:  # keep the loop alive; surface the error
            print(f"[runner] error: {exc}", file=sys.stderr)
            handled = False
        if not handled:
            deps.sleep(config.poll_seconds)


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - wiring
    argv = argv if argv is not None else sys.argv[1:]
    config_path = argv[0] if argv else "runner/config.json"
    config = load_config(config_path)
    deps = Deps(
        git=GitOps(config.clone_path),
        state=StateIO(config.state_dir),
        now=lambda: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        uuid=lambda: str(uuid.uuid4()),
        sleep=time.sleep,
    )
    print(f"[runner] watching {config.clone_path} ({config.branch}) every {config.poll_seconds}s")
    run_forever(deps, config)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
