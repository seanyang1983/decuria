# Decuria (三个臭皮匠) — a Mixture-of-Agents dashboard plugin for Hermes Agent.
# Copyright (C) 2026 Decuria Team
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""Decuria · 智囊团渠道触发（插件自包含，不修改 Hermes 原始文件）。

pre_gateway_dispatch hook：当微信 / 飞书等「渠道」消息命中
「智囊团 / MoA / 专家团」等关键词时，调用插件自有核心层
(moa_core.run_moa) 执行多模型协作，并把聚合答案通过网关
adapter 发回对应渠道。完全复用 moa_core，与面板内的「智囊团对话」
走同一套按组合方案持久化的逻辑。

设计约束（来自用户）：
  - 不能改 Hermes 原始文件 → 全部逻辑在插件内（moa_core + 本文件）。
  - 面板内触发（前端调用 /moa/run API）与渠道触发共用 moa_core，
    按组合方案(preset) 持久化到插件私有目录 data/moa_chats/。
  - 本地聊天也支持关键词触发（改写为 /moa 斜杠命令交给原生处理器）。
  - API 服务 / Webhook / Relay 等自动化入口不拦截。
"""

import asyncio
import logging
import re
import sys
import threading
import time
from pathlib import Path

logger = logging.getLogger("decuria.moa_trigger")

# 确保插件目录在 sys.path，便于 import moa_core
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

# 触发关键词（不区分大小写，按长度倒序匹配，避免"智囊团"被"智囊"先匹配）
# P0-3 修复：原实现按定义顺序匹配，"智囊"会先于"智囊团"命中 → 剥掉"智囊"留下"团"
TRIGGER_KEYWORDS = (
    "mixture of agents",  # 最长优先
    "专家圆桌",
    "混合智能",
    "智囊团",
    "专家团",
    "智囊",
    "moa",
)

# 最小 prompt 长度（剥离关键词后）
# P0-3 修复：避免"我听说 MoA 比较好用"这种没问题的消息触发 MoA 流程
MIN_PROMPT_LENGTH = 4

# 需要拦截的「渠道」平台（取值来自 gateway/config.py::Platform.value）
CHANNEL_PLATFORMS = {
    "weixin", "feishu", "wecom", "telegram", "discord", "whatsapp",
    "whatsapp_cloud", "slack", "signal", "mattermost", "matrix",
    "dingtalk", "qqbot", "yuanbao", "bluebubbles",
}
# 明确不拦截（API 服务 / Webhook / Relay / MS Graph 等自动化入口）
_NON_CHANNEL = {"api_server", "webhook", "relay", "msgraph_webhook"}

# 可选预设提示： 智囊团[方案B] 问题  /  方案B 智囊团 问题
_PRESET_HINT = re.compile(r"\[([^\]]+)\]|方案\s*([^\s，。？?！!：:]+)")

_CHANNEL_RUN_LOCK = threading.Lock()
_CHANNEL_ACTIVE = set()
_CHANNEL_MAX_CONCURRENT = 2


# ---------------------------------------------------------------------------
# 配置探测（只读，不修改）
# ---------------------------------------------------------------------------
_cfg_cache = {"ok": None, "ts": 0.0, "ttl": 30.0}


def _moa_configured():
    """检查 config.yaml 是否已配置可用的 moa preset（至少一个 enabled 且有 aggregator）。"""
    now = time.time()
    if _cfg_cache["ok"] is not None and (now - _cfg_cache["ts"]) < _cfg_cache["ttl"]:
        return _cfg_cache["ok"]
    try:
        from hermes_cli.config import load_config
        from hermes_cli.moa_config import normalize_moa_config

        cfg = load_config()
        moa = cfg.get("moa") if isinstance(cfg, dict) else None
        if not moa:
            _cfg_cache.update(ok=False, ts=now)
            return False
        norm = normalize_moa_config(moa)
        presets = norm.get("presets") or {}
        for p in presets.values():
            agg = (p.get("aggregator") or {}) if isinstance(p, dict) else {}
            if p.get("enabled", True) and agg.get("provider"):
                _cfg_cache.update(ok=True, ts=now)
                return True
        _cfg_cache.update(ok=False, ts=now)
        return False
    except Exception as exc:  # 探测失败则不放行，避免把普通消息误改成 MoA
        logger.warning("moa_trigger: config probe failed: %s", exc)
        _cfg_cache.update(ok=False, ts=now)
        return False


def _resolve_preset(hint):
    """把预设提示解析为 config.yaml::moa 中的 preset id；无法匹配则回退 active。"""
    if not hint:
        return None
    try:
        from moa_core import load_moa_config

        cfg = load_moa_config()
        presets = cfg.get("presets") or {}
        for key in presets:
            if key.lower() == hint.lower():
                return key
        for key, p in presets.items():
            name = (p.get("name") or "") if isinstance(p, dict) else ""
            if name and name.lower() == hint.lower():
                return key
    except Exception as exc:
        logger.warning("moa_trigger: preset resolve failed: %s", exc)
    return None


def _parse(text):
    """从触发消息中剥离关键词与预设提示，返回 (prompt, preset_hint)。

    P0-3 修复：使用正则表达式词边界匹配，避免子串误匹配。
    - 英文关键词用 \\b 词边界
    - 中文关键词用前后标点/空格/句首句尾作为边界
    """
    body = text

    # 按长度倒序匹配（已在 TRIGGER_KEYWORDS 中排序），长的优先
    for kw in TRIGGER_KEYWORDS:
        # 判断是中文还是英文关键词
        if all(ord(c) < 128 for c in kw):
            # 英文关键词：用 \b 词边界
            pattern = r'\b' + re.escape(kw) + r'\b'
        else:
            # 中文关键词：用前后标点/空格/句首句尾作为边界
            # 匹配：句首 + 关键词 + 标点后，或 标点前 + 关键词 + 标点后
            pattern = r'(?:^|[\s，。！？；：、])' + re.escape(kw) + r'(?=[\s，。！？；：、]|$)'

        # 不区分大小写匹配
        match = re.search(pattern, body, re.IGNORECASE)
        if match:
            # 剥离关键词
            body = body[:match.start()] + body[match.end():]

    body = body.strip(" ：:，。、-\t\n")
    prompt = body.strip()

    # P0-3 修复：检查最小 prompt 长度
    if len(prompt) < MIN_PROMPT_LENGTH:
        return "", None

    hint = None
    m = _PRESET_HINT.search(prompt)
    if m:
        hint = (m.group(1) or m.group(2) or "").strip()
        prompt = (prompt[:m.start()] + prompt[m.end():]).strip()
    return prompt, hint


# ---------------------------------------------------------------------------
# 异步回复（在网关事件循环里调度执行）
# ---------------------------------------------------------------------------
async def _moa_and_reply(gateway, source, preset_id, prompt):
    try:
        from moa_core import run_moa, load_moa_config

        # 圆桌私有状态是辩证设置的唯一真相源。显式关闭不能再回退到
        # config.yaml preset，否则 Dashboard 显示单轮、通讯端却仍会多轮。
        _dr = 1
        _debate = False
        _auto_stop = True
        _has_state_debate = False
        try:
            from state_paths import state_file
            import json as _json
            _ofile = state_file("orchestrator_state.json")
            _ostate = _json.loads(_ofile.read_text(encoding="utf-8")) if _ofile.exists() else {}
            if isinstance(_ostate, dict):
                if "debate_enabled" in _ostate:
                    _debate = bool(_ostate["debate_enabled"])
                    _has_state_debate = True
                elif "debate_rounds" in _ostate:
                    # 兼容 0.2.0 及更早状态：1=关闭，2..5=开启。
                    _debate = int(_ostate.get("debate_rounds") or 1) > 1
                    _has_state_debate = True
                if _has_state_debate:
                    _dr = max(1, min(5, int(_ostate.get("debate_rounds") or 1)))
                    if not _debate:
                        _dr = 1
                    elif _dr <= 1:
                        _dr = 2
                    _auto_stop = bool(
                        _ostate.get("debate_auto_stop", _ostate.get("auto_stop", True))
                    )
        except Exception:
            logger.debug("failed to read debate settings from orchestrator_state.json", exc_info=True)
        if not _has_state_debate:
            try:
                _cfg = load_moa_config()
                _presets = _cfg.get("presets") or {}
                _pid = preset_id or _cfg.get("active_preset") or _cfg.get("default_preset") or "default"
                if _pid in _presets:
                    _dr = max(1, min(5, int(_presets[_pid].get("debate_rounds") or 2)))
                _debate = _dr > 1
            except Exception:
                logger.debug("failed to read debate_rounds from moa config preset", exc_info=True)
                _dr = 2
                _debate = True

        loop = asyncio.get_running_loop()
        # run_moa 内部用 urllib 同步阻塞调用网关，放到线程池避免卡住事件循环
        # 提取渠道标识（用于聊天记录的 source 字段）
        _src_label = None
        try:
            _platform_val = getattr(getattr(source, 'platform', None), 'value', None) if getattr(source, 'platform', None) else None
            if _platform_val and _platform_val != "local":
                # 友好中文名映射
                _NAME_MAP = {
                    "weixin": "微信", "feishu": "飞书",
                    "telegram": "Telegram", "discord": "Discord",
                    "wecom": "企业微信", "dingtalk": "钉钉",
                    "qqbot": "QQ机器人", "slack": "Slack",
                    "signal": "Signal", "whatsapp": "WhatsApp",
                    "whatsapp_cloud": "WhatsApp Cloud",
                    "mattermost": "Mattermost", "matrix": "Matrix",
                    "yuanbao": "元宝", "bluebubbles": "iMessage",
                }
                _src_label = _NAME_MAP.get(_platform_val, _platform_val)
        except Exception:
            logger.debug("failed to extract platform label from source", exc_info=True)

        record = await loop.run_in_executor(
            None,
            lambda: run_moa(
                preset_id,
                prompt,
                debate=_debate,
                debate_rounds=_dr,
                auto_stop=_auto_stop,
                source=_src_label,
            ),
        )
        answer = (record or {}).get("final_answer") or "（智囊团未能生成回答）"
        adapter = gateway._adapter_for_source(source)
        if adapter is not None:
            await adapter.send(source.chat_id, answer)
        else:
            logger.warning("decuria moa: 无可用 adapter for %s", getattr(source.platform, "value", "?"))
    except Exception:
        logger.warning("decuria moa channel execution failed", exc_info=True)
        try:
            adapter = gateway._adapter_for_source(source)
            if adapter is not None:
                await adapter.send(source.chat_id, "（智囊团暂时无法回答，请稍后重试。）")
        except Exception:
            logger.debug("failed to send fallback error message to channel", exc_info=True)


async def _moa_and_reply_guarded(gateway, source, run_key, preset_id, prompt):
    try:
        await _moa_and_reply(gateway, source, preset_id, prompt)
    finally:
        with _CHANNEL_RUN_LOCK:
            _CHANNEL_ACTIVE.discard(run_key)


async def _send_busy(gateway, source):
    try:
        adapter = gateway._adapter_for_source(source)
        if adapter is not None:
            await adapter.send(source.chat_id, "（智囊团正在处理其他请求，请稍后重试。）")
    except Exception:
        logger.debug("failed to send busy message to channel", exc_info=True)


async def _send_hint(gateway, source):
    try:
        adapter = gateway._adapter_for_source(source)
        if adapter is not None:
            await adapter.send(
                source.chat_id,
                "智囊团已就绪～直接把问题发给我即可，例如：「智囊团 用一句话介绍五行」。"
                "需要指定组合方案时写：智囊团[方案名] 你的问题。",
            )
    except Exception:
        logger.debug("failed to send usage hint to channel", exc_info=True)


# ---------------------------------------------------------------------------
# hook 入口
# ---------------------------------------------------------------------------
def on_pre_gateway_dispatch(event, gateway, session_store, **kwargs):
    """pre_gateway_dispatch 回调。

    渠道平台（微信/飞书等）：命中关键词时拦截，异步执行 MoA 并通过 adapter 回送。
    本地聊天（local）：命中关键词时改写 event.text 为「/moa <prompt>」，
      交由原生 /moa 斜杠命令处理器执行（复用现有面板 MoA 基础设施）。
    其余情况返回 None 走原生流程。
    """
    text = getattr(event, "text", "") or ""
    if not text.strip():
        return None
    # 已经是斜杠命令则放行，交给命令解析器
    if text.lstrip().startswith("/"):
        return None

    src = getattr(event, "source", None)
    if src is None:
        return None
    platform = getattr(src, "platform", None)
    platform_val = getattr(platform, "value", None) if platform else None
    is_local = platform_val == "local"

    if platform_val in _NON_CHANNEL:
        return None
    # 本地允许通过；渠道必须在 CHANNEL_PLATFORMS 列表中
    if (not is_local) and (platform_val not in CHANNEL_PLATFORMS):
        # 未知平台默认不拦截，避免误伤
        return None

    # P0-3 修复：使用正则词边界匹配，避免子串误命中
    matched = False
    for kw in TRIGGER_KEYWORDS:
        if all(ord(c) < 128 for c in kw):
            # 英文关键词：用 \b 词边界
            pattern = r'\b' + re.escape(kw) + r'\b'
        else:
            # 中文关键词：用前后标点/空格/句首句尾作为边界
            pattern = r'(?:^|[\s，。！？；：、])' + re.escape(kw) + r'(?=[\s，。！？；：、]|$)'
        if re.search(pattern, text, re.IGNORECASE):
            matched = True
            break
    if not matched:
        return None

    # Messaging traffic must pass the host's real allowlist/pairing check.
    if not is_local:
        auth_fn = getattr(gateway, "_is_user_authorized", None)
        if not callable(auth_fn):
            logger.warning("decuria moa: gateway authorization hook unavailable")
            return None
        try:
            if not auth_fn(src):
                return None
        except Exception:
            logger.warning("decuria moa: gateway authorization check failed", exc_info=True)
            return None
    if not _moa_configured():
        return None

    prompt, hint = _parse(text)
    if not prompt:
        if is_local:
            # 本地无具体问题 → 改写为 /moa 显示用法
            setattr(event, "text", "/moa")
            return None
        # 渠道：只有触发词没有具体问题 → 回一句用法提示
        try:
            asyncio.get_running_loop().create_task(_send_hint(gateway, src))
        except Exception:
            logger.debug("failed to schedule usage hint task", exc_info=True)
        return {"action": "skip", "reason": "decuria-moa-usage"}

    # ---- 本地路径：改写为 /moa 斜杠命令，交给原生处理器 ----
    if is_local:
        import shlex
        cmd = "/moa"
        if hint:
            # P0-4 修复：使用 shlex.quote 转义 hint，防止注入
            cmd += f" --preset {shlex.quote(hint)}"
        # P0-4 修复：使用 shlex.quote 转义 prompt，防止注入
        cmd += f" {shlex.quote(prompt)}"
        setattr(event, "text", cmd)
        return None

    # ---- 渠道路径：异步执行 MoA + adapter 回送（原有逻辑）----

    preset_id = _resolve_preset(hint)
    run_key = (
        platform_val,
        str(getattr(src, "user_id", "") or ""),
        str(getattr(src, "chat_id", "") or ""),
    )
    try:
        loop = asyncio.get_running_loop()
        with _CHANNEL_RUN_LOCK:
            if run_key in _CHANNEL_ACTIVE or len(_CHANNEL_ACTIVE) >= _CHANNEL_MAX_CONCURRENT:
                loop.create_task(_send_busy(gateway, src))
                return {"action": "skip", "reason": "decuria-moa-busy"}
            _CHANNEL_ACTIVE.add(run_key)
        try:
            loop.create_task(_moa_and_reply_guarded(gateway, src, run_key, preset_id, prompt))
        except Exception:
            with _CHANNEL_RUN_LOCK:
                _CHANNEL_ACTIVE.discard(run_key)
            raise
        return {"action": "skip", "reason": "decuria-moa"}
    except Exception as exc:
        logger.warning("decuria moa: 无法调度异步回复，回退正常分发: %s", exc)
        return None
