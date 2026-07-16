"""Decuria 插件 · 第 1 部分后端：模型通道切换 + 模型可见性 + 提供商管理。

由 hermes_cli/web_server.py 在启动时导入（dashboard 发现器识别本目录的
manifest.json，并按 `api` 字段挂载本模块的 `router` 到 /api/plugins/decuria/）。

能力：
  GET  /api/plugins/decuria/channels         读取全局默认 + 各通道 model/provider
  POST /api/plugins/decuria/channels         写入某通道 channel_overrides
  POST /api/plugins/decuria/global/model     写入全局 model.default/provider
  GET  /api/plugins/decuria/visibility       读取本插件「可见模型」集合（按 provider 分组）
  POST /api/plugins/decuria/visibility       写入本插件「可见模型」集合（即时生效，无需重启）
  GET  /api/plugins/decuria/providers        读取被禁用的 provider slug 列表
  POST /api/plugins/decuria/providers        新增 provider 到 config.yaml::providers
  DELETE /api/plugins/decuria/providers/{slug}  从 config.yaml::providers 移除 provider
  POST /api/plugins/decuria/providers/{slug}    启用/禁用 provider（存于插件状态文件）

Reads and writes the active profile's config.yaml model, channel override, and
provider sections. Plugin runtime state lives under
`<HERMES_HOME>/data/decuria/`, separate from source assets.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import datetime
import functools
from pathlib import Path
from typing import Dict, List, Optional

import logging as _logging  # module-level: used by error paths even when moa_core imports fine
logger = _logging.getLogger("decuria.plugin_api")
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

try:
    from hermes_cli.config import load_config, save_config
except Exception:  # pragma: no cover - import safety net
    load_config = None
    save_config = None


router = APIRouter()

# Locks cover every process-local read/modify/write transaction.
_visibility_lock = threading.Lock()
_provider_state_lock = threading.Lock()
_provider_keys_lock = threading.Lock()
_orchestrator_lock = threading.Lock()
_proxy_lock = threading.Lock()
_config_lock = threading.RLock()
_moa_run_semaphore = threading.BoundedSemaphore(2)

# Model-universe refresh is process-wide single-flight. Multiple tabs/clients
# join the same generation instead of concurrently wiping caches and racing to
# overwrite model_universe.json with different snapshots.
_universe_refresh_lock = threading.Lock()
_universe_refresh_event: Optional[threading.Event] = None
_universe_refresh_thread: Optional[threading.Thread] = None
_universe_refresh_generation = 0
_universe_refresh_status = "idle"  # idle | refreshing | complete | error
_universe_refresh_error: Optional[str] = None

# Import plugin-local modules without requiring installation as a package.
import sys as _sys  # noqa: E402
from pathlib import Path as _Path  # noqa: E402

_PLUGIN_ROOT = _Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in _sys.path:
    _sys.path.insert(0, str(_PLUGIN_ROOT))
from security_utils import UnsafeURLError, secret_preview, validate_provider_base_url  # noqa: E402
from state_paths import hermes_home, state_file  # noqa: E402

try:
    from moa_core import run_moa, list_chats, get_chat, get_preset  # type: ignore
except Exception as _moa_imp_err:  # pragma: no cover
    _logging.getLogger("decuria.moa_api").warning("moa_core import failed: %s", _moa_imp_err)
    run_moa = list_chats = get_chat = get_preset = None

PLUGIN_DIR = _PLUGIN_ROOT  # source assets only; runtime state is profile-safe
VISIBILITY_FILE = state_file("visibility.json")
PROVIDER_STATE_FILE = state_file("provider_state.json")
PROVIDER_KEYS_FILE = state_file("provider_keys.json")
MODEL_UNIVERSE_FILE = state_file("model_universe.json")
ORCHESTRATOR_STATE_FILE = state_file("orchestrator_state.json")
PROXY_FILE = state_file("proxy.json")
# Cache the (expensive) model universe for 15 min. Building it cold can take
# ~45s (per-provider catalog fetch); warm rebuild is ~0.9s. Caching keeps the
# dashboard plugin at "秒开" after the first warm build.
MODEL_UNIVERSE_TTL = 900

_config_keyed_slugs_cache: Optional[set] = None
_config_keyed_slugs_ts: float = 0.0
_CONFIG_KEYED_SLUGS_TTL = 60  # re-read config.yaml at most once per minute

# visibility.json sentinel semantics:
#   ["*"]                         => every model is hidden by default
#   ["*", "!visible:<model>"]     => default hidden, with explicit visible exceptions
# This keeps models discovered by a later refresh OFF until the user enables them.
_VISIBILITY_ALLOW_PREFIX = "!visible:"


def _invalidate_config_keyed_slugs() -> None:
    """Drop the config credential cache after provider config changes."""
    global _config_keyed_slugs_cache, _config_keyed_slugs_ts
    _config_keyed_slugs_cache = None
    _config_keyed_slugs_ts = 0.0


def _config_keyed_slugs() -> set:
    """Return the set of provider slugs that have explicit config.yaml credentials.

    Cached for _CONFIG_KEYED_SLUGS_TTL seconds to avoid re-reading disk on every call.
    """
    global _config_keyed_slugs_cache, _config_keyed_slugs_ts
    import time as _time
    now = _time.time()
    if _config_keyed_slugs_cache is not None and (now - _config_keyed_slugs_ts) < _CONFIG_KEYED_SLUGS_TTL:
        return _config_keyed_slugs_cache
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
        providers = cfg.get("providers") or {}
        custom = cfg.get("custom_providers") or []
        slugs: set = set()
        for slug, pcfg in (providers.items() if isinstance(providers, dict) else []):
            if isinstance(pcfg, dict):
                has_cred = bool(pcfg.get("api_key") or pcfg.get("key_env"))
                if has_cred:
                    slugs.add(slug)
        for cp in (custom if isinstance(custom, list) else []):
            if isinstance(cp, dict) and cp.get("slug"):
                if cp.get("api_key") or cp.get("base_url"):
                    slugs.add(cp["slug"])
        _config_keyed_slugs_cache = slugs
        _config_keyed_slugs_ts = now
        return slugs
    except Exception:
        return set()

PLATFORM_LABELS = {
    "feishu": "飞书",
    "feishu2": "飞书二",
    "weixin": "微信",
    "webhook": "Webhook",
    "api_server": "API Server",
    "telegram": "Telegram",
    "discord": "Discord",
    "slack": "Slack",
    "whatsapp": "WhatsApp",
    "whatsapp_cloud": "WhatsApp Cloud",
    "signal": "Signal",
    "matrix": "Matrix",
    "line": "Line",
    "kakaotalk": "KakaoTalk",
    "mattermost": "Mattermost",
    "dingtalk": "钉钉",
    "wecom": "企业微信",
    "wecom_callback": "企业微信回调",
    "qqbot": "QQ 机器人",
    "yuanbao": "元宝",
    "bluebubbles": "BlueBubbles",
    "email": "邮件",
    "homeassistant": "Home Assistant",
    "cron": "定时任务",
}


def _mask(channel_id: str) -> str:
    if not channel_id:
        return ""
    s = str(channel_id)
    if len(s) <= 8:
        return "••••"
    return s[:4] + "…" + s[-4:]


def _channel_label(platform: str, channel_id: str) -> str:
    base = PLATFORM_LABELS.get(platform, platform)
    return f"{base} · {_mask(channel_id)}"


# Internal sources that are NOT user-facing messaging platforms
_INTERNAL_SOURCES = frozenset({
    "cli", "tool", "cron", "tui", "hermesos",
})


def _discover_active_platforms_from_statedb(existing_platforms: Dict[str, list]) -> List[dict]:
    """Query Hermes state.db for active session sources that represent real
    messaging platforms not yet covered by config.yaml channel_overrides.

    Returns a list of channel dicts (same shape as the config-based ones) for
    platforms that have at least one non-ended session in state.db.
    """
    statedb_paths = [
        hermes_home() / "state.db",
        hermes_home() / "data" / "state.db",
    ]
    db_path = None
    for p in statedb_paths:
        if p.is_file():
            db_path = p
            break
    if not db_path:
        return []

    extra_channels = []
    try:
        with sqlite3.connect(str(db_path)) as conn:
            cur = conn.cursor()
            # Find sources with active (non-ended) sessions
            cur.execute(
                "SELECT DISTINCT source, chat_id, model "
                "FROM sessions WHERE ended_at IS NULL"
            )
            rows = cur.fetchall()

        # Group by source, collect unique chat_ids and latest model
        platform_chat_ids: Dict[str, set] = {}
        platform_model: Dict[str, str] = {}
        for src, chat_id, model in rows:
            if src in _INTERNAL_SOURCES:
                continue
            if src in existing_platforms:
                continue  # already shown from config.yaml
            if src not in platform_chat_ids:
                platform_chat_ids[src] = set()
            if chat_id:
                platform_chat_ids[src].add(chat_id)
            if model:
                platform_model[src] = model

        # Build channel entries for discovered platforms
        for src, chat_ids in sorted(platform_chat_ids.items()):
            for cid in sorted(chat_ids):
                extra_channels.append(
                    {
                        "platform": src,
                        "channel_id": cid,
                        "channel_label": _channel_label(src, cid),
                        "model": platform_model.get(src),
                        "provider": "",  # not yet configured via overrides
                        "key": "",
                    }
                )
            # If no specific chat_id, still show the platform
            if not chat_ids:
                extra_channels.append(
                    {
                        "platform": src,
                        "channel_id": "",
                        "channel_label": PLATFORM_LABELS.get(src, src),
                        "model": platform_model.get(src),
                        "provider": "",
                        "key": "",
                    }
                )
    except Exception:
        logger.debug("state.db missing or unreadable", exc_info=True)
    return extra_channels


# ---- Visibility (per-provider visible model sets) ------------------------


def _read_visibility() -> Dict[str, List[str]]:
    """Return {provider_slug: [HIDDEN model ids]}. Empty dict => all visible.

    We store the *hidden* set (not the visible set) so the default state —
    an empty file — means every model is shown. Toggling a single model off
    only adds that one model to the hidden list, never silently hides the rest.
    """
    if VISIBILITY_FILE.exists():
        try:
            data = json.loads(VISIBILITY_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                hid = data.get("hidden")
                if isinstance(hid, dict):
                    return {str(k): list(v) for k, v in hid.items() if isinstance(v, list)}
                # 兼容旧版 {visible: {...}} 格式。该格式记录的是「可见」模型，
                # 与现在的「隐藏」语义相反，且缺少完整模型清单无法安全取反；
                # 若按字面当 hidden 处理会静默隐藏错误模型。保守地视为「无隐藏」
                # （全部可见），并提示用户在前端重新保存一次可见性设置。
                if isinstance(data.get("visible"), dict):
                    logger.warning(
                        "visibility.json 检测到旧版 visible 格式，已按「全部可见」处理；"
                        "建议在前端「模型管理」重新保存一次可见性设置"
                    )
                    return {}
        except Exception:
            logger.debug("visibility.json parse failed", exc_info=True)
    return {}


def _atomic_write_json(path, data: object, indent: Optional[int] = None) -> None:
    """Write JSON atomically: serialize to a temp file in the same directory,
    then os.replace() (atomic on Windows) so a concurrent reader never sees a
    half-written file and a crash mid-write can't corrupt the target file."""
    import tempfile

    d = Path(path).parent
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(d), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(path))
        try:
            os.chmod(path, 0o600)
        except OSError:
            logger.debug("failed to restrict permissions for %s", path, exc_info=True)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            logger.debug("failed to clean up temp file %s", tmp, exc_info=True)
        raise


