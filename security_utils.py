"""Outbound URL and bounded-response helpers for Decuria."""
from __future__ import annotations

import base64
import ipaddress
import socket
import ssl
import urllib.request
from typing import Iterable
from urllib.parse import urlsplit

MAX_JSON_BYTES = 40 * 1024 * 1024
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_VIDEO_BYTES = 250 * 1024 * 1024


class UnsafeURLError(ValueError):
    pass


def secret_preview(raw: str) -> str:
    """Return a constant-shape, non-reversible secret identifier."""
    value = str(raw or "").strip()
    if not value:
        return ""
    return "••••" + (value[-2:] if len(value) >= 8 else "")


def _normalise_allowed(hosts: Iterable[str]) -> set[str]:
    return {str(host).strip().lower().rstrip(".") for host in hosts if host}


def validate_outbound_url(url: str, allow_private_hosts: Iterable[str] = ()) -> str:
    """Validate HTTP(S) URL and block metadata/special networks.

    Private/loopback targets are allowed only when their exact hostname was
    explicitly supplied by the caller (for intentionally local providers).
    """
    raw = str(url or "").strip()
    if not raw or len(raw) > 2048:
        raise UnsafeURLError("URL 为空或过长")
    parsed = urlsplit(raw)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise UnsafeURLError("仅允许 http/https URL")
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise UnsafeURLError("URL 主机无效，且不得包含用户名或密码")
    host = parsed.hostname.lower().rstrip(".")
    allowed = _normalise_allowed(allow_private_hosts)
    try:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeURLError("URL 主机无法解析") from exc
    if not addresses:
        raise UnsafeURLError("URL 主机无法解析")
    for entry in addresses:
        ip = ipaddress.ip_address(entry[4][0].split("%", 1)[0])
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            raise UnsafeURLError("URL 指向禁止的特殊网络地址")
        if (ip.is_private or ip.is_loopback) and host not in allowed:
            raise UnsafeURLError("URL 指向未授权的私有网络地址")
    return raw


def validate_provider_base_url(url: str) -> str:
    parsed = urlsplit(str(url or "").strip())
    host = parsed.hostname or ""
    clean = validate_outbound_url(url, allow_private_hosts=(host,))
    if parsed.query or parsed.fragment:
        raise UnsafeURLError("Provider base_url 不得包含 query 或 fragment")
    return clean.rstrip("/")


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    return parsed.scheme.lower(), (parsed.hostname or "").lower().rstrip("."), parsed.port or default_port


class _ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    max_repeats = 2
    max_redirections = 5

    def __init__(self, allow_private_hosts: Iterable[str]):
        super().__init__()
        self._allow_private_hosts = tuple(allow_private_hosts)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_outbound_url(newurl, self._allow_private_hosts)
        sensitive = {"authorization", "proxy-authorization", "cookie"}
        request_headers = {name.lower() for name, _ in req.header_items()}
        if sensitive & request_headers and _origin(req.full_url) != _origin(newurl):
            raise UnsafeURLError("认证请求不得重定向到其他来源")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_url(request, timeout: int, allow_private_hosts: Iterable[str] = ()):
    validate_outbound_url(request.full_url, allow_private_hosts)
    opener = urllib.request.build_opener(
        _ValidatingRedirectHandler(allow_private_hosts),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    return opener.open(request, timeout=timeout)


def read_limited(response, max_bytes: int) -> bytes:
    length = response.headers.get("Content-Length")
    if length:
        try:
            if int(length) > max_bytes:
                raise ValueError("响应体超过允许大小")
        except ValueError as exc:
            if "超过" in str(exc):
                raise
    chunks = []
    total = 0
    while True:
        chunk = response.read(min(64 * 1024, max_bytes + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ValueError("响应体超过允许大小")
        chunks.append(chunk)
    return b"".join(chunks)


def decode_base64_payload(value: str, max_bytes: int) -> bytes:
    """Decode either a data URI or a raw base64 provider payload."""
    raw = str(value or "").strip()
    if raw.startswith("data:"):
        if "," not in raw:
            raise ValueError("无效 data URI")
        header, encoded = raw.split(",", 1)
        if ";base64" not in header.lower():
            raise ValueError("仅支持 base64 data URI")
    else:
        encoded = raw
    if not encoded or len(encoded) > ((max_bytes + 2) // 3) * 4 + 8:
        raise ValueError("内联媒体超过允许大小")
    data = base64.b64decode(encoded, validate=True)
    if len(data) > max_bytes:
        raise ValueError("内联媒体超过允许大小")
    return data


def decode_data_uri(value: str, max_bytes: int) -> bytes:
    if not str(value).startswith("data:"):
        raise ValueError("无效 data URI")
    return decode_base64_payload(value, max_bytes)
