"""Native archive propagation: helper unit tests and API entry-point tests.

The helper is deliberately best-effort, so these tests pin down both what it
forwards (``session.archive`` params, per-call timeout, concurrency bound) and
what it must never do (raise into the archive APIs, call an offline Connector).
The API tests exercise the four archive entry points against the shared
PostgreSQL test database and a fake ``ConnectorRpcManager``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest
from conftest import ApiV2TestClient as TestClient
from conftest import make_test_client
from test_backend_mvp import create_connector_and_session

from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.services.native_archive import (
    NATIVE_ARCHIVE_MAX_CONCURRENCY,
    NATIVE_ARCHIVE_RPC_METHOD,
    NATIVE_ARCHIVE_RPC_TIMEOUT_SECONDS,
    backfill_connector_native_archive,
    sync_native_session_archive,
)


@dataclass
class FakeSession:
    id: str
    connectorId: str | None = "conn_1"
    runtime: str | None = "codex"
    runtimeId: str | None = "codex"
    externalSessionId: str | None = "external_1"
    archived: bool = False


@dataclass
class FakeRpc:
    """Minimal duck-typed ``ConnectorRpcManager`` for the sync helper."""

    online: bool = True
    online_error: Exception | None = None
    fail_connectors: set[str] = field(default_factory=set)
    delay: float = 0.0
    calls: list[tuple[str, str, dict[str, Any], float]] = field(default_factory=list)
    active: int = 0
    max_active: int = 0

    async def is_online(self, connector_id: str) -> bool:
        if self.online_error is not None:
            raise self.online_error
        return self.online

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        self.calls.append((connector_id, method, params, timeout))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.delay > 0:
                await asyncio.sleep(self.delay)
            if connector_id in self.fail_connectors:
                raise ConnectorRpcError("connector_error", "archive failed")
            return {"sessionId": params["sessionId"]}
        finally:
            self.active -= 1


def sync(rpc: FakeRpc, sessions: list[FakeSession], archived: bool) -> None:
    asyncio.run(sync_native_session_archive(rpc, sessions, archived))


def test_helper_forwards_native_archive_params() -> None:
    rpc = FakeRpc()
    sessions = [
        FakeSession(
            "sess_codex",
            connectorId="conn_1",
            runtime="codex",
            runtimeId="rti_codex_1",
            externalSessionId="thr_1",
        ),
        FakeSession(
            "sess_claude",
            connectorId="conn_2",
            runtime="claude",
            runtimeId=None,
            externalSessionId="claude_2",
        ),
    ]

    sync(rpc, sessions, archived=True)

    assert len(rpc.calls) == 2
    by_session = {call[2]["sessionId"]: call for call in rpc.calls}
    connector_id, method, params, timeout = by_session["sess_codex"]
    assert connector_id == "conn_1"
    assert method == NATIVE_ARCHIVE_RPC_METHOD == "session.archive"
    assert params == {
        "runtime": "codex",
        "runtimeId": "rti_codex_1",
        "sessionId": "sess_codex",
        "externalSessionId": "thr_1",
        "archived": True,
    }
    assert timeout == NATIVE_ARCHIVE_RPC_TIMEOUT_SECONDS == 10
    # A missing runtime instance id falls back to the runtime type (legacy id).
    assert by_session["sess_claude"][2] == {
        "runtime": "claude",
        "runtimeId": "claude",
        "sessionId": "sess_claude",
        "externalSessionId": "claude_2",
        "archived": True,
    }


def test_helper_forwards_unarchive_state() -> None:
    rpc = FakeRpc()

    sync(rpc, [FakeSession("sess_1")], archived=False)

    assert len(rpc.calls) == 1
    assert rpc.calls[0][2]["archived"] is False


def test_helper_skips_offline_connector() -> None:
    rpc = FakeRpc(online=False)

    sync(rpc, [FakeSession("sess_1"), FakeSession("sess_2")], archived=True)

    assert rpc.calls == []


def test_helper_skips_sessions_without_connector_or_native_id() -> None:
    rpc = FakeRpc()
    sessions = [
        FakeSession("no_connector", connectorId=None),
        FakeSession("empty_connector", connectorId=""),
        FakeSession("no_native_id", externalSessionId=None),
        FakeSession("empty_native_id", externalSessionId=""),
        FakeSession("no_runtime", runtime=None),
        FakeSession("valid"),
    ]

    sync(rpc, sessions, archived=True)

    assert [call[2]["sessionId"] for call in rpc.calls] == ["valid"]


def test_helper_skips_when_connector_has_no_native_session() -> None:
    rpc = FakeRpc()
    session = FakeSession("sess_1", externalSessionId=None)

    sync(rpc, [session], archived=True)

    assert rpc.calls == []


def test_helper_swallows_rpc_failures_and_still_syncs_other_sessions() -> None:
    rpc = FakeRpc(fail_connectors={"conn_failing"})
    sessions = [
        FakeSession("failing", connectorId="conn_failing"),
        FakeSession("healthy", connectorId="conn_healthy"),
    ]

    sync(rpc, sessions, archived=True)

    assert {call[2]["sessionId"] for call in rpc.calls} == {"failing", "healthy"}


def test_helper_swallows_presence_failures() -> None:
    rpc = FakeRpc(online_error=ConnectorRpcError("presence_error", "presence down"))

    sync(rpc, [FakeSession("sess_1")], archived=True)

    assert rpc.calls == []


def test_helper_bounds_concurrency() -> None:
    rpc = FakeRpc(delay=0.01)
    sessions = [FakeSession(f"sess_{index}") for index in range(20)]

    sync(rpc, sessions, archived=True)

    assert len(rpc.calls) == 20
    assert rpc.max_active <= NATIVE_ARCHIVE_MAX_CONCURRENCY
    assert rpc.max_active > 1


def test_helper_accepts_empty_session_list() -> None:
    rpc = FakeRpc()

    sync(rpc, [], archived=True)

    assert rpc.calls == []


@dataclass
class NativeArchiveDevice:
    client: TestClient
    headers: dict[str, str]
    connector_id: str
    project_id: str
    session_id: str
    external_session_id: str

    def create_session(self, suffix: str) -> str:
        response = self.client.post(
            "/sessions",
            headers=self.headers,
            json={
                "connectorId": self.connector_id,
                "projectId": self.project_id,
                "runtime": "codex",
                "externalSessionId": f"thr_{self.connector_id}_{suffix}",
                "title": suffix,
                "cwd": "/repo",
            },
        )
        assert response.status_code == 200, response.text
        return response.json()["session"]["id"]

    def install_rpc(self, rpc: FakeRpc) -> FakeRpc:
        self.client.app.state.rpc = rpc
        return rpc

    def archive_calls(self, rpc: FakeRpc) -> list[dict[str, Any]]:
        return [
            params
            for _connector_id, method, params, _timeout in rpc.calls
            if method == NATIVE_ARCHIVE_RPC_METHOD
        ]


def _create_device(runtime: str = "codex") -> NativeArchiveDevice:
    client = make_test_client()
    connector_id, _access_token, session_id, headers = create_connector_and_session(
        client, runtime=runtime
    )
    meta = client.get(f"/sessions/{session_id}/meta", headers=headers)
    assert meta.status_code == 200, meta.text
    session = meta.json()["session"]
    project_id = session["projectId"]
    assert project_id is not None, meta.text
    return NativeArchiveDevice(
        client=client,
        headers=headers,
        connector_id=connector_id,
        project_id=project_id,
        session_id=session_id,
        external_session_id=session["externalSessionId"],
    )


def _close_device(device: NativeArchiveDevice) -> None:
    try:
        device.client.close()
    finally:
        asyncio.run(device.client.app.state.store.close())


@pytest.fixture
def device():
    created: list[NativeArchiveDevice] = []

    def create(runtime: str = "codex") -> NativeArchiveDevice:
        created_device = _create_device(runtime)
        created.append(created_device)
        return created_device

    yield create
    for created_device in created:
        _close_device(created_device)


def test_archive_endpoint_forwards_session_archive_rpc(device) -> None:
    native = device()
    rpc = native.install_rpc(FakeRpc())

    response = native.client.post(
        "/sessions/archive",
        headers=native.headers,
        json=[native.session_id],
    )

    assert response.status_code == 200, response.text
    assert response.json()["sessions"][0]["archived"] is True
    assert len(rpc.calls) == 1
    connector_id, method, params, timeout = rpc.calls[0]
    assert connector_id == native.connector_id
    assert method == "session.archive"
    assert params == {
        "runtime": "codex",
        "runtimeId": "codex",
        "sessionId": native.session_id,
        "externalSessionId": native.external_session_id,
        "archived": True,
    }
    assert timeout == 10


def test_unarchive_endpoint_forwards_session_archive_rpc(device) -> None:
    native = device()
    archived = native.client.post(
        "/sessions/archive",
        headers=native.headers,
        json=[native.session_id],
    )
    assert archived.status_code == 200, archived.text
    rpc = native.install_rpc(FakeRpc())

    response = native.client.post(
        "/sessions/unarchive",
        headers=native.headers,
        json=[native.session_id],
    )

    assert response.status_code == 200, response.text
    assert response.json()["sessions"][0]["archived"] is False
    assert native.archive_calls(rpc) == [
        {
            "runtime": "codex",
            "runtimeId": "codex",
            "sessionId": native.session_id,
            "externalSessionId": native.external_session_id,
            "archived": False,
        }
    ]


def test_archive_endpoint_ignores_native_archive_rpc_failure(device) -> None:
    native = device()
    native.install_rpc(FakeRpc(fail_connectors={native.connector_id}))

    response = native.client.post(
        "/sessions/archive",
        headers=native.headers,
        json=[native.session_id],
    )

    assert response.status_code == 200, response.text
    assert response.json()["sessions"][0]["archived"] is True


def test_archive_endpoint_does_not_call_rpc_when_nothing_was_updated(device) -> None:
    native = device()
    rpc = native.install_rpc(FakeRpc())

    response = native.client.post(
        "/sessions/archive",
        headers=native.headers,
        json=["missing-session"],
    )

    assert response.status_code == 200, response.text
    assert response.json()["notFound"] == ["missing-session"]
    assert rpc.calls == []


def test_patch_meta_forwards_only_archive_changes(device) -> None:
    native = device()
    rpc = native.install_rpc(FakeRpc())

    renamed = native.client.patch(
        f"/sessions/{native.session_id}/meta",
        headers=native.headers,
        json={"title": "Renamed"},
    )
    assert renamed.status_code == 200, renamed.text
    assert rpc.calls == []

    archived = native.client.patch(
        f"/sessions/{native.session_id}/meta",
        headers=native.headers,
        json={"archived": True},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["session"]["archived"] is True
    assert native.archive_calls(rpc) == [
        {
            "runtime": "codex",
            "runtimeId": "codex",
            "sessionId": native.session_id,
            "externalSessionId": native.external_session_id,
            "archived": True,
        }
    ]


def test_project_archive_all_forwards_every_session(device) -> None:
    native = device()
    second_session_id = native.create_session("second")
    rpc = native.install_rpc(FakeRpc())

    response = native.client.post(
        f"/projects/{native.project_id}/sessions/archive-all",
        headers=native.headers,
        json={"archived": True, "scope": "active"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["affected"] == 2
    calls = native.archive_calls(rpc)
    assert {params["sessionId"] for params in calls} == {
        native.session_id,
        second_session_id,
    }
    assert all(params["archived"] is True for params in calls)


def test_connector_archive_all_forwards_every_session(device) -> None:
    native = device()
    second_session_id = native.create_session("second")
    rpc = native.install_rpc(FakeRpc())

    response = native.client.post(
        f"/connectors/{native.connector_id}/sessions/archive-all",
        headers=native.headers,
        json={"archived": True, "scope": "active"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["affected"] == 2
    calls = native.archive_calls(rpc)
    assert {params["sessionId"] for params in calls} == {
        native.session_id,
        second_session_id,
    }
    assert all(params["archived"] is True for params in calls)


@dataclass
class FakeStore:
    """Minimal duck-typed ``Store`` for the archive backfill."""

    sessions: list[FakeSession] = field(default_factory=list)
    error: Exception | None = None

    async def list_sessions_for_connector(
        self,
        connector_id: str,
    ) -> list[FakeSession]:
        if self.error is not None:
            raise self.error
        return self.sessions


def test_backfill_forwards_only_archived_sessions() -> None:
    store = FakeStore(
        [
            FakeSession("sess_a", runtime="codex", externalSessionId="thr_a", archived=True),
            FakeSession("sess_b", runtime="dsh", externalSessionId="native_b", archived=True),
            FakeSession("sess_c", runtime="claude", externalSessionId="claude_c"),
        ]
    )
    rpc = FakeRpc()

    count = asyncio.run(
        backfill_connector_native_archive(store, rpc, "conn_1", seen=set())
    )

    assert count == 2
    assert [call[2]["sessionId"] for call in rpc.calls] == ["sess_a", "sess_b"]
    assert all(call[2]["archived"] is True for call in rpc.calls)
    assert all(
        call[1] == NATIVE_ARCHIVE_RPC_METHOD
        and call[3] == NATIVE_ARCHIVE_RPC_TIMEOUT_SECONDS
        for call in rpc.calls
    )


def test_backfill_runs_once_per_connector() -> None:
    store = FakeStore([FakeSession("sess_a", archived=True)])
    rpc = FakeRpc()
    seen: set[str] = set()

    first = asyncio.run(backfill_connector_native_archive(store, rpc, "conn_1", seen=seen))
    second = asyncio.run(backfill_connector_native_archive(store, rpc, "conn_1", seen=seen))

    assert (first, second) == (1, 0)
    assert len(rpc.calls) == 1


def test_backfill_survives_store_failure() -> None:
    rpc = FakeRpc()

    count = asyncio.run(
        backfill_connector_native_archive(
            FakeStore(error=RuntimeError("database unavailable")),
            rpc,
            "conn_1",
            seen=set(),
        )
    )

    assert count == 0
    assert rpc.calls == []


def test_backfill_skips_sessions_without_native_id() -> None:
    store = FakeStore([FakeSession("sess_a", externalSessionId=None, archived=True)])
    rpc = FakeRpc()

    count = asyncio.run(
        backfill_connector_native_archive(store, rpc, "conn_1", seen=set())
    )

    assert count == 1
    assert rpc.calls == []


def test_backfill_skips_offline_connector() -> None:
    store = FakeStore([FakeSession("sess_a", archived=True)])
    rpc = FakeRpc(online=False)

    count = asyncio.run(
        backfill_connector_native_archive(store, rpc, "conn_1", seen=set())
    )

    assert count == 1
    assert rpc.calls == []
