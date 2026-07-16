from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from connector.acp.adapter import AcpAdapter
from connector.acp.manifest import AgentManifest, load_builtin_manifests
from connector.adapter import Adapter
from connector.claude.history_adapter import ClaudeHistoryAdapter
from connector.claude.sdk_adapter import ClaudeSdkAdapter
from connector.codex.adapter import CodexAdapter
from connector.sync_state import SyncStateStore


NotificationSink = Callable[[str, dict[str, Any]], Awaitable[None]] | None
AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]


def build_default_adapters(
    *,
    notification_sink: NotificationSink = None,
    sync_state_store: SyncStateStore | None = None,
    attachment_downloader: AttachmentDownloader | None = None,
    acp_manifests: list[AgentManifest] | None = None,
) -> dict[str, Adapter]:
    """Assemble native + ACP adapters for BackendRpcClient."""
    adapters: dict[str, Adapter] = {
        "codex": CodexAdapter(
            notification_sink=notification_sink,
            sync_state_store=sync_state_store,
            attachment_downloader=attachment_downloader,
        ),
        "claude": ClaudeSdkAdapter(
            notification_sink=notification_sink,
            history_adapter=ClaudeHistoryAdapter(sync_state_store=sync_state_store),
            attachment_downloader=attachment_downloader,
        ),
    }
    for manifest in acp_manifests if acp_manifests is not None else load_builtin_manifests():
        adapters[manifest.id] = AcpAdapter(
            manifest=manifest,
            notification_sink=notification_sink,
            attachment_downloader=attachment_downloader,
        )
    return adapters


def builtin_acp_runtime_ids() -> list[str]:
    return [manifest.id for manifest in load_builtin_manifests()]
