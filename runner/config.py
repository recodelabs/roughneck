"""Runner configuration loaded from config.json."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    clone_path: str
    state_dir: str
    branch: str = "main"
    poll_seconds: int = 120
    agent_by: str = "agent"
    task_timeout_seconds: int = 600


def _coerce_int(data: dict, field: str, default: int) -> int:
    """Coerce data[field] (or default) to int, raising a clear ValueError
    naming the field if the value is present but not numeric."""
    raw = data.get(field, default)
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"config.json field {field!r} must be a number, got {raw!r}"
        ) from exc


def load_config(path: str) -> Config:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    for required in ("clonePath", "stateDir"):
        if not data.get(required):
            raise ValueError(f"config.json missing required field: {required}")

    clone_path = data["clonePath"]
    state_dir = data["stateDir"]

    poll_seconds = _coerce_int(data, "pollSeconds", 120)
    if poll_seconds < 1:
        raise ValueError(
            f"config.json field 'pollSeconds' must be >= 1, got {poll_seconds}"
        )

    task_timeout_seconds = _coerce_int(data, "taskTimeoutSeconds", 600)
    if task_timeout_seconds <= 0:
        raise ValueError(
            "config.json field 'taskTimeoutSeconds' must be > 0, "
            f"got {task_timeout_seconds}"
        )

    if not os.path.isdir(clone_path):
        raise ValueError(
            f"config.json field 'clonePath' does not exist or is not a "
            f"directory: {clone_path!r}"
        )

    # stateDir need not exist yet — StateIO creates the full chain
    # recursively (os.makedirs(..., exist_ok=True)) on runner start. If it
    # already exists, it must be a directory (an existing file there is a
    # real misconfiguration worth failing loudly on).
    if os.path.exists(state_dir) and not os.path.isdir(state_dir):
        raise ValueError(
            f"config.json field 'stateDir' exists but is not a "
            f"directory: {state_dir!r}"
        )

    return Config(
        clone_path=clone_path,
        state_dir=state_dir,
        branch=data.get("branch", "main"),
        poll_seconds=poll_seconds,
        agent_by=data.get("agentBy", "agent"),
        task_timeout_seconds=task_timeout_seconds,
    )
