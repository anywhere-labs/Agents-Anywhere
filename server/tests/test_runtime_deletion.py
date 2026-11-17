from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from conftest import ApiV2TestClient as TestClient
from sqlalchemy import insert, select, update
from test_runtime_instances_lifecycle import (
    FakeDevice,
    _applied,
    _auth_headers,
    _discover_types,
    _v2_discovery,
)

from agent_server.app import create_app
from agent_server.core.models import SessionRuntimeState
from agent_server.core.utc import utc_now
from agent_server.infra.db import schema as db
from agent_server.services.device_commands import (
    DeviceCommandOffline,
    DeviceCommandOutcomeUnknown,
    DeviceCommandRejected,
)


@pytest.fixture
def api(tmp_path, monkeypatch):
    app = create_app()
    rpc = FakeDevice(_v2_discovery())
    # Keep the production service and its cleanup dependencies wired by create_app.
    for method in ("is_online", "is_connection_id_current"):
        monkeypatch.setattr(app.state.rpc, method, getattr(rpc, method))
    monkeypatch.setattr(app.state.device_runtime_service, "device_commands", rpc)
    client = TestClient(app)
    try:
        headers = _auth_headers(client)
        device = create_device(client, headers, "Device")
        runtime = create_runtime(client, headers, device, "Work")
        yield client, rpc, headers, device, runtime
    finally:
        client.close()
        asyncio.run(app.state.store.close())


def create_device(client, headers, name):
    response = client.post("/connectors", headers=headers, json={"name": name})
    assert response.status_code == 200, response.text
    device = response.json()["connector"]["id"]
    asyncio.run(client.app.state.store.set_connector_link_contract(device, "device-meshcall/1.0"))
    _discover_types(client, device, headers, _v2_discovery())
    return device


