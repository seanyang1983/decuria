"""Decuria plugin registration.

Runtime state and configuration changes are handled explicitly by the plugin
APIs; importing or registering the plugin never rewrites user configuration.
"""
from __future__ import annotations

import logging

__version__ = "0.2.0"
__author__ = "Decuria Team"

logger = logging.getLogger("decuria")


def register(ctx) -> None:
    """Register gateway hooks and service-gated media tools."""
    try:
        from . import moa_trigger

        ctx.register_hook("pre_gateway_dispatch", moa_trigger.on_pre_gateway_dispatch)
    except Exception as exc:  # pragma: no cover - host integration boundary
        logger.warning("注册 pre_gateway_dispatch hook 失败: %s", exc)

    try:
        from . import media_tools

        media_tools.register_tools(ctx)
    except Exception as exc:  # pragma: no cover - host integration boundary
        logger.warning("注册 media_tools 失败: %s", exc)


__all__ = ["register"]
