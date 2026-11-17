"""Outbox processing: a summary that resending cannot fix is acknowledged and skipped; a storage
failure is raised, so the pump closes without acknowledging and the device resends
(``contracts/device-meshcall/1.0``: a handler failure closes the pump)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from device_link_helpers import summary
from sqlalchemy.exc import OperationalError

from agent_server.core.device_meshcall import LINK_ROUTES, LinkAttachItem, OutboxItem
from agent_server.core.runtime_identity import SessionRuntimeBindingError
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.projects import MissingWorkspaceError
from agent_server.services.device_link import DeviceLinkService

DEVICE = "conn_o1"


class _Store:
    def __init__(self, error: BaseException) -> None:
        self.error = error
        self.applied: list[str] = []

    async def upsert_connector_session(self, **values: Any) -> Any:
        raise self.error

    async def apply_device_session_summary(self, session_id: str, *_args: Any, **_kwargs: Any) -> bool:
        self.applied.append(session_id)
        return False


def _service(store: _Store, hub: Any) -> DeviceLinkService:
    return DeviceLinkService(store, None, hub, RedisCoordinator(), None)  # type: ignore[arg-type]


def _item(oid: int = 1) -> OutboxItem:
    return OutboxItem(oid=oid, m="session.summary", p=summary("sess_o1", 3))


@pytest.mark.parametrize(
    "error",
    [
        KeyError(DEVICE),
        MissingWorkspaceError("session workdir is required"),
        ValueError("session connector binding is immutable"),
        SessionRuntimeBindingError("runtime mismatch"),
    ],
)
def test_summary_that_resending_cannot_fix_is_skipped(error: Exception) -> None:
    store = _Store(error)
    service = _service(store, SimpleNamespace())
    asyncio.run(service.handle_outbox(DEVICE, _item()))
    assert store.applied == []


@pytest.mark.parametrize(
    "error",
    [
        OperationalError("INSERT INTO sessions", {}, ConnectionResetError("server closed the connection")),
        ConnectionError("database unavailable"),
        TimeoutError(),
        RuntimeError("pool closed"),
    ],
)
def test_storage_failure_propagates(error: Exception) -> None:
    service = _service(_Store(error), SimpleNamespace())
    with pytest.raises(type(error)):
        asyncio.run(service.handle_outbox(DEVICE, _item()))


def test_inventory_storage_failure_propagates() -> None:
    service = _service(_Store(ConnectionError("database unavailable")), SimpleNamespace())
    inventory = {"scanId": "scan_1", "runtimeId": "codex", "complete": True, "sessions": [summary("sess_o1", 3)["summary"]]}
    item = OutboxItem(oid=1, m="session.inventory", p=inventory)
    with pytest.raises(ConnectionError):
        asyncio.run(service.handle_outbox(DEVICE, item))


class _Mesh:
    """attach: one heartbeat, then open; outbox: one summary, then open. Records acknowledgements."""

    def __init__(self) -> None:
        self.acked: list[int] = []

    def stream(self, device_id, route, request, item_type, *, connection_id, timeout=None):
        if route == LINK_ROUTES["link.attach"]:
            return self._attach()
        return self._outbox()

    async def _attach(self):
        yield LinkAttachItem(kind="heartbeat")
        await asyncio.Event().wait()

    async def _outbox(self):
        yield _item(7)
        await asyncio.Event().wait()

    async def unary(self, device_id, route, request, response_type, **_kwargs):
        self.acked.append(request.oid)
        return response_type()


def test_storage_failure_closes_the_pump_without_acknowledging() -> None:
    async def scenario() -> None:
        mesh = _Mesh()
        hub = DeviceLinkHub(mesh, RedisCoordinator(), worker_id="w_a")  # type: ignore[arg-type]
        _service(_Store(ConnectionError("database unavailable")), hub)
        hub.on_presence = None
        await hub.hold(DEVICE, "lc_1")
        for _ in range(100):
            if not hub.held_devices():
                break
            await asyncio.sleep(0.01)
        assert hub.held_devices() == []
        assert mesh.acked == []
        await hub.close()

    asyncio.run(scenario())
