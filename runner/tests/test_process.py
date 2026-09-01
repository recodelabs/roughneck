import unittest

from runner.config import Config
from runner.poller import Deps, _push_reconciling, process_one


class _RetryGit:
    """Fake whose push is rejected `fail_n` times before succeeding, recording
    how many times origin had to be merged in."""

    def __init__(self, fail_n):
        self._left = fail_n
        self.merges = 0
        self.pushes = 0
        self.hard_pushes = 0

    def try_push(self, branch):
        self.pushes += 1
        if self._left > 0:
            self._left -= 1
            return False
        return True

    def fetch_and_merge(self, branch):
        self.merges += 1

    def push(self, branch):
        self.hard_pushes += 1


class TestPushReconciling(unittest.TestCase):
    def test_pushes_first_try_when_not_rejected(self):
        git = _RetryGit(fail_n=0)
        _push_reconciling(git, "main")
        self.assertEqual(git.pushes, 1)
        self.assertEqual(git.merges, 0)
        self.assertEqual(git.hard_pushes, 0)

    def test_merges_origin_and_retries_on_rejection(self):
        git = _RetryGit(fail_n=2)
        _push_reconciling(git, "main")
        # rejected twice -> merged origin twice -> third try_push succeeds
        self.assertEqual(git.merges, 2)
        self.assertEqual(git.pushes, 3)
        self.assertEqual(git.hard_pushes, 0)

    def test_final_hard_push_after_exhausting_retries(self):
        git = _RetryGit(fail_n=99)  # never succeeds via try_push
        _push_reconciling(git, "main", attempts=3)
        # attempts-1 = 2 try_pushes (both fail, 2 merges), then one hard push
        self.assertEqual(git.pushes, 2)
        self.assertEqual(git.merges, 2)
        self.assertEqual(git.hard_pushes, 1)


class FakeGit:
    def __init__(self, logs, files):
        self._logs = dict(logs)
        self._files = dict(files)
        self.pulled = False
        self.pushed = False
        self.merges = 0
        self.checked_out = []
        self.commits = []  # (paths, message)

    def pull(self, branch):
        self.pulled = True

    def push(self, branch):
        self.pushed = True

    def try_push(self, branch):
        self.pushed = True
        return True

    def fetch_and_merge(self, branch):
        self.merges += 1

    def list_activity_logs(self):
        return dict(self._logs)

    def read_file(self, path):
        return self._files.get(path, self._logs.get(path, ""))

    def write_file(self, path, text):
        if path in self._logs or path.endswith(".activity.jsonl"):
            self._logs[path] = text
        else:
            self._files[path] = text

    def checkout_file(self, path):
        self.checked_out.append(path)

    def commit(self, paths, message):
        self.commits.append((list(paths), message))
        return f"sha{len(self.commits)}" + "0" * 36


class FakeState:
    def __init__(self, done):
        self._done = done
        self.inbox = None
        self.cleared = False

    def write_inbox(self, task):
        self.inbox = task

    def task_pending(self):
        return self.inbox is not None and not self.cleared

    def read_done(self):
        return self._done

    def clear_task(self):
        self.cleared = True


CONFIG = Config(clone_path="/c", state_dir="/s", branch="main", agent_by="agent")


def _deps(git, state, done):
    return Deps(
        git=git,
        state=state,
        now=lambda: "2026-06-13T00:00:00.000Z",
        uuid=lambda: "uid-1",
        sleep=lambda s: None,
    )


