#!/usr/bin/env bash
# The ONLY shell command the strict runner session is permitted to run.
# Blocks until the poller drops a NEW (not-yet-answered) inbox task, then
# exits 0. Takes no arguments and can do nothing else — so allowing it grants
# the session no real power.
#
# Readiness is delegated to `runner/wait_check.py` (see it for the exactly-
# once rationale, RUN-1): the inbox alone existing is not enough, because the
# poller clears it LAST (after commit + push) — right after the session
# writes done.json and loops back here, the just-answered inbox is still on
# disk and must NOT be re-served.
set -euo pipefail

: "${MARGINS_RUNNER_STATE:?MARGINS_RUNNER_STATE must be set by launch-session.sh}"

# python3 exits 1 (not ready) most iterations of this loop; guard it so that
# doesn't trip `set -e` and kill the script.
while true; do
  if python3 -m runner.wait_check "$MARGINS_RUNNER_STATE"; then
    break
  fi
  sleep 2
done
