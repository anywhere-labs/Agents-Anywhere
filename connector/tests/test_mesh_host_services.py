from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from connector.mesh.host import mount_host_services
from connector.runtimes.dsh import provider_config
from connector.runtimes.dsh.bridge import host as bridge_host_module
from connector.runtimes.dsh.bridge.host import BridgeHost, SyncService, host_for


class RecordingHub:
    """Mounts like ``LocalHub``: services are registered first, then served."""

    def __init__(self, *, serving: bool = False) -> None:
        self.serving = serving
        self.instance_id = "test-instance"
        self.mounts: list[tuple[object, ...]] = []
        self.services: list[object] = []
        # "register": registering fails; "serve": registered, but serving fails.
        self.fail: str | None = None
        self.on_mount: Callable[[], None] | None = None

    async def mount(self, *services: object) -> None:
        if self.on_mount is not None:
            self.on_mount()
        self.mounts.append(services)
        if self.fail == "register":
            raise RuntimeError("router unavailable")
        self.services.extend(services)
        if self.fail == "serve":
            self.serving = False
            raise RuntimeError("serving failed")
        self.serving = True

    def has_service(self, service: object) -> bool:
        return any(mounted is service for mounted in self.services)

    def on_stop(self, _cleanup: Callable[[], Awaitable[None]]) -> None:
        pass

    def descriptor(self, _role: str) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "pid": 1,
            "endpoint": {"pipe": "test-pipe"},
            "key": "test-key",
        }


@pytest.fixture
def rendezvous(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    path = tmp_path / "connector.json"
    monkeypatch.setattr(provider_config, "endpoint_path", lambda: path)
    monkeypatch.setattr(bridge_host_module, "_hosts", {})
    return path


def test_dsh_sync_is_mounted_with_control_and_logs_in_one_go(rendezvous: Path) -> None:
    hub = RecordingHub()
    # The plugin must not find the rendezvous before the services are served.
    hub.on_mount = lambda: assert_absent(rendezvous)

    asyncio.run(mount_host_services(hub, "control", "logs"))  # type: ignore[arg-type]

    assert len(hub.mounts) == 1
    sync, *rest = hub.mounts[0]
    assert isinstance(sync, SyncService)
    assert rest == ["control", "logs"]
    assert rendezvous.exists()


def test_enabling_dsh_later_reuses_the_mounted_bridge(rendezvous: Path) -> None:
    hub = RecordingHub()

    async def scenario() -> None:
        await mount_host_services(hub, "control")  # type: ignore[arg-type]
        rendezvous.unlink()
        # What a probe or the DSH runtime does once the user turns DSH on.
        await host_for(hub).start()  # type: ignore[arg-type]

    asyncio.run(scenario())
    assert len(hub.mounts) == 1, "turning DSH on must not restart serving"
    assert rendezvous.exists()


def test_a_mount_whose_serving_failed_still_counts_the_bridge_as_mounted(rendezvous: Path) -> None:
    # The hub's supervisor serves registered services once the Router recovers;
    # DSH must use them then instead of refusing to start for good.
    hub = RecordingHub()
    hub.fail = "serve"

    async def scenario() -> None:
        with pytest.raises(RuntimeError, match="serving failed"):
            await mount_host_services(hub, "control")  # type: ignore[arg-type]
        hub.fail = None
        hub.serving = True
        await host_for(hub).start()  # type: ignore[arg-type]

    asyncio.run(scenario())
    assert len(hub.mounts) == 1
    assert rendezvous.exists()


def test_a_mount_that_registered_nothing_lets_dsh_mount_later(rendezvous: Path) -> None:
    hub = RecordingHub()
    hub.fail = "register"

    async def scenario() -> None:
        with pytest.raises(RuntimeError, match="router unavailable"):
            await mount_host_services(hub, "logs")  # type: ignore[arg-type]
        assert not hub.serving
        hub.fail = None
        await host_for(hub).start()  # type: ignore[arg-type]

    asyncio.run(scenario())
    assert len(hub.mounts) == 2
    assert isinstance(hub.mounts[1][0], SyncService)
    assert rendezvous.exists()


def test_bridge_host_refuses_to_mount_after_serving_starts(rendezvous: Path) -> None:
    hub = RecordingHub(serving=True)
    host = BridgeHost(hub)  # type: ignore[arg-type]

    with pytest.raises(RuntimeError, match="before the local router starts serving"):
        asyncio.run(host.start())

    assert hub.mounts == []
    assert not rendezvous.exists()


def test_bridge_host_does_not_mount_twice(rendezvous: Path) -> None:
    hub = RecordingHub()
    host = BridgeHost(hub)  # type: ignore[arg-type]

    async def scenario() -> None:
        await host.start()
        await host.start()

    asyncio.run(scenario())
    assert len(hub.mounts) == 1


def assert_absent(path: Path) -> None:
    assert not path.exists()
