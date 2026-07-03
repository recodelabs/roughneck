import json
import tempfile
import unittest
from pathlib import Path

from runner.config import Config, load_config


class TestConfig(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.tmp_root = Path(self._tmpdir.name)

    def _write(self, data: dict) -> str:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, tmp)
        tmp.close()
        return tmp.name

    def _make_clone_path(self) -> str:
        clone_path = self.tmp_root / "clone"
        clone_path.mkdir()
        return str(clone_path)

    def test_loads_required_fields_and_defaults(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({"clonePath": clone_path, "stateDir": state_dir})
        cfg = load_config(path)
        self.assertEqual(cfg.clone_path, clone_path)
        self.assertEqual(cfg.state_dir, state_dir)
        self.assertEqual(cfg.branch, "main")          # default
        self.assertEqual(cfg.poll_seconds, 120)        # default
        self.assertEqual(cfg.agent_by, "agent")        # default
        self.assertEqual(cfg.task_timeout_seconds, 600)  # default

    def test_overrides_defaults(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir, "branch": "dev",
            "pollSeconds": 30, "agentBy": "amadeus", "taskTimeoutSeconds": 90,
        })
        cfg = load_config(path)
        self.assertEqual(cfg.branch, "dev")
        self.assertEqual(cfg.poll_seconds, 30)
        self.assertEqual(cfg.agent_by, "amadeus")
        self.assertEqual(cfg.task_timeout_seconds, 90)

    def test_missing_required_raises(self):
        path = self._write({"stateDir": "/s"})  # no clonePath
        with self.assertRaises(ValueError):
            load_config(path)

    def test_zero_poll_seconds_raises(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir, "pollSeconds": 0,
        })
        with self.assertRaisesRegex(ValueError, "pollSeconds"):
            load_config(path)

    def test_negative_poll_seconds_raises(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir, "pollSeconds": -5,
        })
        with self.assertRaisesRegex(ValueError, "pollSeconds"):
            load_config(path)

    def test_non_numeric_poll_seconds_raises_clear_error(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir, "pollSeconds": "soon",
        })
        with self.assertRaisesRegex(ValueError, "pollSeconds"):
            load_config(path)

    def test_zero_task_timeout_seconds_raises(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir, "taskTimeoutSeconds": 0,
        })
        with self.assertRaisesRegex(ValueError, "taskTimeoutSeconds"):
            load_config(path)

    def test_negative_task_timeout_seconds_raises(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir, "taskTimeoutSeconds": -1,
        })
        with self.assertRaisesRegex(ValueError, "taskTimeoutSeconds"):
            load_config(path)

    def test_nonexistent_clone_path_raises(self):
        state_dir = str(self.tmp_root / "state")
        missing_clone = str(self.tmp_root / "does-not-exist")
        path = self._write({"clonePath": missing_clone, "stateDir": state_dir})
        with self.assertRaisesRegex(ValueError, "clonePath"):
            load_config(path)

    def test_clone_path_that_is_a_file_raises(self):
        clone_file = self.tmp_root / "clone-is-a-file"
        clone_file.write_text("not a dir")
        state_dir = str(self.tmp_root / "state")
        path = self._write({"clonePath": str(clone_file), "stateDir": state_dir})
        with self.assertRaisesRegex(ValueError, "clonePath"):
            load_config(path)

    def test_state_dir_with_missing_parent_is_accepted(self):
        # load_config must not require stateDir (or its parent) to exist —
        # StateIO.__init__ creates the full chain recursively on runner
        # start (os.makedirs(..., exist_ok=True)), so load_config staying
        # side-effect-free here matters: a fresh machine where
        # ~/.margins-runner/ doesn't exist yet must not hard-fail at load.
        clone_path = self._make_clone_path()
        state_dir = self.tmp_root / "no-such-parent" / "deeper" / "state"
        path = self._write({"clonePath": clone_path, "stateDir": str(state_dir)})
        cfg = load_config(path)
        self.assertEqual(cfg.state_dir, str(state_dir))
        self.assertFalse(state_dir.exists())
        self.assertFalse(state_dir.parent.exists())

    def test_state_dir_missing_but_parent_exists_is_accepted_and_not_created(self):
        clone_path = self._make_clone_path()
        state_dir = self.tmp_root / "state"
        path = self._write({"clonePath": clone_path, "stateDir": str(state_dir)})
        cfg = load_config(path)
        self.assertEqual(cfg.state_dir, str(state_dir))
        self.assertFalse(state_dir.exists())

    def test_state_dir_that_is_a_file_raises(self):
        clone_path = self._make_clone_path()
        state_file = self.tmp_root / "state-is-a-file"
        state_file.write_text("not a dir")
        path = self._write({"clonePath": clone_path, "stateDir": str(state_file)})
        with self.assertRaisesRegex(ValueError, "stateDir"):
            load_config(path)

    def test_non_numeric_task_timeout_seconds_raises_clear_error(self):
        clone_path = self._make_clone_path()
        state_dir = str(self.tmp_root / "state")
        path = self._write({
            "clonePath": clone_path, "stateDir": state_dir,
            "taskTimeoutSeconds": "forever",
        })
        with self.assertRaisesRegex(ValueError, "taskTimeoutSeconds"):
            load_config(path)