def create_runtime(client, headers, device, name):
    response = client.post(
        f"/connectors/{device}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": name,
            "config": {"home": f"/runtime/{name}"},
            "active": False,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["runtimeId"]


async def add_session(app, device, runtime, name):
    store = app.state.store
    session = await store.upsert_connector_session(
        connector_id=device,
        session_id=f"sess_{name}",
        runtime="codex",
        runtime_id=runtime,
        external_session_id=name,
        title=name,
        cwd="/work/shared",
    )
    now = utc_now()
    owner = (await store.get_connector(device)).userId
    async with store.engine.begin() as conn:
        await conn.execute(
            insert(db.session_active_runs).values(
                session_id=session.id,
                runtime="codex",
                runtime_id=runtime,
                status="running",
                started_at=now,
                updated_at=now,
            )
        )
        await conn.execute(
            insert(db.session_shares).values(
                id=session.id,
                session_id=session.id,
                user_id=owner,
                scope="session",
                snapshot_json="{}",
                created_at=now,
            )
        )
    await store.save_user_uploaded_file(
        session_id=session.id, user_id=owner, name="private.txt", data=b"attachment"
    )
    await app.state.session_runtime_state_cache.put(
        SessionRuntimeState(
            sessionId=session.id,
            runtime="codex",
            updatedSeq=1,
            createdAt=now,
            updatedAt=now,
        )
    )
    return session


async def assert_session_data(app, expected_ids):
    store = app.state.store
    async with store.engine.connect() as conn:
        assert (
            set((await conn.execute(select(db.sessions.c.id))).scalars())
            == expected_ids
        )
        for table in (db.session_active_runs, db.session_shares):
            assert (
                set((await conn.execute(select(table.c.session_id))).scalars())
                == expected_ids
            ), table.name
    for session_id in expected_ids:
        assert (store.files.root / session_id).exists()
        assert await app.state.session_runtime_state_cache.get(session_id) is not None


def test_runtime_deletion_removes_only_its_sessions_and_related_data(api):
    client, rpc, headers, device, runtime = api
    other_runtime = create_runtime(client, headers, device, "Other")
    other_device = create_device(client, headers, "Other device")
    other_device_runtime = create_runtime(client, headers, other_device, "Work")
    runtime_url = f"/connectors/{device}/runtimes/{runtime}"
    activated = client.put(
        f"{runtime_url}/active", headers=headers, json={"active": True}
    )
    assert activated.status_code == 200, activated.text

    async def prepare():
        # Runtime IDs are scoped to a device: the same ID elsewhere must survive.
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                update(db.device_runtimes)
                .where(
                    db.device_runtimes.c.connector_id == other_device,
                    db.device_runtimes.c.runtime_id == other_device_runtime,
                )
                .values(runtime_id=runtime)
            )
        deleted = [
            await add_session(client.app, device, runtime, name)
            for name in ("active", "archived", "hidden")
        ]
        kept = [
            await add_session(client.app, device, other_runtime, "other_instance"),
            await add_session(client.app, other_device, runtime, "other_device"),
        ]
        store = client.app.state.store
        await store.set_session_archived(deleted[1].id, True)
        async with store.engine.begin() as conn:
            await conn.execute(
                update(db.sessions)
                .where(db.sessions.c.id == deleted[2].id)
                .values(project_id=None, source_state="deleted")
            )
        return deleted, kept

    deleted, kept = asyncio.run(prepare())
    rpc.requests.clear()
    response = client.delete(f"{runtime_url}/config", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["configured"] is False
    assert _applied(rpc) == [("runtime.apply", False)]
    assert rpc.requests[0][2]["runtimeId"] == runtime
    for session in deleted:
        assert (
            client.get(f"/sessions/{session.id}/meta", headers=headers).status_code
            == 404
        )
        assert client.get(f"/public/shares/{session.id}").status_code == 404
    assert response.json()["runtimeId"] == runtime
    assert client.get(f"{runtime_url}", headers=headers).status_code == 404
    listed = client.get(f"/connectors/{device}/runtimes", headers=headers).json()["runtimes"]
    assert runtime not in {item["runtimeId"] for item in listed}
    assert (
        client.get(
            f"/connectors/{device}/runtimes/{other_runtime}", headers=headers
        ).json()["configured"]
        is True
    )

    async def check():
        await assert_session_data(client.app, {session.id for session in kept})
        store = client.app.state.store
        async with store.engine.connect() as conn:
            assert set((await conn.execute(select(db.projects.c.id))).scalars()) == {
                session.projectId for session in kept
            }
        for session in deleted:
            assert not (store.files.root / session.id).exists()
            assert (
                await client.app.state.session_runtime_state_cache.get(session.id)
                is None
            )

    asyncio.run(check())
    # A stale retry must not delete the successor, even after it is configured.
    assert client.delete(f"{runtime_url}/config", headers=headers).status_code == 404
    asyncio.run(assert_session_data(client.app, {session.id for session in kept}))


@pytest.mark.parametrize("failure", ["stop_failed", "outcome_unknown"])
def test_running_runtime_deletion_preserves_sessions_when_it_cannot_stop(
    api, monkeypatch, failure
):
    client, rpc, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "protected"))
    runtime_url = f"/connectors/{device}/runtimes/{runtime}"
    activated = client.put(
        f"{runtime_url}/active", headers=headers, json={"active": True}
    )
    assert activated.status_code == 200, activated.text
    error = (
        DeviceCommandRejected("stop_failed", "runtime is still running", None)
        if failure == "stop_failed"
        else DeviceCommandOutcomeUnknown(None)
    )
    monkeypatch.setattr(rpc, "send", AsyncMock(side_effect=error))
    response = client.delete(f"{runtime_url}/config", headers=headers)
    assert response.status_code == (502 if failure == "stop_failed" else 504), response.text
    assert client.get(runtime_url, headers=headers).json()["configured"] is True
    asyncio.run(assert_session_data(client.app, {session.id}))
    # A failed stop leaves active=False with an error or unknown status. Retrying must
    # still stop the possibly running instance before it can delete any session data.
    retried = client.delete(f"{runtime_url}/config", headers=headers)
    assert retried.status_code == response.status_code, retried.text
    asyncio.run(assert_session_data(client.app, {session.id}))


def test_running_runtime_deletion_while_offline_waits_in_desired_state(api):
    client, rpc, headers, device, runtime = api
    asyncio.run(add_session(client.app, device, runtime, "offline_running"))
    url = f"/connectors/{device}/runtimes/{runtime}"
    assert client.put(f"{url}/active", headers=headers, json={"active": True}).status_code == 200
    rpc.online = False
    rpc.send = AsyncMock(side_effect=DeviceCommandOffline())

    # The device drops the instance when it links again, so its sessions go now.
    response = client.delete(f"{url}/config", headers=headers)
    assert response.status_code == 200, response.text
    assert client.get(url, headers=headers).status_code == 404
    asyncio.run(assert_session_data(client.app, set()))


