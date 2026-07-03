import json
import os
import subprocess
import sys
import tempfile
import unittest

from runner.wait_check import is_new_task

# Repo root (where runner/ lives), derived from this file so the subprocess
# test resolves "runner/wait_check.py" regardless of where the repo is
# checked out (mirrors runner/tests/test_guard.py).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestIsNewTask(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = self._tmp.name
        self.inbox_path = os.path.join(self.state, "inbox.json")
        self.done_path = os.path.join(self.state, "done.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, path, payload_or_raw):
        if isinstance(payload_or_raw, str):
            with open(path, "w", encoding="utf-8") as f:
                f.write(payload_or_raw)
        else:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload_or_raw, f)

    def test_inbox_absent_is_not_ready(self):
        self.assertFalse(is_new_task(self.state))

    def test_inbox_present_no_done_is_ready(self):
        self._write(self.inbox_path, {"instructionId": "abc123"})
        self.assertTrue(is_new_task(self.state))

    def test_inbox_and_matching_done_is_not_ready(self):
        # The core RUN-1 fix: the session just answered instruction "abc123"
        # and looped back to wait-for-task.sh before the poller has cleared
        # the inbox. Must NOT be re-served.
        self._write(self.inbox_path, {"instructionId": "abc123"})
        self._write(self.done_path, {"replyTo": "abc123", "status": "done"})
        self.assertFalse(is_new_task(self.state))

    def test_inbox_and_done_with_different_reply_to_is_ready(self):
        # A stale done.json from a previous instruction must not block a
        # genuine new task.
        self._write(self.inbox_path, {"instructionId": "abc123"})
        self._write(self.done_path, {"replyTo": "someOtherId", "status": "done"})
        self.assertTrue(is_new_task(self.state))

    def test_inbox_and_unparseable_done_is_ready(self):
        self._write(self.inbox_path, {"instructionId": "abc123"})
        self._write(self.done_path, "{not valid json")
        self.assertTrue(is_new_task(self.state))

    def test_inbox_and_done_missing_reply_to_is_ready(self):
        self._write(self.inbox_path, {"instructionId": "abc123"})
        self._write(self.done_path, {"status": "done"})
        self.assertTrue(is_new_task(self.state))

    def test_inbox_unparseable_is_not_ready(self):
        self._write(self.inbox_path, "{not valid json")
        self.assertFalse(is_new_task(self.state))

    def test_inbox_missing_instruction_id_is_not_ready(self):
        self._write(self.inbox_path, {"docPath": "a.md"})
        self.assertFalse(is_new_task(self.state))

    def test_inbox_empty_instruction_id_is_not_ready(self):
        self._write(self.inbox_path, {"instructionId": ""})
        self.assertFalse(is_new_task(self.state))

    def test_inbox_not_a_dict_is_not_ready(self):
        self._write(self.inbox_path, json.dumps(["not", "a", "dict"]))
        self.assertFalse(is_new_task(self.state))


class TestMainSubprocess(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = self._tmp.name
        self.inbox_path = os.path.join(self.state, "inbox.json")
        self.done_path = os.path.join(self.state, "done.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, extra_env=None):
        env = {**os.environ}
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            [sys.executable, "-m", "runner.wait_check", self.state],
            capture_output=True,
            text=True,
            cwd=_REPO_ROOT,
            env=env,
        )

    def test_exit_0_when_ready(self):
        with open(self.inbox_path, "w", encoding="utf-8") as f:
            json.dump({"instructionId": "abc123"}, f)
        proc = self._run()
        self.assertEqual(proc.returncode, 0)

    def test_exit_1_when_not_ready(self):
        proc = self._run()
        self.assertEqual(proc.returncode, 1)

    def test_exit_1_when_already_answered(self):
        with open(self.inbox_path, "w", encoding="utf-8") as f:
            json.dump({"instructionId": "abc123"}, f)
        with open(self.done_path, "w", encoding="utf-8") as f:
            json.dump({"replyTo": "abc123", "status": "done"}, f)
        proc = self._run()
        self.assertEqual(proc.returncode, 1)

    def test_reads_state_dir_from_env_when_no_argv(self):
        with open(self.inbox_path, "w", encoding="utf-8") as f:
            json.dump({"instructionId": "abc123"}, f)
        env = {**os.environ, "MARGINS_RUNNER_STATE": self.state}
        proc = subprocess.run(
            [sys.executable, "-m", "runner.wait_check"],
            capture_output=True,
            text=True,
            cwd=_REPO_ROOT,
            env=env,
        )
        self.assertEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
