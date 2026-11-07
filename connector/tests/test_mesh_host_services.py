from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from connector.mesh.host import mount_host_services
from connector.runtimes.dsh import provider_config
from connector.runtimes.dsh.bridge import host as bridge_host_module
from connector.runtimes.dsh.bridge.host import BridgeHost


class RecordingHub:
    def __init__(self, *, serving: bool = False) -> None:
        self.serving = serving
        self.instance_id = "test-instance"
        self.mounts: list[tuple[object, ...]] = []

    async def mount(self, *services: object) -> None:
        self.mounts.append(services)
        self.serving = True

    def descriptor(self, _role: str) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "pid": 1,
            "endpoint": {"pipe": "test-pipe"},
            "key": "test-key",
        }


def test_mount_host_services_mounts_dsh_before_control(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = RecordingHub()
    events: list[str] = []

    class FakeDshHost:
        def publish(self) -> None:
            events.append("publish")

    async def fake_bridge_host(*, publish: bool = True) -> FakeDshHost:
        events.append(f"bridge_host:{publish}")
        await hub.mount("dsh-sync")
        return FakeDshHost()

    monkeypatch.setattr(bridge_host_module, "bridge_host", fake_bridge_host)

    asyncio.run(mount_host_services(hub, "control", "logs"))

    assert events == ["bridge_host:False", "publish"]
    assert [tuple(type(service).__name__ for service in mount) for mount in hub.mounts] == [
        ("str",),
        ("str", "str"),
    ]


def test_bridge_host_refuses_to_mount_after_serving_starts() -> None:
    hub = RecordingHub(serving=True)
    host = BridgeHost(hub)  # type: ignore[arg-type]

    with pytest.raises(RuntimeError, match="before the local router starts serving"):
        asyncio.run(host.start())

    assert hub.mounts == []


def test_bridge_host_does_not_mount_twice() -> None:
    hub = RecordingHub()
    host = BridgeHost(hub)  # type: ignore[arg-type]

    asyncio.run(host.start(publish=False))
    mounts = list(hub.mounts)

    asyncio.run(host.start(publish=False))

    assert hub.mounts == mounts


def test_bridge_host_publish_false_defers_rendezvous(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    hub = RecordingHub()
    rendezvous = tmp_path / "connector.json"
    monkeypatch.setattr(provider_config, "endpoint_path", lambda: rendezvous)
    host = BridgeHost(hub)  # type: ignore[arg-type]

    asyncio.run(host.start(publish=False))

    assert hub.mounts
    assert not rendezvous.exists()

    host.publish()

    assert rendezvous.exists()
