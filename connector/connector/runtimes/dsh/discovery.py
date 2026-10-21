from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtimes.dsh import provider_config


@dataclass(frozen=True, slots=True)
class DshDiscovery:
    available: bool
    configured: bool
    bridge_version: str | None = None
    reason: str | None = None
    metadata: dict[str, Any] | None = None


def _static_metadata(values: dict[str, Any]) -> dict[str, Any]:
    return {
        "endpoint": str(provider_config.endpoint_path()),
        "storageMode": "dsh-native",
        "sameSessionWriterLimit": 1,
        "crossProcessWriterExclusion": False,
    }


async def discover(values: dict[str, Any]) -> DshDiscovery:
    """Report that this connector supports the DSH runtime type.

    The device list only answers "which runtime types does this connector
    support", so discovery must not touch the DSH bridge. Whether a bridge is
    actually reachable is a configuration/start concern and belongs to
    probe(); ``configured`` is only meaningful there.
    """
    return DshDiscovery(True, True, reason=None, metadata=_static_metadata(values))


async def probe(values: dict[str, Any]) -> DshDiscovery:
    """Ask the plugin registered on this process's Router. Configuration/start only.

    Probing publishes the rendezvous, so a plugin that is running finds this
    Connector; until it has registered the Bridge, the probe reports offline.
    """
    from connector.runtimes.dsh.bridge.client import BridgeClient, BridgeRpcError
    from connector.runtimes.dsh.bridge.host import bridge_host

    try:
        client = BridgeClient(await bridge_host(), connector_id="discovery", startup_timeout=2, request_timeout=2)
    except (OSError, RuntimeError) as exc:
        return DshDiscovery(False, False, reason=f"无法启动本机 Router：{exc}")
    try:
        result = await client.start()
        await client.request("ping")
        extra: dict[str, Any] = {}
        for method, key in (("getRuntimeCapabilities", "runtimeCapabilities"), ("listAgentPresets", "agentPresetCatalog")):
            try:
                extra[key] = await client.request(method)
            except BridgeRpcError:
                # Read-only plugins remain discoverable; they cannot advertise these controls.
                pass
    except (OSError, RuntimeError, ValueError):
        return DshDiscovery(False, False, reason="请启动 DSH，并启用手机连接插件。")
    finally:
        await client.close()
    return DshDiscovery(
        True,
        True,
        bridge_version=result["identity"].get("bridgeVersion"),
        metadata={**extra, **_static_metadata(values)},
    )
