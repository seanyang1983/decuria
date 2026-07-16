import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import state_paths


class StatePathTests(unittest.TestCase):
    def setUp(self):
        state_paths._MIGRATED_ROOTS.clear()

    def test_legacy_state_migrates_without_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "profile"
            plugin = home / "plugins" / "decuria"
            plugin.mkdir(parents=True)
            source = plugin / "visibility.json"
            source.write_text('{"legacy": true}', encoding="utf-8")
            target = home / "data" / "decuria" / "provider_state.json"
            target.parent.mkdir(parents=True)
            target.write_text('{"keep": true}', encoding="utf-8")
            (plugin / "provider_state.json").write_text('{"replace": true}', encoding="utf-8")

            with mock.patch.object(state_paths, "PLUGIN_ROOT", plugin), \
                 mock.patch.object(state_paths, "hermes_home", return_value=home):
                root = state_paths.migrate_legacy_state()

            self.assertEqual(root, home / "data" / "decuria")
            self.assertEqual((root / "visibility.json").read_text(encoding="utf-8"), '{"legacy": true}')
            self.assertFalse(source.exists())
            self.assertEqual(target.read_text(encoding="utf-8"), '{"keep": true}')
            self.assertTrue((plugin / "provider_state.json").exists())

    def test_profile_roots_are_independent_in_one_process(self):
        with tempfile.TemporaryDirectory() as td:
            roots = [Path(td) / "one", Path(td) / "two"]
            resolved = []
            for home in roots:
                with mock.patch.object(state_paths, "hermes_home", return_value=home), \
                     mock.patch.object(state_paths, "PLUGIN_ROOT", Path(td) / "checkout"):
                    resolved.append(state_paths.state_dir())
            self.assertNotEqual(resolved[0], resolved[1])
            self.assertTrue(all(path.is_dir() for path in resolved))


if __name__ == "__main__":
    unittest.main()
