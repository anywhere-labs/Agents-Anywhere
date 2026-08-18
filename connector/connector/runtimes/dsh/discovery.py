from __future__ import annotations

import json
import os
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
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return DshDiscovery(
            False,
            False,
            None,
            reason=f"Start DSH Desktop with the Agents Anywhere plugin ({exc})",
        )
    if not _process_exists(endpoint.pid):
        return DshDiscovery(
            False,
            False,
            None,
            reason="The DSH Desktop bridge endpoint is stale; restart DSH Desktop",
        )
    return DshDiscovery(
        True,
        True,
        endpoint,
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