class TestProcessOne(unittest.TestCase):
    def _logs_with_one_pending(self):
        return {
            ".margins/a.md.activity.jsonl":
                '{"id":"i1","at":"t","by":"u","role":"user","type":"comments","instruction":"apply"}\n'
        }

    def test_no_pending_returns_false(self):
        git = FakeGit({".margins/a.md.activity.jsonl":
            '{"id":"i1","at":"t","by":"u","role":"user","type":"custom","instruction":"x"}\n'
            '{"id":"a1","at":"t","by":"agent","role":"agent","replyTo":"i1","status":"done","summary":"s"}\n'
        }, {})
        state = FakeState(done=None)
        handled = process_one(_deps(git, state, None), CONFIG)
        self.assertFalse(handled)
        self.assertIsNone(state.inbox)

    def test_done_path_commits_doc_then_appends_reply(self):
        git = FakeGit(self._logs_with_one_pending(), {"a.md": "# Title\n"})
        state = FakeState(done={"status": "done", "summary": "applied 2 comments", "replyTo": "i1"})
        handled = process_one(_deps(git, state, state._done), CONFIG)

        self.assertTrue(handled)
        # Doc reset before handing to the session.
        self.assertEqual(git.checked_out, ["a.md"])
        # Inbox carried the instruction.
        self.assertEqual(state.inbox["instructionId"], "i1")
        self.assertEqual(state.inbox["docPath"], "a.md")
        # Two commits: the doc, then the log.
        self.assertEqual(git.commits[0][0], ["a.md"])
        self.assertEqual(git.commits[1][0], [".margins/a.md.activity.jsonl"])
        self.assertTrue(git.pushed)
        self.assertTrue(state.cleared)
        # The appended reply references the doc commit sha and is valid.
        from runner.margins_log import parse_activity_log, find_pending
        entries = parse_activity_log(git._logs[".margins/a.md.activity.jsonl"])
        self.assertEqual(find_pending(entries), [])      # i1 now resolved
        reply = [e for e in entries if e.get("role") == "agent"][0]
        self.assertEqual(reply["status"], "done")
        self.assertEqual(reply["summary"], "applied 2 comments")
        # The doc commit is the first commit; FakeGit returns "sha1" + 36 zeros.
        self.assertEqual(reply["commit"], "sha1" + "0" * 36)

    def test_error_done_appends_error_reply_without_doc_commit(self):
        git = FakeGit(self._logs_with_one_pending(), {"a.md": "# Title\n"})
        state = FakeState(done={"status": "error", "summary": "could not apply", "replyTo": "i1", "error": "ambiguous"})
        process_one(_deps(git, state, state._done), CONFIG)

        # Only the log is committed (no doc commit).
        self.assertEqual(len(git.commits), 1)
        self.assertEqual(git.commits[0][0], [".margins/a.md.activity.jsonl"])
        from runner.margins_log import parse_activity_log
        reply = [e for e in parse_activity_log(git._logs[".margins/a.md.activity.jsonl"]) if e.get("role") == "agent"][0]
        self.assertEqual(reply["status"], "error")
        self.assertEqual(reply["error"], "ambiguous")
        self.assertNotIn("commit", reply)
        self.assertTrue(state.cleared)
        self.assertTrue(git.pushed)

    def test_stale_done_mismatched_replyto_not_attributed(self):
        # A leftover done.json from a PREVIOUS instruction ("i0") must not be
        # attributed to the new instruction ("i1"): treated as not-done, so the
        # doc is never committed with the stale summary.
        git = FakeGit(self._logs_with_one_pending(), {"a.md": "# Title\n"})
        state = FakeState(done={"status": "done", "summary": "old task", "replyTo": "i0"})
        process_one(_deps(git, state, state._done), CONFIG)

        from runner.margins_log import parse_activity_log
        reply = [e for e in parse_activity_log(git._logs[".margins/a.md.activity.jsonl"]) if e.get("role") == "agent"][0]
        self.assertEqual(reply["status"], "error")
        self.assertEqual(reply["error"], "timeout")
        self.assertNotIn("old task", reply.get("summary", ""))
        # No doc commit — only the reply log was committed.
        self.assertEqual(len(git.commits), 1)
        self.assertEqual(git.commits[0][0], [".margins/a.md.activity.jsonl"])

    def test_matching_replyto_completes_normally(self):
        git = FakeGit(self._logs_with_one_pending(), {"a.md": "# Title\n"})
        state = FakeState(done={"status": "done", "summary": "applied", "replyTo": "i1"})
        handled = process_one(_deps(git, state, state._done), CONFIG)
        self.assertTrue(handled)
        self.assertEqual(git.commits[0][0], ["a.md"])
        from runner.margins_log import parse_activity_log
        reply = [e for e in parse_activity_log(git._logs[".margins/a.md.activity.jsonl"]) if e.get("role") == "agent"][0]
        self.assertEqual(reply["status"], "done")
        self.assertEqual(reply["summary"], "applied")

    def test_timeout_appends_error_reply(self):
        git = FakeGit(self._logs_with_one_pending(), {"a.md": "# Title\n"})
        state = FakeState(done=None)  # session never writes done.json
        process_one(_deps(git, state, None), CONFIG)
        from runner.margins_log import parse_activity_log
        reply = [e for e in parse_activity_log(git._logs[".margins/a.md.activity.jsonl"]) if e.get("role") == "agent"][0]
        self.assertEqual(reply["status"], "error")
        self.assertEqual(reply["error"], "timeout")
        self.assertTrue(state.cleared)
        self.assertTrue(git.pushed)