def _write_visibility(hidden: Dict[str, List[str]]) -> Dict[str, List[str]]:
    _atomic_write_json(
        VISIBILITY_FILE,
        {"hidden": {str(k): list(v) for k, v in hidden.items()}},
        indent=2,
    )
    return _read_visibility()


def _hide_all_provider_models(slug: str):
    """Make a newly configured provider persistently default-OFF.

    ``["*"]`` is intentionally kept as a provider-level policy instead of
    materialising today's model ids. Therefore models discovered by a later
    refresh also remain OFF. The frontend stores manually enabled models as
    ``!visible:<model>`` exceptions while preserving the wildcard.
    """
    with _visibility_lock:
        hidden = _read_visibility()
        hidden[slug] = ["*"]
        _write_visibility(hidden)


# ---- Provider enabled/disabled state (plugin-private) --------------------


def _read_provider_state() -> Dict[str, object]:
    if PROVIDER_STATE_FILE.exists():
        try:
            data = json.loads(PROVIDER_STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {
                    "disabled": list(data.get("disabled", [])),
                    "last_added": data.get("last_added") or None,
                }
        except Exception:
            logger.debug("provider_state.json parse failed", exc_info=True)
    return {"disabled": [], "last_added": None}


def _write_provider_state(disabled: List[str], last_added: Optional[str] = None) -> Dict[str, object]:
    state = {"disabled": list(disabled), "last_added": last_added or None}
    _atomic_write_json(PROVIDER_STATE_FILE, state, indent=2)
    return state


# ---- Orchestrator state (plugin-private, independent of Hermes MoA config) --
# Stores the current round-table layout (orchestrator + expert slots) so that
# drag-and-drop survives page refreshes.  Hermes's own /api/model/moa may
# reset/normalize values; this file is the single source of truth for the UI.
# Shape: { "orchestrator": {provider, model, name} | null,
#         "experts": [{provider, model, name} | null, ...],
#         "saved_at": ISO-8601 timestamp }


def _read_orchestrator_state() -> Dict[str, object]:
    if ORCHESTRATOR_STATE_FILE.exists():
        try:
            data = json.loads(ORCHESTRATOR_STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            logger.debug("orchestrator_state.json parse failed", exc_info=True)
    return {
        "orchestrator": None,
        "experts": [None, None, None],
        "debate_enabled": False,
        "debate_rounds": 1,
        "debate_auto_stop": True,
        "saved_at": None,
    }


def _write_orchestrator_state(state: Dict[str, object]) -> Dict[str, object]:
    state["saved_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _atomic_write_json(ORCHESTRATOR_STATE_FILE, state, indent=2)
    return state


# ---- Per-provider ADDITIONAL API keys (plugin-private) --------------------
# Hermes itself only stores ONE credential per provider slug (api_key or
# key_env in config.yaml). Decuria lets the user register EXTRA keys here so
# a channel can pick WHICH key a provider uses. This is kept in a separate
# plugin file so config.yaml stays clean and Hermes' own credential resolution
# is never mutated implicitly.
# Shape: { "<slug>": [ {"key_env": "...", "api_key": "...", "label": "..."}, ... ] }


def _read_provider_keys() -> Dict[str, List[Dict]]:
    if PROVIDER_KEYS_FILE.exists():
        try:
            data = json.loads(PROVIDER_KEYS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {str(k): list(v) for k, v in data.items() if isinstance(v, list)}
        except Exception:
            logger.debug("provider_keys.json parse failed", exc_info=True)
    return {}


def _write_provider_keys(d: Dict[str, List[Dict]]) -> Dict[str, List[Dict]]:
    _atomic_write_json(PROVIDER_KEYS_FILE, d, indent=2)
    return d


# ---- Model universe (cached, lightweight) -------------------------------
# The Hermes /api/model/options endpoint builds the FULL provider universe
# with pricing + capabilities (~3.7s warm, ~45s cold). We only need
# {slug, name, models, authenticated} for the picker, so we build a LIGHT
# payload (no pricing/capabilities) and cache it on disk. This is what makes
# the dashboard plugin open instantly instead of blocking on the heavy call.


def _read_hermes_model_cache() -> Dict[str, List[str]]:
    """Fallback source: Hermes' own per-provider model disk cache.

    ``~/.hermes/provider_models_cache.json`` is maintained by the gateway's
    prewarm thread via ``cached_provider_model_ids()``, which already has a
    "preserve the previous good list on a transient probe failure" rule. So
    even when THIS process' live probe briefly fails (dead proxy, network
    blip, provider hiccup), the gateway's cache usually still holds the last
    known-good model list for an authenticated provider.

    We use it as a SECONDARY fill so the dashboard never shows an
    authenticated provider as "未探测到模型列表" just because one live probe
    round-trip failed — the recurring blank-model symptom across many
    providers is exactly this transient-failure class.

    Returns {slug: [model_ids]}.
    """
    try:
        from hermes_constants import get_hermes_home

        p = get_hermes_home() / "provider_models_cache.json"
        if not p.exists():
            return {}
        d = json.loads(p.read_text(encoding="utf-8"))
        provs = d.get("providers", d) if isinstance(d, dict) else {}
        if not isinstance(provs, dict):
            return {}
        result = {}
        for slug, entry in provs.items():
            if not isinstance(entry, dict):
                continue
            models = entry.get("models") or []
            if models:
                result[str(slug)] = list(models)
        return result
    except Exception:
        return {}


def _build_universe(refresh: bool = False) -> Dict[str, object]:
    """Build a minimal provider→models universe (cheap variant).

    ``refresh`` is forwarded to Hermes' ``build_models_payload``. When the
    DASHBOARD user clicks the 模型管理 refresh button we pass ``refresh=True``
    so providers are actually re-probed (new models surface) instead of
    serving a stale cached model list. Background rebuilds keep ``refresh=False``
    (秒开, cheap).
    """
    try:
        from hermes_cli.inventory import build_models_payload, load_picker_context
    except Exception as _e:
        _logging.warning("MoA universe build skipped, hermes_cli.inventory unavailable: %s", _e)
        return {"providers": [], "built_at": int(time.time()), "stale": True}
    try:
        payload = build_models_payload(
            load_picker_context(),
            include_unconfigured=True,
            picker_hints=True,
            canonical_order=True,
            pricing=False,
            capabilities=False,
            refresh=refresh,
            probe_custom_providers=True,
        )
    except Exception as _e:
        _logging.warning("MoA universe build failed: %s", _e)
        return {"providers": [], "built_at": int(time.time()), "stale": True}
    # Secondary model source (see _read_hermes_model_cache for why).
    hermes_cache = _read_hermes_model_cache()
    out = []
    seen_slugs = set()
    seen_names = set()  # for "custom:X" dedup against configured providers
    for p in (payload.get("providers") or []):
        if not isinstance(p, dict):
            continue
        slug = p.get("slug")
        if not slug or slug in seen_slugs:
            continue
        # Dedup: skip "custom:*" providers whose name matches an existing
        # non-custom provider (auto-discovered endpoint duplicate).
        if slug.startswith("custom:"):
            dup_name = (p.get("name") or slug[len("custom:"):]).lower()
            if dup_name in seen_names:
                continue
        seen_slugs.add(slug)
        seen_names.add((p.get("name") or slug).lower())
        models = p.get("models") or []

        # Hermes refresh clears the disk cache, but some built-in catalogs also
        # keep process-local caches. Force the canonical provider pathway for
        # explicitly configured slugs and prefer that live result when present.
        # User-defined OpenAI-compatible endpoints (such as Agnes) were already
        # probed directly by build_models_payload above; an empty canonical
        # result never overwrites their live list.
        if refresh and slug in _config_keyed_slugs():
            try:
                from hermes_cli.models import cached_provider_model_ids
                forced_models = cached_provider_model_ids(slug, force_refresh=True)
                if forced_models:
                    models = forced_models
            except Exception:
                logger.warning("forced provider refresh failed for %s", slug, exc_info=True)
        # Hardening: an AUTHENTICATED provider that came back with 0 models
        # from the live probe is almost always a transient probe failure
        # (dead proxy / network blip), NOT "no models exist". Fill from the
        # gateway's disk cache so the UI stays populated. _preserve_previous_models
        # (applied later) covers the plugin's OWN prior cache; this covers the
        # case where even the plugin cache was empty (first cold build while the
        # network was down).
        if (not models) and slug and hermes_cache.get(slug):
            models = list(hermes_cache[slug])
        out.append(
            {
                "slug": slug,
                "name": p.get("name") or slug,
                "models": models,
                "authenticated": bool(p.get("authenticated")),
                "auth_type": p.get("auth_type"),
                "key_env": p.get("key_env"),
                "keyed": slug in _config_keyed_slugs(),
            }
        )
    return {"providers": out, "built_at": int(time.time())}


def _read_universe() -> Dict[str, object]:
    if MODEL_UNIVERSE_FILE.exists():
        try:
            data = json.loads(MODEL_UNIVERSE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("providers"), list):
                return data
        except Exception:
            logger.debug("model_universe.json parse failed", exc_info=True)
    return None


def _write_universe(u: Dict[str, object]) -> Dict[str, object]:
    _atomic_write_json(MODEL_UNIVERSE_FILE, u)
    return u


def _refresh_payload(cached: Optional[Dict[str, object]], generation: int) -> Dict[str, object]:
    """Return refresh state without exposing stale data as a successful refresh."""
    with _universe_refresh_lock:
        current_generation = _universe_refresh_generation
        status = _universe_refresh_status
        error = _universe_refresh_error
    data = _read_universe() or cached or {"providers": [], "built_at": 0}
    result = dict(data)
    result["refresh_generation"] = current_generation or generation
    result["refresh_status"] = status
    result["refreshing"] = status == "refreshing"
    if status == "error":
        result["refresh_error"] = error or "model refresh failed"
    return result


def _start_universe_refresh(cached: Optional[Dict[str, object]]) -> tuple[int, threading.Event]:
    """Start or join the process-wide forced-refresh generation."""
    global _universe_refresh_event, _universe_refresh_thread
    global _universe_refresh_generation, _universe_refresh_status, _universe_refresh_error

    with _universe_refresh_lock:
        if (
            _universe_refresh_status == "refreshing"
            and _universe_refresh_thread is not None
            and _universe_refresh_thread.is_alive()
            and _universe_refresh_event is not None
        ):
            return _universe_refresh_generation, _universe_refresh_event

        _universe_refresh_generation += 1
        generation = _universe_refresh_generation
        event = threading.Event()
        _universe_refresh_event = event
        _universe_refresh_status = "refreshing"
        _universe_refresh_error = None
        previous = cached or _read_universe()

        def _run() -> None:
            global _universe_refresh_status, _universe_refresh_error
            try:
                _invalidate_config_keyed_slugs()
                fresh = _build_universe(True)
                if not fresh or fresh.get("stale") or not isinstance(fresh.get("providers"), list) or not fresh["providers"]:
                    raise RuntimeError("provider discovery returned no usable providers")
                _preserve_previous_models(previous, fresh)
                _write_universe(fresh)
                # Universe and MoA are one refresh transaction. A valid empty
                # MoA provider list must overwrite the old cache.
                _write_moa_models(_build_moa_models())
                try:
                    MODEL_UNIVERSE_FILE.with_suffix(".stale").unlink(missing_ok=True)
                except Exception:
                    logger.debug("failed to clear stale marker after refresh", exc_info=True)
                with _universe_refresh_lock:
                    if _universe_refresh_generation == generation:
                        _universe_refresh_status = "complete"
                        _universe_refresh_error = None
            except Exception as exc:
                logger.warning("model-universe forced refresh failed", exc_info=True)
                _invalidate_universe()
                with _universe_refresh_lock:
                    if _universe_refresh_generation == generation:
                        _universe_refresh_status = "error"
                        _universe_refresh_error = str(exc)
            finally:
                event.set()

        thread = threading.Thread(target=_run, daemon=True, name=f"decuria-model-refresh-{generation}")
        _universe_refresh_thread = thread
        thread.start()
        return generation, event


def _invalidate_universe() -> None:
    """Mark the cached universe STALE (do NOT delete the file) so the next
    read still serves the existing cache instantly (秒开) and triggers a
    background rebuild. Deleting the file would force a blocking cold build on
    the next request — exactly the multi-second hang we are eliminating."""
    try:
        MODEL_UNIVERSE_FILE.with_suffix(".stale").touch()
    except Exception:
        logger.debug("failed to create stale marker", exc_info=True)


def _preserve_previous_models(prev: Dict[str, object], fresh: Dict[str, object]) -> None:
    """Hardening: a transient probe failure can make an *authenticated* provider
    report 0 models even though it had models before. If we blindly write the
    empty list, the UI silently drops that model list forever (until a manual
    cache wipe). So: if a provider that was previously populated now comes back
    empty AND is authenticated, keep the previous models instead of [].

    Mutates `fresh` in place. `prev` is left untouched."""
    if not prev or not isinstance(prev.get("providers"), list):
        return
    prev_by_slug = {p.get("slug"): p for p in prev["providers"]}
    for p in fresh.get("providers") or []:
        if (not p.get("models")) and p.get("authenticated"):
            old = prev_by_slug.get(p.get("slug"))
            if old and old.get("models"):
                p["models"] = list(old["models"])


def _require_config():
    if load_config is None or save_config is None:
        raise HTTPException(status_code=500, detail="config backend unavailable")
    return load_config(), save_config


def _serialized_config_write(func):
    """Serialize config read/modify/write cycles within this process."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with _config_lock:
            return func(*args, **kwargs)
    return wrapper


# ---- Channels + global ---------------------------------------------------


@router.get("/channels")
def get_channels(response: Response):
    response.headers["Cache-Control"] = "no-store"
    cfg, _ = _require_config()
    model_cfg = cfg.get("model", {}) or {}
    global_info = {
        "model": model_cfg.get("default"),
        "provider": model_cfg.get("provider"),
        "key": (model_cfg.get("key") or "") if isinstance(model_cfg, dict) else "",
    }
    channels = []
    platforms = cfg.get("platforms", {}) or {}
    # Track which platforms we already have from config
    config_platforms: Dict[str, list] = {}
    if isinstance(platforms, dict):
        for platform_name, platform_cfg in platforms.items():
            if not isinstance(platform_cfg, dict):
                continue
            overrides = platform_cfg.get("channel_overrides", {}) or {}
            if not isinstance(overrides, dict):
                continue
            config_platforms[platform_name] = list(overrides.keys())
            for channel_id, override in overrides.items():
                if not isinstance(override, dict):
                    override = {}
                channels.append(
                    {
                        "platform": platform_name,
                        "channel_id": channel_id,
                        "channel_label": _channel_label(platform_name, channel_id),
                        "model": override.get("model"),
                        "provider": override.get("provider"),
                        "key": (override.get("key") or "") if isinstance(override, dict) else "",
                    }
                )
    # Also discover active platforms from state.db (e.g. qqbot, telegram)
    # that have live sessions but no config.yaml entry yet.
    channels.extend(_discover_active_platforms_from_statedb(config_platforms))
    return {"global": global_info, "channels": channels}


class GlobalModelBody(BaseModel):
    model: str = Field(default="", max_length=256)
    provider: str = Field(default="", max_length=128)
    key: str = Field(default="", max_length=256)


def _key_preview(raw: str) -> str:
    return secret_preview(raw)


@router.get("/keys")
def get_provider_keys(response: Response, provider: str = ""):
    response.headers["Cache-Control"] = "no-store"
    """Return available API-key information for providers.

    Query params:
      provider: if set, return only that provider's keys;
               if empty, return all providers that have at least one key.

    Response shape:
      { "keys": { "<slug>": [ {id,label,key_env?,api_key_preview?,has_key,source}, ... ] } }
    The first entry (id="primary") is the provider's primary credential from
    config.yaml, either embedded as ``api_key`` or referenced by ``key_env``.
    Subsequent entries (id="k_N") are extra keys registered via the dashboard.
    Only masked previews are returned; raw credentials never leave this API.
    """
    cfg, _ = _require_config()
    providers_cfg = cfg.get("providers", {}) or {}
    added = _read_provider_keys()
    result: Dict[str, List[Dict]] = {}
    slugs = list(providers_cfg.keys()) if isinstance(providers_cfg, dict) else []
    if provider:
        slugs = [provider] if provider in providers_cfg else ([provider] if provider in added else [])
    for slug in slugs:
        entry = providers_cfg.get(slug) if isinstance(providers_cfg, dict) else None
        keys: List[Dict] = []
        if isinstance(entry, dict):
            key_env = str(entry.get("key_env") or "").strip()
            direct_key = str(entry.get("api_key") or "").strip()
            if key_env or direct_key:
                resolved_key = _resolve_provider_key(entry)
                source = "config_yaml" if direct_key else "environment"
                info: Dict = {
                    "id": "primary",
                    "label": "KEY",
                    "source": source,
                    "has_key": bool(resolved_key),
                }
                if key_env:
                    info["key_env"] = key_env
                if resolved_key:
                    info["api_key_preview"] = f"KEY {_key_preview(resolved_key)}"
                keys.append(info)
        for i, key_entry in enumerate(added.get(slug, []) or []):
            if not isinstance(key_entry, dict):
                continue
            key_env = str(key_entry.get("key_env") or "").strip()
            direct_key = str(key_entry.get("api_key") or "").strip()
            resolved_key = _resolve_provider_key(key_entry)
            info = {
                "id": "k_%d" % i,
                "label": key_entry.get("label") or "KEY",
                "source": "config_yaml" if direct_key else ("environment" if key_env else "missing"),
                "has_key": bool(resolved_key),
            }
            if key_env:
                info["key_env"] = key_env
            if resolved_key:
                info["api_key_preview"] = f"KEY {_key_preview(resolved_key)}"
            keys.append(info)
        if keys:
            result[slug] = keys
    return {"keys": result}


# ---- Visibility ----------------------------------------------------------


def _sync_auxiliary_vision(cfg: dict, vision: dict) -> None:
    """Mirror the Decuria '图片识别模型' (vision) fallback row onto
    config.yaml::auxiliary.vision.

    Why: Hermes' native image routing (agent/image_routing.py:
    decide_image_input_mode -> 'text' mode -> gateway._enrich_message_with_vision
    -> vision_analyze_tool) reads auxiliary.vision.{provider,model} to pick the
    backend that describes images for a TEXT-ONLY main model (e.g. deepseek).
    Writing this block is what makes "文字模型遇到图片自动委派 vision 模型" work —
    no custom tool or multi-agent needed.

    `vision` is {model, provider, key} (already stripped). When model/provider
    are blank we REMOVE auxiliary.vision so routing falls back to the default.
    The provider's own credential (config.yaml::providers[provider]) is used
    automatically; only set `key` here to OVERRIDE it with an explicit api_key.
    """
    aux = cfg.get("auxiliary")
    if not isinstance(aux, dict):
        aux = {}
        cfg["auxiliary"] = aux
    model = (vision.get("model") or "").strip()
    provider = (vision.get("provider") or "").strip()
    if model and provider:
        entry = {"provider": provider, "model": model}
        # Preserve any user-set timeout/temperature/base_url/api_mode already on
        # the auxiliary.vision entry (set directly in config or by other tools).
        existing = aux.get("vision") if isinstance(aux.get("vision"), dict) else {}
        for _keep in ("timeout", "temperature", "base_url", "api_mode"):
            if _keep in existing and _keep not in entry:
                entry[_keep] = existing[_keep]
        key = (vision.get("key") or "").strip()
        if key:
            entry["api_key"] = key
        aux["vision"] = entry
    else:
        aux.pop("vision", None)
        if not aux:
            cfg.pop("auxiliary", None)


@router.get("/fallback")
def get_fallback(response: Response):
    response.headers["Cache-Control"] = "no-store"
    """Return the optional multi-modal FALLBACK models (image).

    Stored under config.yaml::model.fallback so they live next to the global
    default model. Each entry is {model, provider, key}. An empty/missing
    entry means "no fallback configured for that modality".
    """
    cfg, _ = _require_config()
    model_cfg = cfg.get("model", {}) or {}
    fb = model_cfg.get("fallback", {}) or {}

    def pick(x):
        if isinstance(x, dict):
            return {
                "model": x.get("model") or "",
                "provider": x.get("provider") or "",
                "key": x.get("key") or "",
            }
        return {"model": "", "provider": "", "key": ""}

    # 注意：必须同时返回 image/vision/video 三项，与前端三行候补 UI 及
    # batch_save 的持久化（model.fallback.video）保持一致，否则视频候补
    # 保存后重加载会丢失，且下次「保存全部」会被清空（数据丢失）。
    image = pick(fb.get("image"))
    vision = pick(fb.get("vision"))
    video = pick(fb.get("video"))

    # Compatibility: Hermes' native image routing stores its visual model in
    # auxiliary.vision. Older configs (or another settings surface) may have
    # that value without the Decuria-specific model.fallback.vision mirror.
    # Surface it here instead of rendering a misleading empty row. The
    # provider's primary credential remains selected; never expose api_key.
    if not vision.get("model") and not vision.get("provider"):
        auxiliary = cfg.get("auxiliary", {}) or {}
        auxiliary_vision = auxiliary.get("vision") if isinstance(auxiliary, dict) else None
        if isinstance(auxiliary_vision, dict):
            vision = {
                "model": str(auxiliary_vision.get("model") or ""),
                "provider": str(auxiliary_vision.get("provider") or ""),
                "key": "",
            }

    return {"image": image, "vision": vision, "video": video}


# ---- Batch save (global + fallback + channels in one request) -------------

class BatchChannelItem(BaseModel):
    platform: str = Field(max_length=64)
    channel_id: str = Field(max_length=256)
    model: str = Field(default="", max_length=256)
    provider: str = Field(default="", max_length=128)
    key: str = Field(default="", max_length=256)


class BatchFallbackEntry(BaseModel):
    model: str = Field(default="", max_length=256)
    provider: str = Field(default="", max_length=128)
    key: str = Field(default="", max_length=256)


class BatchSaveBody(BaseModel):
    global_model: Optional[GlobalModelBody] = None
    fallback_image: Optional[BatchFallbackEntry] = None
    fallback_vision: Optional[BatchFallbackEntry] = None
    fallback_video: Optional[BatchFallbackEntry] = None
    channels: Optional[List[BatchChannelItem]] = Field(default=None, max_length=500)


@router.post("/config/batch")
@_serialized_config_write
def batch_save(body: BatchSaveBody):
    """Atomically write global default, fallback models AND channel overrides
    in a single request. The frontend collects all row states and sends them
    together when the user clicks the single 'Save All' button."""
    cfg, save = _require_config()
    errors = []

    # 1. Global default model
    if body.global_model is not None:
        g = body.global_model
        if g.model and g.provider:
            model_cfg = cfg.setdefault("model", {})
            if not isinstance(model_cfg, dict):
                model_cfg = {}
                cfg["model"] = model_cfg
            model_cfg["default"] = g.model.strip()
            model_cfg["provider"] = g.provider.strip()
            k = (g.key or "").strip()
            if k:
                model_cfg["key"] = k
            else:
                model_cfg.pop("key", None)
        else:
            errors.append("global: model/provider 为空，已跳过")

    # 2. Fallback (image + vision + video)
    vision_sync = None  # None => vision row not specified on this call
    for kind, entry in [("image", body.fallback_image), ("vision", body.fallback_vision), ("video", body.fallback_video)]:
        if entry is not None:
            fb = cfg.setdefault("model", {}).setdefault("fallback", {})
            if not isinstance(fb, dict):
                fb = {}
                cfg.setdefault("model", {})["fallback"] = fb
            if entry.model and entry.provider:
                fb[kind] = {
                    "model": entry.model.strip(),
                    "provider": entry.provider.strip(),
                    "key": (entry.key or "").strip(),
                }
                if kind == "vision":
                    vision_sync = {
                        "model": entry.model.strip(),
                        "provider": entry.provider.strip(),
                        "key": (entry.key or "").strip(),
                    }
            else:
                fb.pop(kind, None)
                if kind == "vision":
                    vision_sync = {"model": "", "provider": "", "key": ""}
    # Mirror the vision fallback row onto auxiliary.vision for native routing.
    if vision_sync is not None:
        _sync_auxiliary_vision(cfg, vision_sync)

    # 3. Channel overrides
    if body.channels:
        platforms = cfg.setdefault("platforms", {})
        if not isinstance(platforms, dict):
            platforms = {}
            cfg["platforms"] = platforms
        for ch in body.channels:
            platform = (ch.platform or "").strip()
            channel_id = (ch.channel_id or "").strip()
            model = (ch.model or "").strip()
            provider = (ch.provider or "").strip()
            if not platform or not channel_id:
                continue  # skip incomplete rows
            platform_cfg = platforms.setdefault(platform, {})
            if not isinstance(platform_cfg, dict):
                platform_cfg = {}
                platforms[platform] = platform_cfg
            overrides = platform_cfg.setdefault("channel_overrides", {})
            if not isinstance(overrides, dict):
                overrides = {}
                platform_cfg["channel_overrides"] = overrides
            existing = overrides.get(channel_id)
            new_override = dict(existing) if isinstance(existing, dict) else {}
            if model and provider:
                new_override["model"] = model
                new_override["provider"] = provider
            k = (ch.key or "").strip()
            if k:
                new_override["key"] = k
            elif model and provider:
                new_override.pop("key", None)
            overrides[channel_id] = new_override

    save(cfg)
    return {"ok": True, "errors": errors} if errors else {"ok": True}


@router.get("/visibility")
def get_visibility():
    return {"hidden": _read_visibility()}


class VisibilityBody(BaseModel):
    hidden: Dict[str, List[str]] = Field(default_factory=dict)


@router.post("/visibility")
def set_visibility(body: VisibilityBody):
    if len(body.hidden) > 200:
        raise HTTPException(status_code=400, detail="提供商数量超过限制")
    hidden: Dict[str, List[str]] = {}
    for provider, models in body.hidden.items():
        if len(provider) > 128 or len(models) > 5000:
            raise HTTPException(status_code=400, detail="可见性配置超过限制")
        if any(not isinstance(model, str) or len(model) > 512 for model in models):
            raise HTTPException(status_code=400, detail="模型标识无效或过长")
        hidden[str(provider)] = list(dict.fromkeys(models))
    with _visibility_lock:
        return {"hidden": _write_visibility(hidden)}


# ---- Provider management -------------------------------------------------


@router.get("/providers")
def get_providers():
    state = _read_provider_state()
    cfg, _ = _require_config()
    providers_cfg = cfg.get("providers", {}) or {}
    configured = list(providers_cfg.keys()) if isinstance(providers_cfg, dict) else []
    keyed = []

    # Start with configured providers from config.yaml
    prov_list = []
    if isinstance(providers_cfg, dict):
        for slug, entry in providers_cfg.items():
            has_cred = isinstance(entry, dict) and (entry.get("api_key") or entry.get("key_env"))
            if has_cred:
                keyed.append(slug)
            name = (entry.get("name") if isinstance(entry, dict) else None) or slug
            prov_list.append({"slug": slug, "name": name, "keyed": bool(has_cred), "authenticated": bool(has_cred)})

    # Merge in all providers from the model universe (includes unconfigured ones)
    # so 供应商管理 shows the FULL list, not just configured providers.
    universe = _read_universe()
    if universe and isinstance(universe.get("providers"), list):
        seen = {p["slug"] for p in prov_list}
        # Track names of existing providers to detect ALL duplicates (not just
        # "custom:*" — Hermes may auto-discover under any slug variant).
        seen_names = {(p.get("name") or "").lower() for p in prov_list}
        for p in universe["providers"]:
            slug = p.get("slug")
            if not slug or slug in seen:
                continue
            # Strong dedup: skip ANY universe provider whose name (case-
            # insensitive) already exists in the config.yaml / existing list.
            # This prevents openrouter, custom:openrouter, openrouter.ai etc.
            prov_name = (p.get("name") or slug).lower()
            if prov_name in seen_names:
                continue
            # Mark as unconfigured in config.yaml (no api_key), but reflect
            # Hermes' own authenticated status (e.g. provider discovered via an
            # env var like NVIDIA_API_KEY) so 供应商管理 agrees with 模型管理
            # on whether the provider is usable. See issue: nvidia showed green
            # in 模型管理 but "未配置" in 供应商管理.
            prov_list.append({
                "slug": slug,
                "name": p.get("name") or slug,
                "keyed": False,  # Not in config.yaml, so no editable key
                "authenticated": bool(p.get("authenticated")),
            })
            seen.add(slug)
            seen_names.add(prov_name)

    state["configured"] = configured
    state["keyed"] = keyed

    # Pin the most-recently-added provider to the TOP of the list so it is
    # immediately visible after the user adds it (and on every later reload).
    last_added = state.get("last_added")
    if last_added:
        idx = -1
        for i, p in enumerate(prov_list):
            if p.get("slug") == last_added:
                idx = i
                break
        if idx > 0:
            item = prov_list.pop(idx)
            prov_list.insert(0, item)
        elif idx == 0:
            pass  # already first

    state["providers"] = prov_list
    return state


@router.get("/model-universe")
def get_model_universe(refresh: bool = False, generation: int = 0):
    """Return the cached universe and coordinate live refresh generations.

    A user refresh starts (or joins) one process-wide probe. The request waits
    up to 90 seconds; if providers are still responding it returns an explicit
    ``refreshing`` status that the frontend polls. Completion atomically updates
    both model_universe.json and the MoA model cache.
    """
    cached = _read_universe()

    if refresh:
        current_generation, event = _start_universe_refresh(cached)
        event.wait(timeout=90)
        return _refresh_payload(cached, current_generation)

    # Poll a generation started by a previous refresh request.
    if generation:
        return _refresh_payload(cached, generation)

    if cached and isinstance(cached, dict) and cached.get("providers"):
        stale_marker = MODEL_UNIVERSE_FILE.with_suffix(".stale")
        expired = (int(time.time()) - (cached.get("built_at") or 0)) > MODEL_UNIVERSE_TTL
        if stale_marker.exists() or expired:
            current_generation, _ = _start_universe_refresh(cached)
            return _refresh_payload(cached, current_generation)

        with _universe_refresh_lock:
            refreshing = _universe_refresh_status == "refreshing"
            current_generation = _universe_refresh_generation
        if refreshing:
            return _refresh_payload(cached, current_generation)
        return cached

    # Cold start uses the same bounded single-flight path instead of allowing
    # the first request to block indefinitely on slow provider endpoints.
    current_generation, event = _start_universe_refresh(cached)
    event.wait(timeout=30)
    return _refresh_payload(cached, current_generation)


# ---- MoA round-table model list (real models + offline context) ---------
# Reuses the SAME lightweight universe build as /model-universe (no slow
# pricing/capabilities live probe), then enriches each model with a
# best-effort CONTEXT LENGTH resolved offline from Hermes' local caches
# (context_length_cache.yaml + model_metadata.DEFAULT_CONTEXT_LENGTHS). This
# is what lets the MoA detail card show a REAL context window without the
# ~3.7s warm / ~45s cold cost of the full /api/model/options build.
_MOA_MODELS_FILE = state_file("moa_models.json")
_MOA_MODELS_TTL = 15 * 60  # 15 min


def _resolve_context_offline(model_id):
    """Best-effort offline context length for a model id (no network)."""
    if not model_id:
        return None
    mid = str(model_id)
    # 1) Hermes' disk cache (keyed "model@base_url"); match by model prefix.
    try:
        from hermes_constants import get_hermes_home

        p = get_hermes_home() / "context_length_cache.yaml"
        if p.exists():
            import yaml as _yaml

            data = _yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            cl = data.get("context_lengths", {})
            if isinstance(cl, dict):
                for key, val in cl.items():
                    if isinstance(key, str) and key.split("@", 1)[0] == mid:
                        try:
                            return int(val)
                        except (TypeError, ValueError):
                            logger.debug("Invalid context_length value for %s: %s", mid, val)
    except Exception:
        logger.debug("offline context cache read failed for %s", model_id, exc_info=True)
    # 2) Hardcoded defaults, longest-key-first substring match.
    try:
        from agent.model_metadata import DEFAULT_CONTEXT_LENGTHS

        best = None
        for key, val in DEFAULT_CONTEXT_LENGTHS.items():
            if key and key in mid:
                if best is None or len(key) > len(best[0]):
                    best = (key, val)
        if best:
            return best[1]
    except Exception:
        logger.debug("DEFAULT_CONTEXT_LENGTHS lookup failed", exc_info=True)
    return None


def _read_moa_models():
    try:
        if _MOA_MODELS_FILE.exists():
            return json.loads(_MOA_MODELS_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.debug("moa_models.json parse failed", exc_info=True)
    return None


def _write_moa_models(data):
    try:
        _atomic_write_json(_MOA_MODELS_FILE, data)
    except Exception:
        logger.warning("moa_models.json write failed", exc_info=True)
    return data


def _read_fixed_provider_slugs():
    """Slugs the user explicitly configured in config.yaml::providers — their
    "fixed" model integrations. Used to scope the MoA bench to providers the
    user actually set up, so auto-discovered catalogs the user never added
    (e.g. qwen/kimi, which have no fixed provider) are excluded.
    """
    try:
        if load_config is None:
            return set()
        cfg = load_config()
        provs = cfg.get("providers") or []
        slugs = set()
        for pr in provs:
            if isinstance(pr, dict) and pr.get("slug"):
                slugs.add(pr["slug"])
            elif isinstance(pr, str):
                slugs.add(pr)
        return slugs
    except Exception:
        return set()


def _build_moa_models():
    """Build MoA model list for the round-table.

    Mirrors the model-management tab's notion of "enabled" models, scoped to the
    providers the user actually configured:
      * ONLY providers present in config.yaml::providers (the user's "fixed"
        integrations) — excludes qwen/kimi etc. which have no fixed provider.
      * ONLY providers with an API key configured (authenticated).
      * ONLY models ENABLED in model-management = universe models minus the
        visibility hidden set (effectiveHidden).

    Source = model_universe.json cache (same as model-management); falls back to
    build_models_payload only if the cache is missing.
    """
    # 1) Fixed providers = the user's configured integrations.
    fixed_slugs = _read_fixed_provider_slugs()

    # 2) Model universe (preferred) or live build.
    try:
        if MODEL_UNIVERSE_FILE.exists():
            cache = json.loads(MODEL_UNIVERSE_FILE.read_text(encoding="utf-8"))
    except Exception:
        cache = None

    payload_providers = []
    if isinstance(cache, dict) and cache.get("providers"):
        payload_providers = cache["providers"]
    else:
        try:
            from hermes_cli.inventory import build_models_payload, load_picker_context
            ctx = load_picker_context()
            payload = build_models_payload(
                ctx,
                include_unconfigured=True,
                picker_hints=True,
                canonical_order=True,
                pricing=False,
                capabilities=False,
                refresh=False,
                probe_custom_providers=True,
            )
            payload_providers = payload.get("providers") or []
        except Exception:
            return {"providers": [], "built_at": int(time.time())}

    # 3) Filter: fixed provider + authenticated + not-disabled + not-hidden.
    hidden_by_provider = _read_visibility()  # {slug: [hidden_model_ids]}
    # P2-3 修复：读取 disabled provider 列表，排除用户禁用的 provider
    disabled_providers = set(_read_provider_state().get("disabled") or [])
    hermes_cache = _read_hermes_model_cache()
    out = []

    for p in payload_providers:
        if not isinstance(p, dict):
            continue
        slug = p.get("slug")
        # FIXED-PROVIDER GATE: only the user's configured integrations.
        if slug not in fixed_slugs:
            continue
        if not p.get("authenticated"):
            continue  # Skip providers without API key
        # P2-3 修复：排除用户禁用的 provider
        if slug in disabled_providers:
            continue

        # ``*`` means default-hidden, while ``!visible:<model>`` entries are
        # explicit user-enabled exceptions that survive future model refreshes.
        hidden_list = hidden_by_provider.get(slug) or []
        default_hidden = "*" in hidden_list
        visible_overrides = {
            item[len(_VISIBILITY_ALLOW_PREFIX):]
            for item in hidden_list
            if isinstance(item, str) and item.startswith(_VISIBILITY_ALLOW_PREFIX)
        }
        hidden_set = {
            item for item in hidden_list
            if item != "*" and not (
                isinstance(item, str) and item.startswith(_VISIBILITY_ALLOW_PREFIX)
            )
        }
        models_raw = list(p.get("models") or [])

        # Universe cache may have empty models for some providers — try Hermes cache.
        if not models_raw and slug in hermes_cache:
            models_raw = [{"id": m} for m in hermes_cache[slug]]

        out_models = []
        seen = set()
        for m in models_raw:
            if isinstance(m, dict):
                mid = m.get("id") or m.get("model")
                mname = m.get("name") or mid
            else:
                mid = m
                mname = str(m)
            if not mid or mid in seen:
                continue
            # Include only user-enabled models. In wildcard mode, every future
            # model remains hidden unless it has an explicit visible override.
            if (default_hidden and mid not in visible_overrides) or mid in hidden_set:
                continue
            # Exclude image/video generation models — unsuitable for MoA reasoning.
            _ml = mid.lower()
            _nl = mname.lower()
            if "image" in _nl or "image" in _ml or "video" in _nl or "video" in _ml:
                continue
            seen.add(mid)
            out_models.append({
                "id": mid,
                "name": mname,
                "context": _resolve_context_offline(mid),
            })

        if not out_models:
            continue  # Skip providers with zero enabled models
        out.append({
            "slug": slug,
            "name": p.get("name") or slug,
            "authenticated": True,
            "models": out_models,
        })

    return {"providers": out, "built_at": int(time.time())}


def _rebuild_moa_models_async():
    def _run():
        try:
            _write_moa_models(_build_moa_models())
        except Exception:
            logger.warning("moa_models async rebuild failed", exc_info=True)

    try:
        threading.Thread(target=_run, daemon=True, name="decuria-moa-models-refresh").start()
    except Exception:
        logger.warning("failed to start moa_models rebuild thread", exc_info=True)


@router.get("/moa/models")
def get_moa_models(refresh: bool = False):
    """Real model list for the MoA round-table, with offline context length.

    A successful build may legitimately contain zero providers after the user
    disables or hides everything; that empty result must replace the old cache.
    """
    cached = _read_moa_models()
    if refresh:
        fresh = _build_moa_models()
        if fresh and isinstance(fresh.get("providers"), list):
            return _write_moa_models(fresh)
        if isinstance(cached, dict):
            return cached
        return {"providers": [], "built_at": int(time.time())}

    if isinstance(cached, dict) and isinstance(cached.get("providers"), list):
        if (int(time.time()) - (cached.get("built_at") or 0)) > _MOA_MODELS_TTL:
            _rebuild_moa_models_async()
        return cached
    return _write_moa_models(_build_moa_models())


class ProviderAddBody(BaseModel):
    slug: str = Field(max_length=64)
    name: str = Field(default="", max_length=128)
    base_url: str = Field(default="", max_length=2048)
    api_key: str = Field(default="", max_length=8192)
    key_env: str = Field(default="", max_length=128)


@router.post("/providers")
@_serialized_config_write
def add_provider(body: ProviderAddBody):
    cfg, save = _require_config()
    slug = (body.slug or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="slug 不能为空")
    if not slug.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="slug 只能包含字母、数字、- 和 _")
    providers = cfg.get("providers")
    if providers is None:
        providers = {}
        cfg["providers"] = providers
    elif isinstance(providers, list):
        # Migrate legacy list form → dict keyed by slug/name so existing
        # providers are preserved (not wiped) when a new one is added.
        migrated = {}
        for pr in providers:
            if isinstance(pr, dict) and pr.get("slug"):
                migrated[pr["slug"]] = pr
            elif isinstance(pr, str):
                migrated[pr] = {}
        providers = migrated
        cfg["providers"] = providers
    elif not isinstance(providers, dict):
        providers = {}
        cfg["providers"] = providers
    entry = {}
    if body.base_url:
        try:
            entry["base_url"] = validate_provider_base_url(body.base_url)
        except UnsafeURLError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.api_key:
        entry["api_key"] = body.api_key
    if body.key_env:
        entry["key_env"] = body.key_env
    # Keep any pre-existing fields (e.g. key_env) if the slug already exists.
    if slug in providers and isinstance(providers[slug], dict):
        entry = dict(providers[slug], **entry)
    providers[slug] = entry
    save(cfg)
    _invalidate_config_keyed_slugs()
    # Pin the just-added provider to the TOP of the 提供商管理 list so the
    # user immediately sees it after adding (persisted across reloads).
    st = _read_provider_state()
    st["last_added"] = slug
    _write_provider_state(st["disabled"], last_added=slug)
    _invalidate_universe()

    # New provider: hide ALL its models by default so they don't flood MoA bench.
    _hide_all_provider_models(slug)

    return {"slug": slug, "provider": {
        "name": entry.get("name", "") or slug,
        "base_url": entry.get("base_url", "") or "",
        "key_env": entry.get("key_env", "") or "",
        "has_key": bool(_resolve_provider_key(entry)),
    }}


@router.delete("/providers/{slug}")
@_serialized_config_write
def remove_provider(slug: str):
    cfg, save = _require_config()
    providers = cfg.get("providers", {}) or {}
    if not isinstance(providers, dict) or slug not in providers:
        raise HTTPException(status_code=404, detail=f"provider {slug} 不存在")
    providers.pop(slug, None)
    save(cfg)
    _invalidate_config_keyed_slugs()
    # Clear the pin if we just removed the provider that was pinned.
    st = _read_provider_state()
    if st.get("last_added") == slug:
        st["last_added"] = None
        _write_provider_state(st["disabled"], last_added=None)
    _invalidate_universe()
    return {"slug": slug, "removed": True}


class ProviderToggleBody(BaseModel):
    disabled: bool


@router.post("/providers/{slug}")
def set_provider_disabled(slug: str, body: ProviderToggleBody):
    # P2-4 修复：加锁保护 provider_state 的 read-modify-write 操作
    with _provider_state_lock:
        state = _read_provider_state()
        disabled = set(state["disabled"])
        if body.disabled:
            disabled.add(slug)
        else:
            disabled.discard(slug)
        _invalidate_universe()
        return _write_provider_state(sorted(disabled), last_added=state.get("last_added"))


# ---- Edit a provider (PUT) + read current content (GET) -----------------


class ProviderEditBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=128)
    base_url: Optional[str] = Field(default=None, max_length=2048)
    api_key: Optional[str] = Field(default=None, max_length=8192)
    key_env: Optional[str] = Field(default=None, max_length=128)



def _resolve_provider_key(entry: dict) -> str:
    """Return the actual API key for a provider config entry.

    Priority:
      1. entry["api_key"] if set directly in config.yaml
      2. os.environ resolved from entry["key_env"]
      3. fallback: read ~/.hermes/.env for key_env value
    """
    ak = entry.get("api_key", "") or ""
    if isinstance(ak, str) and ak.strip():
        return ak.strip()
    ke = entry.get("key_env", "") or ""
    if isinstance(ke, str) and ke.strip():
        ke = ke.strip()
        # Try runtime environment first
        val = os.environ.get(ke, "")
        if val:
            return val
        # Fall back to the active profile's .env file. Using get_hermes_home()
        # keeps this correct for both the default home and named profiles.
        try:
            from hermes_constants import get_hermes_home
            env_file = get_hermes_home() / ".env"
        except Exception:
            env_file = hermes_home() / ".env"
        if env_file.exists():
            try:
                for line in env_file.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        ek, ev = line.split("=", 1)
                        if ek.strip() == ke:
                            return ev.strip()
            except Exception:
                logger.debug("failed to read env var %s from .env", ke, exc_info=True)
    return ""


@router.get("/providers/{slug}")
def get_provider(slug: str, response: Response, reveal: bool = False):
    """Return provider metadata; credentials require an explicit reveal request."""
    response.headers["Cache-Control"] = "no-store"
    cfg, _ = _require_config()
    providers_cfg = cfg.get("providers", {}) or {}
    entry = providers_cfg.get(slug) if isinstance(providers_cfg, dict) else None
    if not isinstance(entry, dict):
        return {
            "slug": slug,
            "name": slug,
            "base_url": "",
            "api_key": "",
            "key_env": "",
            "configured": False,
        }
    resolved_key = _resolve_provider_key(entry)
    return {
        "slug": slug,
        "name": entry.get("name", "") or slug,
        "base_url": entry.get("base_url", "") or "",
        "api_key": resolved_key if reveal else "",
        "api_key_preview": _key_preview(resolved_key) if resolved_key else "",
        "has_key": bool(resolved_key),
        "key_env": entry.get("key_env", "") or "",
        "configured": True,
    }


@router.put("/providers/{slug}")
@_serialized_config_write
def edit_provider(slug: str, body: ProviderEditBody):
    cfg, save = _require_config()
    providers = cfg.setdefault("providers", {})
    if not isinstance(providers, dict):
        providers = {}
        cfg["providers"] = providers
    entry = providers.get(slug)
    if not isinstance(entry, dict):
        entry = {}
        providers[slug] = entry
    if body.name is not None:
        entry["name"] = body.name.strip()
    if body.base_url is not None:
        if body.base_url.strip():
            try:
                entry["base_url"] = validate_provider_base_url(body.base_url)
            except UnsafeURLError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        else:
            entry.pop("base_url", None)
    if body.api_key is not None:
        entry["api_key"] = body.api_key.strip()
    if body.key_env is not None:
        entry["key_env"] = body.key_env.strip()
    save(cfg)
    _invalidate_config_keyed_slugs()
    _invalidate_universe()

    # Pin the just-edited provider to the TOP of 提供商管理 + 模型管理 lists
    # (persisted across reloads) so the most-recently-edited provider is always
    # first — matches the add-provider behaviour.
    st = _read_provider_state()
    _write_provider_state(st.get("disabled") or [], last_added=slug)

    return {"slug": slug, "provider": {
        "name": entry.get("name", "") or slug,
        "base_url": entry.get("base_url", "") or "",
        "key_env": entry.get("key_env", "") or "",
        "has_key": bool(_resolve_provider_key(entry)),
    }}


# ---- Extra API keys per provider (add / list / delete) ------------------


class ProviderKeyAddBody(BaseModel):
    key_env: str = Field(default="", max_length=128)
    api_key: str = Field(default="", max_length=8192)
    label: str = Field(default="", max_length=128)


def _public_extra_keys(items: List[Dict]) -> List[Dict]:
    result = []
    for index, item in enumerate(items):
        raw = str(item.get("api_key") or "")
        result.append({
            "id": f"k_{index}",
            "label": item.get("label") or f"密钥 {index + 1}",
            "key_env": item.get("key_env") or "",
            "api_key_preview": _key_preview(raw) if raw else "",
            "has_key": bool(raw),
        })
    return result


@router.post("/providers/{slug}/keys")
def add_provider_key(slug: str, body: ProviderKeyAddBody):
    with _provider_keys_lock:
        added = _read_provider_keys()
        lst = list(added.get(slug) or [])
        if len(lst) >= 20:
            raise HTTPException(status_code=400, detail="每个提供商最多保存 20 个额外密钥")
        item = {}
        if body.key_env.strip():
            item["key_env"] = body.key_env.strip()
        if body.api_key.strip():
            item["api_key"] = body.api_key.strip()
        if body.label.strip():
            item["label"] = body.label.strip()
        if not item:
            raise HTTPException(status_code=400, detail="key_env 或 api_key 至少填一项")
        lst.append(item)
        added[slug] = lst
        _write_provider_keys(added)
        return {"slug": slug, "keys": _public_extra_keys(lst)}


@router.delete("/providers/{slug}/keys/{idx}")
def delete_provider_key(slug: str, idx: int):
    with _provider_keys_lock:
        added = _read_provider_keys()
        lst = list(added.get(slug) or [])
        if idx < 0 or idx >= len(lst):
            raise HTTPException(status_code=404, detail=f"key 索引 {idx} 不存在")
        lst.pop(idx)
        if lst:
            added[slug] = lst
        else:
            added.pop(slug, None)
        _write_provider_keys(added)
        return {"slug": slug, "keys": _public_extra_keys(lst)}


# ---- MoA model token usage (from state.db) -------------------------------


def _find_state_db() -> Optional[Path]:
    """Locate Hermes state.db (session/token store)."""
    for candidate in [
        hermes_home() / "state.db",
        hermes_home() / "data" / "state.db",
    ]:
        if candidate.is_file():
            return candidate
    return None


@router.get("/moa/usage")
def get_moa_usage():
    """Aggregate per-model token usage from Hermes state.db.

    Returns a dict keyed by model_id so the MoA detail card can show real
    input/output tokens and session count instead of static pricing rows.

    Response shape::
      {
        "models": { "<model_id>": { ... } },   # ALL sessions per model
        "moa_models": { "<model_id>": { ... } }, # MoA-only sessions per model (requires moa_loop session tagging)
        "total_models": 15,
        "grand_total": { ... }
      }

    The frontend calls this once on MoA mount and caches the result; individual
    model lookups are O(1) from the returned dict.
    """
    db_path = _find_state_db()
    if not db_path:
        return {"models": {}, "moa_models": {}, "total_models": 0, "grand_total": _empty_totals()}

    try:
        with sqlite3.connect(str(db_path)) as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT model, "
                "COALESCE(SUM(input_tokens), 0), "
                "COALESCE(SUM(output_tokens), 0), "
                "COALESCE(SUM(cache_read_tokens), 0), "
                "COALESCE(SUM(cache_write_tokens), 0), "
                "COUNT(*) "
                "FROM sessions "
                "WHERE model IS NOT NULL AND model != '' "
                "GROUP BY model"
            )
            rows = cur.fetchall()

        models: Dict[str, dict] = {}
        grand_in = grand_out = grand_cr = grand_cw = grand_sessions = 0

        for mid, inp, out, cr, cw, cnt in rows:
            mid = str(mid).strip()
            if not mid:
                continue
            total = int(inp or 0) + int(out or 0) + int(cr or 0) + int(cw or 0)
            models[mid] = {
                "input_tokens": int(inp or 0),
                "output_tokens": int(out or 0),
                "total_tokens": total,
                "session_count": int(cnt or 0),
                "cache_read_tokens": int(cr or 0),
                "cache_write_tokens": int(cw or 0),
            }
            grand_in += int(inp or 0)
            grand_out += int(out or 0)
            grand_cr += int(cr or 0)
            grand_cw += int(cw or 0)
            grand_sessions += int(cnt or 0)

        # ── MoA-only stats ──
        # MoA chat data lives in plugin's own data/moa_chats/*.json files, NOT in
        # state.db sessions table.  Scan those files to build per-model usage.
        import json as _json
        moa_models: Dict[str, dict] = {}
        # ── 按渠道来源分组的统计（新增：用于智囊团用量总览的渠道维度）──
        by_source: Dict[str, dict] = {}
        moa_grand_in = moa_grand_out = moa_grand_sessions = 0
        _moa_data_dir = PLUGIN_DIR / "data" / "moa_chats"
        try:
            if _moa_data_dir.is_dir():
                for _f in _moa_data_dir.glob("*.json"):
                    try:
                        _chat = _json.loads(_f.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    # 渠道来源
                    _src = (_chat.get("source") or "panel").strip()
                    if _src not in by_source:
                        by_source[_src] = {"session_count": 0, "total_tokens": 0}
                    by_source[_src]["session_count"] += 1

                    # Each file = 1 MoA session; collect all models used in it
                    _seen_in_session = set()
                    _session_tokens = 0
                    for _turn in _chat.get("turns") or []:
                        for _ref in (_turn.get("references") or []):
                            _mid = str(_ref.get("model", "") or "").strip()
                            if not _mid:
                                continue
                            _seen_in_session.add(_mid)
                            _tok = _estimate_tokens(_ref.get("content", ""))
                            _session_tokens += _tok
                            if _mid not in moa_models:
                                moa_models[_mid] = {"input_tokens": 0, "output_tokens": 0, "session_count": 0}
                            moa_models[_mid]["input_tokens"] += _tok // 2   # rough: half input
                            moa_models[_mid]["output_tokens"] += _tok - _tok // 2
                        _agg = _turn.get("aggregator")
                        if _agg and isinstance(_agg, dict):
                            _amid = str(_agg.get("model", "") or "").strip()
                            if _amid:
                                _seen_in_session.add(_amid)
                                _atok = _estimate_tokens(_agg.get("content", ""))
                                _session_tokens += _atok
                                if _amid not in moa_models:
                                    moa_models[_amid] = {"input_tokens": 0, "output_tokens": 0, "session_count": 0}
                                moa_models[_amid]["input_tokens"] += _atok // 2
                                moa_models[_amid]["output_tokens"] += _atok - _atok // 2
                    # bump session count for each model that appeared in this chat
                    for _sid in _seen_in_session:
                        if _sid in moa_models:
                            moa_models[_sid]["session_count"] += 1
                    # 累加到该渠道的 token 总量
                    by_source[_src]["total_tokens"] += _session_tokens
                    moa_grand_sessions += 1
                # compute grand totals
                for _mv in moa_models.values():
                    moa_grand_in += int(_mv.get("input_tokens", 0))
                    moa_grand_out += int(_mv.get("output_tokens", 0))
        except Exception:
            logger.warning("MoA usage aggregation failed", exc_info=True)

        # P1-1 修复：明确区分全量统计和 MoA 专属统计
        # grand_total: 全量统计（所有 sessions，包括普通聊天和 MoA）
        # moa_grand_total: MoA 专属统计（仅从 moa_chats/*.json 读取）
        return {
            "models": models,
            "moa_models": moa_models,
            "by_source": by_source,
            "total_models": len(models),
            "grand_total": {
                # 全量统计（所有 sessions）
                "input_tokens": grand_in,
                "output_tokens": grand_out,
                "total_tokens": grand_in + grand_out + grand_cr + grand_cw,
                "session_count": grand_sessions,
                "cache_read_tokens": grand_cr,
                "cache_write_tokens": grand_cw,
            },
            "moa_grand_total": {
                # MoA 专属统计（仅从 moa_chats/*.json）
                "input_tokens": moa_grand_in,
                "output_tokens": moa_grand_out,
                "total_tokens": moa_grand_in + moa_grand_out,
                "session_count": moa_grand_sessions,
            },
        }
    except Exception:
        import traceback
        _logging.warning("MoA usage query failed: %s", traceback.format_exc())
        return {"models": {}, "moa_models": {}, "total_models": 0, "grand_total": _empty_totals()}


def _estimate_tokens(text: str) -> int:
    """Estimate token count from text length.

    P2-1 修复：改进估算算法，更准确反映真实 token 数量。
    - CJK 字符（中日韩）：约 1.5 字符 = 1 token
    - 其他字符（拉丁、数字等）：约 4 字符 = 1 token
    - 空格和标点：约 4 字符 = 1 token
    """
    if not text:
        return 0

    # 统计 CJK 字符数量（中日韩统一表意文字 + 日文假名）
    _cjk = sum(1 for _ch in text if "\u4e00" <= _ch <= "\u9fff" or "\u3000" <= _ch <= "\u30ff")
    _other = len(text) - _cjk

    # CJK: 1.5 字符 ≈ 1 token (比之前的 1:1 更准确)
    # 其他: 4 字符 ≈ 1 token
    return int(_cjk / 1.5) + max(_other // 4, 0)


def _empty_totals():
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "session_count": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }


# ---------------------------------------------------------------------------
# Decuria 自有 MoA 执行核心层 · 接口
#   前端「智囊团聊天」面板与渠道 hook 都复用 moa_core，不依赖 Hermes 核心。
# ---------------------------------------------------------------------------
class _MoaRunBody(BaseModel):
    preset_id: str = Field(default="default", max_length=64)
    prompt: str = Field(min_length=1, max_length=100_000)
    debate: bool = False
    debate_rounds: int = Field(default=2, ge=1, le=5)
    auto_stop: bool = True
    reference_models_override: Optional[List[Dict[str, str]]] = Field(default=None, max_length=8)
    aggregator_override: Optional[Dict[str, str]] = None
    source: Optional[str] = Field(default=None, max_length=64)


@router.post("/moa/run")
def moa_run(body: _MoaRunBody):
    """Run one bounded MoA discussion and persist its structured result."""
    import traceback

    if run_moa is None:
        raise HTTPException(status_code=500, detail="moa_core 未加载")
    if not _moa_run_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="智囊团任务已达并发上限，请稍后重试")
    try:
        return run_moa(
            body.preset_id,
            body.prompt,
            debate=body.debate,
            debate_rounds=body.debate_rounds,
            auto_stop=body.auto_stop,
            reference_models_override=body.reference_models_override,
            aggregator_override=body.aggregator_override,
            source=body.source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("moa/run failed: %s\n%s", exc, traceback.format_exc())
        raise HTTPException(status_code=500, detail="MoA 执行失败，请查看服务端日志") from exc
    finally:
        _moa_run_semaphore.release()


@router.get("/moa/chats")
def moa_chats(preset: str = "default"):
    """列出某组合方案的智囊团会话（按时间倒序）。"""
    if list_chats is None:
        raise HTTPException(status_code=500, detail="moa_core 未加载")
    try:
        return {"preset": preset, "sessions": list_chats(preset)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("moa/chats failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="读取会话列表失败，请查看服务端日志")


@router.get("/moa/chats/{session_id}")
def moa_chat_detail(session_id: str):
    """读取单次智囊团会话的完整对话。"""
    if get_chat is None:
        raise HTTPException(status_code=500, detail="moa_core 未加载")
    rec = get_chat(session_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="session not found")
    return rec


# ---- Orchestrator round-table state (plugin-private) ----------------------


class _OrchestratorStateBody(BaseModel):
    orchestrator: Optional[Dict[str, str]] = None
    experts: List[Optional[Dict[str, str]]] = Field(default_factory=list, max_length=8)
    debate_enabled: Optional[bool] = None
    debate_rounds: int = Field(default=1, ge=1, le=5)
    debate_auto_stop: bool = True


def _validate_model_slot(slot: Optional[Dict[str, str]]) -> None:
    if slot is None:
        return
    if any(len(str(value)) > 512 for value in slot.values()):
        raise HTTPException(status_code=400, detail="模型席字段过长")


@router.get("/orchestrator")
def get_orchestrator_state():
    return _read_orchestrator_state()


@router.put("/orchestrator")
def put_orchestrator_state(body: _OrchestratorStateBody):
    _validate_model_slot(body.orchestrator)
    for expert in body.experts:
        _validate_model_slot(expert)
    debate_enabled = (
        body.debate_enabled
        if body.debate_enabled is not None
        else body.debate_rounds > 1
    )
    debate_rounds = (
        max(2, body.debate_rounds) if debate_enabled else 1
    )
    state = {
        "orchestrator": body.orchestrator,
        "experts": body.experts,
        "debate_enabled": debate_enabled,
        "debate_rounds": debate_rounds,
        "debate_auto_stop": body.debate_auto_stop,
    }
    with _orchestrator_lock:
        return _write_orchestrator_state(state)


# ── IP 代理配置（按提供商粒度，profile-safe）────────────────────


class _ProxyPerProviderBody(BaseModel):
    proxy_url: Optional[str] = Field(default=None, max_length=2048)
    enabled_providers: Dict[str, bool] = Field(default_factory=dict)
    test_only: bool = False
    test_host: Optional[str] = Field(default=None, max_length=253)
    test_port: int = Field(default=0, ge=0, le=65535)


def _read_proxy() -> dict:
    """读取代理配置；文件不存在返回空默认。兼容新旧格式。"""
    try:
        if PROXY_FILE.exists():
            return json.loads(PROXY_FILE.read_text("utf-8"))
    except Exception:
        logger.debug("proxy.json parse failed", exc_info=True)
    return {"proxy_url": "", "enabled_providers": {}}


def _write_proxy(data: dict) -> dict:
    _atomic_write_json(PROXY_FILE, data, indent=2)
    return data


def _normalise_proxy_url(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if "://" not in value:
        value = "http://" + value
    try:
        return validate_provider_base_url(value)
    except UnsafeURLError as exc:
        raise HTTPException(status_code=400, detail=f"代理地址无效：{exc}") from exc


def _apply_proxy_to_config(proxy_url: str, enabled: Dict[str, bool]) -> int:
    """Explicitly update model routes through Hermes' config save API."""
    cfg, save = _require_config()
    routes = cfg.get("model_routes") or {}
    if not isinstance(routes, dict):
        routes = {}
    changed = 0
    enabled_slugs = {slug for slug, on in enabled.items() if on}
    for entry in routes.values():
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("route") or "")
        desired = proxy_url if slug in enabled_slugs and proxy_url else None
        if desired and entry.get("proxy") != desired:
            entry["proxy"] = desired
            changed += 1
        elif not desired and "proxy" in entry:
            entry.pop("proxy", None)
            changed += 1
    if changed:
        cfg["model_routes"] = routes
        save(cfg)
    return changed


@router.get("/proxy")
def get_proxy_config(response: Response):
    """Read the active profile's per-provider proxy configuration."""
    response.headers["Cache-Control"] = "no-store"
    return _read_proxy()


@router.post("/proxy")
def set_proxy_config(body: _ProxyPerProviderBody):
    """Save profile state and explicitly apply it through Hermes config APIs.

    Plugin registration itself never mutates config.yaml. Test mode performs a
    bounded connectivity check and never writes state.
    """
    # ── 测试模式：只测连通性，不写入任何文件 ──
    if body.test_only:
        import ipaddress
        import socket

        host = (body.test_host or "").strip()
        port = body.test_port or 0
        if not host or not port:
            return {"ok": False, "error": "地址和端口不能为空"}

        # ── P0-2 (S2) SSRF 防护 ──
        # 限制可探测目标：
        #   1) 必须与已保存 proxy.json::proxy_url 的 host 一致；或
        #   2) 必须是 loopback（127.0.0.0/8 / ::1）。
        # 这样即使 session token 泄漏，攻击者也无法用本接口扫描内网。
        # 解析 proxy.json::proxy_url 的 host：
        def _extract_proxy_host(url: str) -> str:
            """从 'host:port' / 'http://host:port' / 'http://host' 提取 host。"""
            if not url:
                return ""
            s = url.strip()
            if "://" in s:
                s = s.split("://", 1)[1]
            # 去掉 path / query
            s = s.split("/", 1)[0]
            # 去掉 user@pass@
            if "@" in s:
                s = s.rsplit("@", 1)[1]
            # 去掉 :port（注意 IPv6 [::1]:8080 形式）
            if s.startswith("["):
                end = s.find("]")
                return s[1:end] if end > 0 else s
            return s.rsplit(":", 1)[0]

        def _is_loopback(host: str) -> bool:
            """判定 host 是否解析到 loopback 地址（防 DNS rebinding 绕过）。

            host 可以是 IP 字面量，也可以是域名（会先 DNS 解析）。
            任一解析结果非 loopback → 拒绝（防 127.0.0.1 + 公网 IP 双记录绕过）。
            """
            try:
                addrs = socket.getaddrinfo(host, None)
            except Exception:
                return False
            if not addrs:
                return False
            for _fam, _stype, _proto, _canon, sa in addrs:
                try:
                    ip = ipaddress.ip_address(sa[0])
                except Exception:
                    return False
                if not ip.is_loopback:
                    # 任一解析地址不是 loopback → 拒绝
                    return False
            return True

        saved = _read_proxy()
        saved_url = str(saved.get("proxy_url", "") or "").strip()
        if saved_url and "://" not in saved_url:
            saved_url = "http://" + saved_url
        try:
            from urllib.parse import urlsplit
            saved_parts = urlsplit(saved_url)
            saved_host = (saved_parts.hostname or "").lower()
            saved_port = saved_parts.port or (443 if saved_parts.scheme == "https" else 80)
        except (TypeError, ValueError):
            saved_host, saved_port = "", 0
        # A remote target must exactly match the already-saved endpoint.
        # Loopback remains testable before the first save for local proxies.
        host_allowed = False
        if saved_host and host.lower() == saved_host and int(port) == saved_port:
            host_allowed = True
        elif _is_loopback(host):
            host_allowed = True
        # 同时禁止解析到公网 IP 的 host（防 DNS rebinding 到内网边界绕过）
        if not host_allowed:
            return {
                "ok": False,
                "error": (
                    "测试目标被 SSRF 防护拦截：仅允许与已保存 proxy.json 一致的 host，"
                    "或 loopback 地址。请先在 proxy.json 中配置代理地址，再点测试。"
                ),
            }

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            result = sock.connect_ex((host, int(port)))
            if result == 0:
                try:
                    sock.sendall(b"CONNECT httpbin.org:80 HTTP/1.1\r\nHost: httpbin.org\r\n\r\n")
                    resp = sock.recv(1024)
                    resp_text = resp.decode("utf-8", errors="ignore").strip()
                    if resp_text.startswith("HTTP/"):
                        _status_parts = resp_text.split("\r\n")[0].split()
                        # 严格解析状态码：仅当第二位 token 为整型且 == 200 才判定成功
                        if len(_status_parts) >= 2 and _status_parts[1].isdigit() and int(_status_parts[1]) == 200:
                            sock.close()
                            return {"ok": True, "message": f"{host}:{port} 代理可用（HTTP CONNECT 响应正常）"}
                except Exception:
                    logger.debug("proxy CONNECT test failed for %s:%s", host, port, exc_info=True)
                sock.close()
                return {"ok": True, "message": f"{host}:{port} 端口可达（TCP 连接成功）"}
            else:
                sock.close()
                # 同时兼容 Linux errno 与 Windows WinSock 错误码
                # （Windows 上 socket.connect_ex 返回 WSA* 码而非 errno）。
                err_map = {
                    111: "连接被拒绝（Connection refused）",    # Linux ECONNREFUSED
                    10061: "连接被拒绝（Connection refused）",  # WSAECONNREFUSED
                    113: "无路由到主机（No route to host）",    # Linux EHOSTUNREACH
                    10065: "无路由到主机（No route to host）",  # WSAEHOSTUNREACH
                    110: "连接超时（Connection timed out）",    # Linux ETIMEDOUT
                    10060: "连接超时（Connection timed out）",  # WSAETIMEDOUT
                    101: "网络不可达（Network unreachable）",    # Linux ENETUNREACH
                    10051: "网络不可达（Network unreachable）",  # WSAENETUNREACH
                }
                msg = err_map.get(result, f"连接失败（错误码 {result}）")
                return {"ok": False, "error": f"{host}:{port} {msg}"}
        except socket.timeout:
            return {"ok": False, "error": f"{host}:{port} 连接超时（> 5s）"}
        except Exception:
            logger.warning("proxy connectivity test failed", exc_info=True)
            return {"ok": False, "error": "代理连接测试失败"}

    # Normal save mode: persist profile state and explicitly apply through the
    # Hermes config API. Plugin registration never mutates config.yaml.
    with _proxy_lock, _config_lock:
        previous = _read_proxy()
        raw_url = previous.get("proxy_url", "") if body.proxy_url is None else body.proxy_url
        proxy_url = _normalise_proxy_url(raw_url)
        enabled = {str(k).strip(): bool(v) for k, v in body.enabled_providers.items() if str(k).strip()}
        if len(enabled) > 200 or any(len(slug) > 128 for slug in enabled):
            raise HTTPException(status_code=400, detail="代理提供商配置超过限制")
        if any(enabled.values()) and not proxy_url:
            raise HTTPException(status_code=400, detail="开启提供商代理前必须填写代理地址")
        changed = _apply_proxy_to_config(proxy_url, enabled)
        data = {"proxy_url": proxy_url, "enabled_providers": enabled}
        _write_proxy(data)
        return {**data, "applied_routes": changed}
