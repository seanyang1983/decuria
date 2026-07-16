import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PATHS = {
    "provider_keys.json", "proxy.json", "visibility.json", "provider_state.json",
    "orchestrator_state.json", "model_universe.json", "model_universe.stale",
    "moa_models.json",
}
SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{30,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
)


class ReleaseSafetyTests(unittest.TestCase):
    def test_runtime_state_is_not_tracked(self):
        tracked = set(subprocess.check_output(
            ["git", "ls-files"], cwd=ROOT, text=True, encoding="utf-8"
        ).splitlines())
        self.assertFalse(RUNTIME_PATHS & tracked)
        self.assertFalse(any(path.startswith(("data/", "generated/")) for path in tracked))

    def test_tracked_text_has_no_common_live_secret_shape(self):
        files = subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT, text=True, encoding="utf-8"
        ).splitlines()
        for relative in files:
            path = ROOT / relative
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for pattern in SECRET_PATTERNS:
                self.assertIsNone(pattern.search(text), relative)

    def test_provider_sprite_has_no_script_or_external_href(self):
        sprite = (ROOT / "dashboard/assets/provider-icons/sprite.svg").read_text(encoding="utf-8")
        self.assertNotRegex(sprite.lower(), r"<\s*script\b")
        self.assertNotRegex(sprite.lower(), r"(?:href|xlink:href)\s*=\s*[\"']https?://")


if __name__ == "__main__":
    unittest.main()
