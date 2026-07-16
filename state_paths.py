"""Profile-safe runtime paths and one-time legacy-state migration."""
from __future__ import annotations

import logging
import os
import shutil
import threading
from pathlib import Path

log = logging.getLogger("decuria.state_paths")
PLUGIN_ROOT = Path(__file__).resolve().parent
_MIGRATION_LOCK = threading.Lock()
_MIGRATED_ROOTS: set[Path] = set()
_STATE_FILES = (
    "visibility.json", "provider_state.json", "provider_keys.json",
    "model_universe.json", "model_universe.stale", "moa_models.json",
    "orchestrator_state.json", "proxy.json",
)


def hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _move_if_absent(source: Path, target: Path) -> None:
    """Copy atomically, then remove the legacy source only after success."""
    if not source.is_file() or target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".migrating")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            log.debug("Could not restrict migrated state permissions: %s", target, exc_info=True)
        source.unlink()
        log.info("Migrated Decuria runtime state: %s -> %s", source, target)
    except OSError:
        temporary.unlink(missing_ok=True)
        log.warning("Could not migrate Decuria runtime state %s", source, exc_info=True)


def migrate_legacy_state() -> Path:
    """Move old code-directory state into the active profile, without overwrite."""
    root = hermes_home() / "data" / "decuria"
    root.mkdir(parents=True, exist_ok=True)
    root_key = root.resolve()
    if root_key in _MIGRATED_ROOTS:
        return root
    with _MIGRATION_LOCK:
        if root_key in _MIGRATED_ROOTS:
            return root
        try:
            installed_root = (hermes_home() / "plugins").resolve()
            PLUGIN_ROOT.resolve().relative_to(installed_root)
        except (OSError, ValueError):
            _MIGRATED_ROOTS.add(root_key)
            return root
        for name in _STATE_FILES:
            _move_if_absent(PLUGIN_ROOT / name, root / name)
        for kind in ("image", "video"):
            legacy = PLUGIN_ROOT / "generated" / kind
            if legacy.is_dir():
                for item in legacy.iterdir():
                    _move_if_absent(item, root / "generated" / kind / item.name)
        legacy_chats = PLUGIN_ROOT / "data" / "moa_chats"
        if legacy_chats.is_dir():
            for item in legacy_chats.glob("*.json"):
                _move_if_absent(item, root / "moa_chats" / item.name)
        _MIGRATED_ROOTS.add(root_key)
    return root


def state_dir() -> Path:
    return migrate_legacy_state()


def state_file(name: str) -> Path:
    if name not in _STATE_FILES:
        raise ValueError(f"Unsupported Decuria state file: {name}")
    return state_dir() / name


def chats_dir() -> Path:
    path = state_dir() / "moa_chats"
    path.mkdir(parents=True, exist_ok=True)
    return path


def generated_dir() -> Path:
    path = state_dir() / "generated"
    path.mkdir(parents=True, exist_ok=True)
    return path
