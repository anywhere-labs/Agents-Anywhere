from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from ..domain.definitions import AcpError
from ..domain.installations import release_identity

# Packaging supplies reviewed release keys and the official feed when the
# complete Agent is published. Runtime configuration cannot add trust roots.
TRUSTED_RELEASE_KEYS: dict[str, bytes] = {}
OFFICIAL_RELEASE_INDEX: str | None = None


def require_official_url(url: str):
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
    ):
        raise AcpError("untrusted_release_url", "组件下载必须使用官方 HTTPS 地址。")
    if parsed.hostname == "github.com":
        if not parsed.path.startswith("/anywhere-labs/Agents-Anywhere/releases/"):
            raise AcpError("untrusted_release_url", "组件下载不属于 AA 官方发布源。")
    elif parsed.hostname not in {
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    }:
        raise AcpError("untrusted_release_url", "组件下载不属于受信发布域名。")


class ReleaseFeed:
    def __init__(self, artifacts, url: str | None = OFFICIAL_RELEASE_INDEX):
        self.artifacts, self.url = artifacts, url

    def _read(self, url: str, *, destination: Path | None = None) -> bytes:
        limit = 512 * 1024 * 1024 if destination else 4 * 1024 * 1024
        with httpx.Client(timeout=30, follow_redirects=False) as client:
            for _ in range(6):
                require_official_url(url)
                with client.stream("GET", url) as response:
                    if response.is_redirect:
                        url = urljoin(url, response.headers["location"])
                        continue
                    response.raise_for_status()
                    size = 0
                    if destination:
                        with destination.open("xb") as output:
                            for block in response.iter_bytes(65536):
                                size += len(block)
                                if size > limit:
                                    raise AcpError(
                                        "component_too_large", "组件下载超过大小上限。"
                                    )
                                output.write(block)
                        return b""
                    blocks = []
                    for block in response.iter_bytes(65536):
                        size += len(block)
                        if size > limit:
                            raise AcpError(
                                "release_index_too_large", "组件目录超过大小上限。"
                            )
                        blocks.append(block)
                    return b"".join(blocks)
        raise AcpError("release_redirect_limit", "组件下载重定向次数超过上限。")

    def list(self) -> list[dict]:
        if not self.url:
            raise AcpError("release_feed_pending", "完整组件尚未发布，更新源暂未启用。")
        envelope = json.loads(self._read(self.url))
        index = envelope["index"]
        self.artifacts.verify_signature(index, envelope["signature"])
        if (
            index.get("schemaVersion") != "1.0"
            or not isinstance(index.get("releases"), list)
            or len(index["releases"]) > 128
        ):
            raise AcpError("invalid_release_index", "组件发布目录无效。")
        for entry in index["releases"]:
            self.artifacts.verify_signature(entry["manifest"], entry["signature"])
            if entry["releaseId"] != release_identity(entry["manifest"]):
                raise AcpError(
                    "component_identity_conflict", "组件目录与发行身份不一致。"
                )
            require_official_url(entry["archiveUrl"])
        return index["releases"]

    def download(self, release_id: str, destination: Path) -> dict:
        entry = next(
            (item for item in self.list() if item["releaseId"] == release_id), None
        )
        if not entry:
            raise AcpError("release_not_found", "组件发行未在官方目录中找到。")
        self._read(entry["archiveUrl"], destination=destination)
        with destination.open("rb") as source:
            if (
                hashlib.file_digest(source, "sha256").hexdigest()
                != entry["archiveSha256"]
            ):
                raise AcpError("component_checksum_invalid", "组件压缩包校验失败。")
        return entry