def test_stopping_runtime_keeps_sessions(api):
    client, _, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "stopped"))
    active_url = f"/connectors/{device}/runtimes/{runtime}/active"
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": False}).status_code
        == 200
    )
    asyncio.run(assert_session_data(client.app, {session.id}))


def test_stopped_runtime_can_be_deleted_while_connector_is_offline(api):
    client, rpc, headers, device, runtime = api
    asyncio.run(add_session(client.app, device, runtime, "offline"))
    rpc.online = False
    response = client.delete(
        f"/connectors/{device}/runtimes/{runtime}/config", headers=headers
    )
    assert response.status_code == 200, response.text
    asyncio.run(assert_session_data(client.app, set()))


def test_only_manual_delete_retires_identity_and_stale_retries_cannot_touch_new_instance(api):
    client, rpc, headers, device, runtime = api
    url = f"/connectors/{device}/runtimes/{runtime}"
    for active in (True, False, True, False):
        result = client.put(f"{url}/active", headers=headers, json={"active": active})
        assert result.status_code == 200, result.text
        assert result.json()["runtimeId"] == runtime
    # Reconfiguration and an offline period both keep the configured identity.
    config = client.get(url, headers=headers).json()["config"]
    result = client.put(f"{url}/config", headers=headers, json={"config": config})
    assert result.status_code == 200, result.text
    assert result.json()["runtimeId"] == runtime
    rpc.online = False
    assert client.get(url, headers=headers).json()["runtimeId"] == runtime
    rpc.online = True
    removed = client.delete(f"{url}/config", headers=headers)
    assert removed.status_code == 200, removed.text
    assert removed.json()["runtimeId"] == runtime
    assert client.get(url, headers=headers).status_code == 404
    replacement = create_runtime(client, headers, device, "Work")
    assert replacement != runtime
    replacement_url = f"/connectors/{device}/runtimes/{replacement}"
    assert client.delete(f"{url}/config", headers=headers).status_code == 404
    assert client.put(f"{url}/config", headers=headers, json={"config": config}).status_code == 404
    assert client.get(replacement_url, headers=headers).json()["configured"] is True
    denied = asyncio.run(client.app.state.store.get_unconfigured_runtime_ids(device))
    assert runtime in denied and replacement not in denied


def test_failed_runtime_attachment_cleanup_rolls_back_and_can_retry(api, monkeypatch):
    client, _, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "retry"))
    runtime_url = f"/connectors/{device}/runtimes/{runtime}"
    with monkeypatch.context() as patch:
        patch.setattr(
            client.app.state.store.files,
            "delete_session",
            AsyncMock(side_effect=OSError("storage unavailable")),
        )
        with pytest.raises(OSError, match="storage unavailable"):
            client.delete(f"{runtime_url}/config", headers=headers)
    assert client.get(runtime_url, headers=headers).json()["configured"] is True
    asyncio.run(assert_session_data(client.app, {session.id}))
    assert client.delete(f"{runtime_url}/config", headers=headers).status_code == 200
    asyncio.run(assert_session_data(client.app, set()))


def test_unowned_or_missing_runtime_deletion_preserves_sessions(api):
    client, _, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "owned"))
    client.patch(
        "/admin/settings", headers=headers, json={"registrationOpen": True}
    ).raise_for_status()
    registered = client.post(
        "/auth/register",
        json={
            "email": "other@example.com",
            "displayName": "Other",
            "password": "secret",
        },
    )
    assert registered.status_code == 200, registered.text
    other_headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
    url = f"/connectors/{device}/runtimes/{runtime}/config"
    assert client.delete(url).status_code == 401
    assert client.delete(url, headers=other_headers).status_code == 404
    assert (
        client.delete(
            f"/connectors/{device}/runtimes/missing/config", headers=headers
        ).status_code
        == 404
    )
    assert (
        client.get(url.removesuffix("/config"), headers=headers).json()["configured"]
        is True
    )
    asyncio.run(assert_session_data(client.app, {session.id}))
