"""Drift guard: assert runner/settings.json still wires guard.py as a
wildcard PreToolUse hook. If someone removes the hook, narrows the matcher,
or repoints the command, this test fails — the guard being a security
boundary is only true if the harness actually invokes it on every tool call.
"""

import json
import os
import unittest

# Repo root (where runner/ lives), derived from this file so the test resolves
# runner/settings.json regardless of where the repo is checked out.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SETTINGS_PATH = os.path.join(_REPO_ROOT, "runner", "settings.json")


class TestSettingsWiring(unittest.TestCase):
    def setUp(self):
        with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
            self.settings = json.load(f)

    def test_default_mode_present(self):
        # Documents the acceptEdits reliance: the session auto-accepts every
        # tool call, so the PreToolUse hook is the ONLY thing standing between
        # a prompt-injected instruction and an unconfined write.
        self.assertIn("defaultMode", self.settings.get("permissions", {}))

    def test_pretooluse_hook_wired_to_guard_with_wildcard_matcher(self):
        pre_tool_use = self.settings.get("hooks", {}).get("PreToolUse", [])
        self.assertTrue(pre_tool_use, "no PreToolUse hooks registered in settings.json")

        matched = [
            entry
            for entry in pre_tool_use
            if entry.get("matcher") == "*"
            and any("guard.py" in (h.get("command") or "") for h in entry.get("hooks", []))
        ]
        self.assertTrue(
            matched,
            "settings.json must register a PreToolUse hook with matcher '*' whose "
            "command invokes guard.py — this is what makes the guard's fail-closed "
            "behavior actually apply to every tool call",
        )


if __name__ == "__main__":
    unittest.main()
