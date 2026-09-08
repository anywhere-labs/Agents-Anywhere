from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.runtimes.dsh import provider_config


@dataclass(frozen=True, slots=True)
class BridgeEndpoint:
    host: str
    port: int
    token: str
    pid: int
    path: Path


@dataclass(frozen=True, slots=True)
class DshDiscovery:
    available: bool
    configured: bool
    endpoint: BridgeEndpoint | None
    bridge_version: str | None = None
    reason: str | None = None
    metadata: dict[str, Any] | None = None


async def discover(values: dict[str, Any]) -> DshDiscovery:
    try:
        endpoint = load_endpoint(values)
    except (OSError, ValueError, json.JSONDecodeError):
        return DshDiscovery(
            False,
            False,
            None,
            reason="请启动 DSH，并启用手机连接插件。",
        )
    if not _process_exists(endpoint.pid):
        return DshDiscovery(
            False,
            False,
            None,
            reason="DSH 插件发现记录已失效，请重新启动 DSH。",
        )
    # A live PID is insufficient: authenticate a short-lived connection to the actual port.
    # Import here because BridgeClient's endpoint DTO belongs to this module.
    from connector.runtimes.dsh.bridge.client import BridgeClient

    async def ignore_notification(method: str, params: Mapping[str, Any]) -> None:
        pass

    async def ignore_exit(code: int | None) -> None:
        pass

    client = BridgeClient(
        endpoint=endpoint,
        connector_id="discovery",
        client_version="1.0",
        startup_timeout=2,
        request_timeout=2,
        notification_handler=ignore_notification,
        exit_handler=ignore_exit,
    )
    try:
        result = await client.start()
        await client.request("ping")
    except (OSError, RuntimeError, ValueError):
        return DshDiscovery(
            False, False, None, reason="无法连接 DSH 插件，请确认插件已启动。"
        )
    finally:
        await client.close()
    return DshDiscovery(
        True,
        True,
        endpoint,
        bridge_version=result["identity"].get("bridgeVersion"),
        metadata={
            "endpoint": str(endpoint.path),
            "storageMode": "dsh-native",
            "sameSessionWriterLimit": 1,
            "crossProcessWriterExclusion": False,
        },
    )


def load_endpoint(values: dict[str, Any]) -> BridgeEndpoint:
    path = provider_config.endpoint_path(values)
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ValueError("bridge endpoint has an unsupported version")
    host = raw.get("host")
    port = raw.get("port")
    token = raw.get("token")
    pid = raw.get("pid")
    if host != "127.0.0.1":
        raise ValueError("bridge endpoint is not loopback-only")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65_535:
        raise ValueError("bridge endpoint port is invalid")
    if not isinstance(token, str) or not token:
        raise ValueError("bridge endpoint token is missing")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError("bridge endpoint process is invalid")
    return BridgeEndpoint(host=host, port=port, token=token, pid=pid, path=path)


def _process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
