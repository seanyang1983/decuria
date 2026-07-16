"""Decuria 媒体生成工具集：图片 / 视频 自动路由到已配置的候补模型。

设计（与用户确认的「融入智能体 + 原生多 Agent 委派」架构）：
  - 默认模型（如 DeepSeek 纯文本）自身不能出图/视频时，调用本插件注册的
    decuria_image_generate / decuria_video_generate 工具。
  - 每个工具优先通过 Hermes 原生的 delegate_task 拉起一个 *临时* 子智能体
    （ephemeral，绝不出现在 /profiles 页面），由子智能体调用内部工具
    decuria_media_generate 实际调 agnes-image / agnes-video 端点生成并落盘。
  - 若网关环境下 delegate_task 不可用（拿不到 parent_agent），则自动回退为
    直接本地生成，核心路由功能不受影响。

目标模型来自 config.model.fallback.{image,video}（Decuria 仪表盘已配置），
其 provider 凭据从 config.providers[slug] 解析。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
import urllib.request
from pathlib import Path
from typing import Dict, Optional, Tuple
from urllib.parse import urlsplit

try:
    from .security_utils import (
        MAX_IMAGE_BYTES, MAX_JSON_BYTES, MAX_VIDEO_BYTES, UnsafeURLError,
        decode_base64_payload, open_url, read_limited, validate_provider_base_url,
    )
    from .state_paths import generated_dir, hermes_home
except ImportError:
    from security_utils import (
        MAX_IMAGE_BYTES, MAX_JSON_BYTES, MAX_VIDEO_BYTES, UnsafeURLError,
        decode_base64_payload, open_url, read_limited, validate_provider_base_url,
    )
    from state_paths import generated_dir, hermes_home

logger = logging.getLogger("decuria.media_tools")

# ---------------------------------------------------------------------------
# 跨线程状态（delegate_task 在调用线程内同步执行子智能体，故 thread-local 安全）
# ---------------------------------------------------------------------------
_thread_local = threading.local()

# 插件上下文（register() 时捕获），用于通过 ctx.dispatch_tool 走 delegate_task
_CTX = None

PLUGIN_DIR = Path(__file__).resolve().parent
GENERATED_DIR = generated_dir()

DEFAULT_IMAGE_SIZE = "1024x1024"


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name(dest.name + ".part")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, dest)
    finally:
        temporary.unlink(missing_ok=True)


def _hermes_cache_dir(kind: str = "videos") -> Optional[Path]:
    """返回 Hermes 白名单缓存目录（用于媒体投递）。

    网关的 validate_media_delivery_path 只允许从以下路径投递附件：
      - _HERMES_HOME/cache/{videos,images,audio,...}  （复数，与 _MEDIA_DELIVERY_CACHE_SUBDIRS 一致）
      - _HERMES_ROOT/profiles/<name>/cache/{videos,images,...}

    插件自己的 generated/ 目录不在白名单里，直接返回会导致
    「Skipping unsafe MEDIA directive path」。

    kind 映射：video→videos, image→images, audio→audio（保持复数）。
    """
    hermes_root = hermes_home()
    # 网关 _MEDIA_DELIVERY_CACHE_SUBDIRS 用复数名
    dir_map = {"video": "videos", "videos": "videos", "image": "images", "images": "images", "audio": "audio"}
    subdir = dir_map.get(kind, kind + "s") if kind else "videos"

    candidate = hermes_root / "cache" / subdir
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except OSError:
        logger.debug("failed to create cache directory %s", candidate, exc_info=True)
    # 回退：~/.hermes/<subdir>_cache
    candidate = hermes_root / f"{subdir}_cache"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except OSError:
        logger.debug("failed to create fallback cache directory %s", candidate, exc_info=True)
    return None


def _copy_for_delivery(src: str, kind: str) -> Optional[str]:
    """把生成的文件复制到 Hermes 缓存目录以便网关投递。

    返回缓存中的新路径（用于 MEDIA: 标签），失败则返回 None（仍可用原始路径做本地展示）。
    """
    src_p = Path(src)
    if not src_p.exists():
        return None
    cache_dir = _hermes_cache_dir(kind)
    if not cache_dir:
        return None
    dest = cache_dir / src_p.name
    try:
        import shutil
        temporary = dest.with_name(dest.name + ".part")
        try:
            shutil.copy2(str(src_p), str(temporary))
            os.replace(temporary, dest)
        finally:
            temporary.unlink(missing_ok=True)
        return str(dest)
    except Exception:
        logger.debug("failed to copy generated file to cache", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# tool_result / tool_error（与原生工具一致，返回 JSON 字符串）
# ---------------------------------------------------------------------------
try:  # pragma: no cover - 运行期由 hermes_cli 提供
    from tools.registry import tool_result, tool_error
except Exception:  # pragma: no cover - 兜底，便于独立测试
    def tool_result(data=None, **kw):
        if data is not None:
            return json.dumps(data, ensure_ascii=False)
        return json.dumps(kw, ensure_ascii=False)

    def tool_error(message, **extra):
        return json.dumps({"error": str(message), **extra}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# 配置解析
# ---------------------------------------------------------------------------
def _resolve_target(kind: str) -> Tuple[Optional[Dict], Optional[str]]:
    """从 config.model.fallback.<kind> 解析出目标 provider / model / base_url / api_key。"""
    try:
        from hermes_cli.config import load_config
    except Exception as e:  # pragma: no cover
        return None, f"无法导入 hermes_cli.config：{e}"

    cfg = load_config()
    if not isinstance(cfg, dict):
        return None, "config 不是预期结构"

    fb = (cfg.get("model") or {}).get("fallback") or {}
    entry = fb.get(kind)
    if not isinstance(entry, dict):
        return None, (
            f"未配置 {kind} 候补模型。请在 Decuria 仪表盘的「通道配置 → 候补模型」"
            f"中设置 model.fallback.{kind}（provider + model）。"
        )
    provider = entry.get("provider")
    model = entry.get("model")
    if not provider or not model:
        return None, f"model.fallback.{kind} 缺少 provider 或 model 字段"

    prov = (cfg.get("providers") or {}).get(provider)
    if not isinstance(prov, dict):
        return None, f"找不到 provider 配置：{provider}"
    base_url = prov.get("base_url")
    if not base_url:
        return None, f"provider {provider} 缺少 base_url"
    try:
        base_url = validate_provider_base_url(str(base_url))
    except UnsafeURLError:
        return None, f"provider {provider} 的 base_url 不安全或无效"

    api_key = prov.get("api_key") or os.environ.get(
        prov.get("key_env") or prov.get("api_key_env") or ""
    )
    return {
        "provider": provider,
        "model": model,
        "base_url": str(base_url).rstrip("/"),
        "api_key": api_key or "",
    }, None


# ---------------------------------------------------------------------------
# HTTP helpers (validated redirects + bounded responses)
# ---------------------------------------------------------------------------
def _private_host(url: str) -> tuple[str, ...]:
    host = urlsplit(url).hostname
    return (host,) if host else ()


def _http_post_json(url: str, api_key: str, payload: dict, timeout: int = 120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with open_url(req, timeout=timeout, allow_private_hosts=_private_host(url)) as response:
        raw = read_limited(response, MAX_JSON_BYTES)
        return response.status, json.loads(raw.decode("utf-8", "replace"))


def _http_get_json(url: str, api_key: str, timeout: int = 30):
    req = urllib.request.Request(url, method="GET", headers={"Authorization": f"Bearer {api_key}"})
    with open_url(req, timeout=timeout, allow_private_hosts=_private_host(url)) as response:
        raw = read_limited(response, MAX_JSON_BYTES)
        return response.status, json.loads(raw.decode("utf-8", "replace"))


def _download(
    url: str,
    dest: Path,
    *,
    timeout: int,
    max_bytes: int,
    media_kind: str,
    provider_base: str,
) -> None:
    req = urllib.request.Request(url, method="GET")
    allowed_private = _private_host(provider_base) if urlsplit(url).hostname == urlsplit(provider_base).hostname else ()
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with open_url(req, timeout=timeout, allow_private_hosts=allowed_private) as response:
            content_type = (response.headers.get("Content-Type") or "").split(";", 1)[0].lower()
            allowed_types = (media_kind + "/", "application/octet-stream")
            if content_type and not any(content_type.startswith(prefix) for prefix in allowed_types):
                raise ValueError("媒体响应 Content-Type 无效")
            length = response.headers.get("Content-Length")
            if length and int(length) > max_bytes:
                raise ValueError("媒体文件超过允许大小")
            total = 0
            with tmp.open("wb") as handle:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("媒体文件超过允许大小")
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _persist_video(value: str, kind_dir: Path, provider_base: str) -> Tuple[Optional[str], Optional[str]]:
    dest = kind_dir / f"{uuid.uuid4().hex}.mp4"
    if str(value).strip().lower().startswith(("http://", "https://")):
        _download(
            value, dest, timeout=600, max_bytes=MAX_VIDEO_BYTES,
            media_kind="video", provider_base=provider_base,
        )
    else:
        _atomic_write_bytes(dest, decode_base64_payload(value, MAX_VIDEO_BYTES))
    return str(dest), None



# ---------------------------------------------------------------------------
# 核心生成（直接调用目标 provider 的图片/视频端点）
# ---------------------------------------------------------------------------
def _generate(
    kind: str,
    prompt: str,
    aspect_ratio: Optional[str] = None,
    duration: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """返回 (本地文件路径, 错误信息)。成功时同时写入 thread-local 最近生成记录。"""
    target, err = _resolve_target(kind)
    if err:
        return None, err

    base, key, model = target["base_url"], target["api_key"], target["model"]

    # 【关键】直接写到 Hermes 白名单缓存目录（而非插件 generated/）。
    # 原因：LLM Agent 会在工具返回后自主跑终端命令检查文件，
    # 终端输出的路径会被 extract_local_files 抓取做安全校验。
    # 只有文件本身就在白名单目录里，才能保证无论 Agent 怎么发现路径都能通过。
    cache_dir = _hermes_cache_dir(kind)
    kind_dir = cache_dir if cache_dir else GENERATED_DIR / kind
    kind_dir.mkdir(parents=True, exist_ok=True)

    try:
        if kind == "image":
            status, resp = _http_post_json(
                f"{base}/images/generations", key,
                {"model": model, "prompt": prompt, "n": 1,
                 "size": aspect_ratio or DEFAULT_IMAGE_SIZE},
                timeout=120,
            )
            if status != 200:
                logger.warning("image generation failed with HTTP %s", status)
                return None, f"图片生成请求失败 (HTTP {status})"
            items = resp.get("data") or []
            if not items:
                return None, "图片生成返回空 data"
            url = items[0].get("url") or items[0].get("b64_json")
            if not url:
                return None, "图片生成返回中既没有 url 也没有 b64_json"
            dest = kind_dir / f"{uuid.uuid4().hex}.png"
            if str(url).strip().lower().startswith(("http://", "https://")):
                _download(
                    url, dest, timeout=180, max_bytes=MAX_IMAGE_BYTES,
                    media_kind="image", provider_base=base,
                )
            else:
                _atomic_write_bytes(dest, decode_base64_payload(url, MAX_IMAGE_BYTES))
            _thread_local.last_generated = (str(dest), kind)
            return str(dest), None

        elif kind == "video":
            payload = {"model": model, "prompt": prompt, "n": 1}
            if duration:
                try:
                    payload["duration"] = int(duration)
                except (TypeError, ValueError):
                    logger.warning("Invalid duration value: %s, skipping", duration)
            # 1) 创建异步视频生成任务（agnes / OpenAI 兼容：返回 task_id，需轮询）
            status, resp = _http_post_json(
                f"{base}/videos", key, payload, timeout=120,
            )
            if status != 200:
                logger.warning("video generation failed with HTTP %s", status)
                return None, f"视频生成请求失败 (HTTP {status})"
            task_id = resp.get("task_id") or resp.get("id") or resp.get("video_id")
            if not task_id:
                # 兼容同步直接返回 url 的 provider
                single = (resp.get("url") or resp.get("video_url") or resp.get("output")
                          or (resp.get("metadata") or {}).get("url"))
                items = resp.get("data") or []
                if single and not items:
                    items = [{"url": single}]
                if items:
                    vurl = (items[0].get("url") or items[0].get("b64_json")
                            or (items[0].get("metadata") or {}).get("url"))
                    if vurl:
                        path, err = _persist_video(vurl, kind_dir, base)
                        if err:
                            return None, err
                        _thread_local.last_generated = (path, kind)
                        return path, None
                return None, "视频生成未返回任务 ID"
            # 2) 轮询任务直到完成（最多约 3 分钟，每 2 秒一次）
            video_url = None
            for _ in range(100):
                time.sleep(3)
                st, pres = _http_get_json(f"{base}/videos/{task_id}", key, timeout=30)
                if st != 200:
                    continue
                pstatus = str(pres.get("status") or "").lower()
                if pstatus in ("succeeded", "success", "completed"):
                    md = pres.get("metadata") or {}
                    video_url = (
                        pres.get("url") or pres.get("video_url") or pres.get("output")
                        or pres.get("download_url") or pres.get("file_url")
                        or md.get("url") or md.get("video_url") or md.get("download_url")
                    )
                    if not video_url and pres.get("data"):
                        video_url = pres["data"][0].get("url") or pres["data"][0].get("b64_json")
                    break
                if pstatus in ("failed", "error"):
                    return None, "视频生成任务失败"
            if not video_url:
                return None, "视频生成轮询超时，未获取到视频 URL"
            path, err = _persist_video(video_url, kind_dir, base)
            if err:
                return None, err
            _thread_local.last_generated = (path, kind)
            return path, None

    except Exception as exc:  # network/parse boundary
        logger.warning("media generation failed: %s", type(exc).__name__, exc_info=True)
        return None, f"生成过程失败（{type(exc).__name__}）"


# ---------------------------------------------------------------------------
# 结果封装（multimodal 信封，UI 直接渲染图片/视频）
# ---------------------------------------------------------------------------
def _to_multimodal(path: str, kind: str, prompt: str) -> dict:
    # 复制到 Hermes 白名单缓存目录（网关只从白名单目录投递附件）
    delivery_path = _copy_for_delivery(path, kind)

    # 统一使用白名单路径：避免原始 plugins/ 路径泄漏到 LLM 响应文本中，
    # 导致 extract_local_files 抓到非白名单路径被 validate_media_delivery_path 拦截。
    exposed_path = delivery_path if delivery_path else path
    url = f"file://{exposed_path}"

    if kind == "image":
        content = [
            {"type": "text", "text": f"已为你生成图片：{prompt}"},
            {"type": "image_url", "image_url": {"url": url}},
        ]
    else:  # video
        # 文本部分包含 MEDIA 标签：LLM 会看到它并大概率保留在最终回复中，
        # 网关 extract_media 靠此标签提取路径并调用 send_video 投递。
        # 即使 LLM 改写措辞，extract_local_files 的裸路径正则也能兜底（路径已在白名单目录）。
        media_tag_in_text = f"MEDIA:{exposed_path}" if delivery_path else ""
        content = [
            {"type": "text", "text": f"已为你生成视频：{prompt} {media_tag_in_text}"},
            {"type": "video_url", "video_url": {"url": url}},
        ]

    # 文本摘要：包含 MEDIA 标签（网关 extract_media 靠此提取路径投递）
    if delivery_path:
        media_tag = f"MEDIA:{delivery_path}"
        text_summary = f"已生成{kind}：{prompt} {media_tag} [V2FIX]"
    else:
        text_summary = f"已生成{kind}：{prompt}（文件位于 {path}，未能复制到网关缓存）"

    return {
        "_multimodal": True,
        "content": content,
        "text_summary": text_summary,
    }


# ---------------------------------------------------------------------------
# 多 Agent 委派（尽力而为）
# ---------------------------------------------------------------------------
def _dispatch_delegate(kind: str, prompt: str, args: dict) -> str:
    if _CTX is None:
        raise RuntimeError("插件上下文未初始化")
    extra = ""
    if kind == "image" and args.get("aspect_ratio"):
        extra = f"  aspect_ratio={args['aspect_ratio']!r}"
    if kind == "video" and args.get("duration"):
        extra = f"  duration={args['duration']!r}"
    goal = (
        f"Generate a {kind} from this prompt: {prompt!r}. "
        f"Call the tool `decuria_media_generate` exactly once with arguments "
        f"kind={kind!r}, prompt={prompt!r}{extra}. "
        f"Do NOT call decuria_image_generate or decuria_video_generate. "
        f"After the tool returns the local file path, report that path to the caller."
    )
    context = (
        "You are a media-generation specialist subagent (ephemeral). "
        "You have the `decuria_media_generate` tool available. Call it exactly once "
        "with the user's prompt and kind, then return the saved file path."
    )
    return _CTX.dispatch_tool("delegate_task", {"goal": goal, "context": context})


# ---------------------------------------------------------------------------
# 工具 handlers
# ---------------------------------------------------------------------------
def _handle_generate(kind: str, args: dict, **kw):
    if kind not in {"image", "video"}:
        return tool_error("kind 必须是 image 或 video")
    prompt = (args.get("prompt") or "").strip()
    if not prompt:
        return tool_error("缺少参数 prompt（图片/视频描述）")
    if len(prompt) > 10_000:
        return tool_error("prompt 超过 10000 字符限制")
    if kind == "video" and args.get("duration") is not None:
        try:
            duration = int(args["duration"])
        except (TypeError, ValueError):
            return tool_error("duration 必须是整数")
        if duration < 1 or duration > 30:
            return tool_error("duration 必须在 1 到 30 秒之间")
        args = dict(args, duration=duration)
    if kind == "image" and args.get("aspect_ratio"):
        import re
        ratio = str(args["aspect_ratio"]).strip()
        match = re.fullmatch(r"(\d{2,4})x(\d{2,4})", ratio)
        if not match or max(map(int, match.groups())) > 4096:
            return tool_error("aspect_ratio 必须是最大 4096x4096 的 WIDTHxHEIGHT")
        args = dict(args, aspect_ratio=ratio)

    # 已在子智能体内（子智能体误调用了公开工具）→ 直接当叶子执行，避免无限递归
    if getattr(_thread_local, "in_subagent", False):
        path, err = _generate(kind, prompt, args.get("aspect_ratio"), args.get("duration"))
        if err:
            return tool_error(err)
        return _to_multimodal(path, kind, prompt)

    # 尝试原生多 Agent 委派
    _thread_local.in_subagent = True
    try:
        _dispatch_delegate(kind, prompt, args)
        lg = getattr(_thread_local, "last_generated", None)
        if lg and lg[1] == kind and os.path.exists(lg[0]):
            return _to_multimodal(lg[0], kind, prompt)
    except Exception:
        logger.debug("delegate failed, falling back to local generation", exc_info=True)
    finally:
        _thread_local.in_subagent = False

    # 回退：直接本地生成（保证核心路由可用）
    path, err = _generate(kind, prompt, args.get("aspect_ratio"), args.get("duration"))
    if err:
        return tool_error(err)
    return _to_multimodal(path, kind, prompt)


def _handle_image_generate(args: dict, **kw):
    return _handle_generate("image", args, **kw)


def _handle_video_generate(args: dict, **kw):
    """decuria_video_generate 公开工具处理器：固定 kind=video。"""
    return _handle_generate("video", args, **kw)


def _handle_media_generate(args: dict, **kw):
    """decuria_media_generate 工具处理器：从 args.kind 决定 image/video。"""
    kind = (args.get("kind") or "image")
    return _handle_generate(kind, args, **kw)


def _media_tool_available(args=None) -> bool:
    """decuria_media_generate 可用性检查：image 或 video 候补模型任一已配置即可用。"""
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
        if not isinstance(cfg, dict):
            return False
        fb = (cfg.get("model") or {}).get("fallback") or {}
        entry = fb.get("image") or fb.get("video")
        return bool(isinstance(entry, dict) and entry.get("provider") and entry.get("model"))
    except Exception:
        return False





# ---------------------------------------------------------------------------
# 工具 schema
# ---------------------------------------------------------------------------
IMAGE_SCHEMA = {
    "name": "decuria_image_generate",
    "description": (
        "生成一张图片并返回给用户。当当前模型自身不能直接出图（如 DeepSeek 等纯文本模型）时，"
        "调用本工具：它会把任务委派给运行在已配置图片模型（config.model.fallback.image）上的"
        "专门子智能体完成生成，结果以图片形式返回。参数 prompt 为图片文字描述。"
        "若当前模型本身支持原生出图，请优先让其原生生成。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "图片描述（英文或中文均可）"},
            "aspect_ratio": {"type": "string", "description": "可选，宽高比如 1024x1024 / 512x512"},
        },
        "required": ["prompt"],
    },
}


VIDEO_SCHEMA = {
    "name": "decuria_video_generate",
    "description": (
        "生成一段视频并返回给用户。当用户要求生成/制作视频，而当前模型自身不能直接出视频时，"
        "调用本工具：它会把任务委派给运行在已配置视频模型（config.model.fallback.video）上的"
        "专门子智能体完成生成，结果以视频形式返回。参数 prompt 为视频文字描述，"
        "duration 为视频时长（秒，可选）。若当前模型本身支持原生出视频，请优先让其原生生成。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "视频描述（英文或中文均可）"},
            "duration": {"type": "integer", "description": "可选，视频时长秒数，如 4 / 6 / 8"},
        },
        "required": ["prompt"],
    },
}


def _fallback_tool_available(kind: str) -> bool:
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
        if not isinstance(cfg, dict):
            return False
        entry = (((cfg.get("model") or {}).get("fallback") or {}).get(kind))
        return bool(isinstance(entry, dict) and entry.get("provider") and entry.get("model"))
    except Exception:
        return False


def _image_tool_available(args=None) -> bool:
    return _fallback_tool_available("image")


def _video_tool_available(args=None) -> bool:
    return _fallback_tool_available("video")


MEDIA_SCHEMA = {
    "name": "decuria_media_generate",
    "description": "内部媒体生成工具，由委派子智能体调用，主智能体不应直接调用。",
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["image", "video"]},
            "prompt": {"type": "string", "description": "媒体描述"},
            "aspect_ratio": {"type": "string", "description": "图片宽高比（可选）"},
            "duration": {"type": "integer", "description": "视频时长秒（可选）"},
        },
        "required": ["kind", "prompt"],
    },
}


def register_tools(ctx) -> None:
    """由插件 __init__.register(ctx) 调用，注册三个工具。"""
    global _CTX
    _CTX = ctx
    ctx.register_tool(
        name="decuria_image_generate", toolset="decuria", schema=IMAGE_SCHEMA,
        handler=_handle_image_generate, check_fn=_image_tool_available, emoji="🖼️",
    )
    ctx.register_tool(
        name="decuria_video_generate", toolset="decuria", schema=VIDEO_SCHEMA,
        handler=_handle_video_generate, check_fn=_video_tool_available, emoji="🎬",
    )
    ctx.register_tool(
        name="decuria_media_generate", toolset="decuria", schema=MEDIA_SCHEMA,
        handler=_handle_media_generate, check_fn=_media_tool_available, emoji="⚙️",
    )
