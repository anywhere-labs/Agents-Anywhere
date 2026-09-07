from __future__ import annotations

import asyncio

import pytest
from conftest import ApiV2TestClient as TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from agent_server.app import create_app
from agent_server.infra.db import connectors, projects, sessions


@pytest.fixture
def api(tmp_path):
    with TestClient(create_app(tmp_path / "connector-deletion.sqlite3")) as client:
        client.get("/auth/config")
        registered = client.post(
            "/auth/register",
            json={
                "email": "owner@example.com",
                "displayName": "Owner",
                "password": "secret",
                "setupToken": client.app.state.setup_token.peek(),
            },
        )
        assert registered.status_code == 200, registered.text
        headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
        yield client, headers


def create_device(client, headers, name="Device"):
    response = client.post("/connectors", headers=headers, json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()["connector"]["id"]


def create_project(client, headers, device, name, *, manual=True):
    response = client.post(
        "/projects",
        headers=headers,
        json={
            "connectorId": device,
            "name": name,
            "workspacePath": f"/work/{name}",
            "manuallyCreated": manual,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def add_session(client, device, project, name, *, archived=False):
    async def create():
        store = client.app.state.store
        session = await store.create_session(
            connector_id=device,
            project_id=project,
            runtime="codex",
            external_session_id=name,
            title=name,
            cwd=None,
        )
        if archived:
            await store.set_session_archived(session.id, True)
        return session.id

    return asyncio.run(create())


def test_device_deletion_removes_all_projects_and_preserves_other_devices(api):
    client, headers = api
    device = create_device(client, headers)
    other = create_device(client, headers, "Other device")
    empty = create_project(client, headers, device, "Empty")
    active = create_project(client, headers, device, "Active")
    archived = create_project(client, headers, device, "Archived", manual=False)
    other_project = create_project(client, headers, other, "Other")
    active_session = add_session(client, device, active, "active")
    archived_session = add_session(client, device, archived, "archived", archived=True)
    other_session = add_session(client, other, other_project, "other")
    assert (
        client.patch(
            f"/projects/{active}", headers=headers, json={"pinned": True}
        ).status_code
        == 200
    )

    response = client.delete(f"/connectors/{device}", headers=headers)
    assert response.status_code == 204, response.text
    remaining = client.get("/projects", headers=headers).json()["projects"]
    assert [project["id"] for project in remaining] == [other_project]
    for project in (empty, active, archived):
        assert (
            client.get(f"/projects/{project}/sessions", headers=headers).status_code
            == 404
        )
    assert client.get(f"/connectors/{device}", headers=headers).status_code == 404
    assert client.get(f"/connectors/{other}", headers=headers).status_code == 200

    async def check_rows():
        async with client.app.state.store.engine.connect() as connection:
            assert list(
                (await connection.execute(select(projects.c.id))).scalars()
            ) == [other_project]
            attached = dict(
                (
                    await connection.execute(
                        select(sessions.c.id, sessions.c.project_id)
                    )
                ).all()
            )
            assert attached == {
                active_session: None,
                archived_session: None,
                other_session: other_project,
            }

    asyncio.run(check_rows())
    # Deleting the records also frees project names for another device.
    assert create_project(client, headers, other, "Active") != active


def test_unowned_or_missing_device_deletion_leaves_projects_untouched(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Protected")
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
    registered.raise_for_status()
    other_headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
    other_device = create_device(client, other_headers)
    other_project = create_project(client, other_headers, other_device, "Other project")

    assert client.delete(f"/connectors/{device}").status_code == 401
    assert (
        client.delete(f"/connectors/{device}", headers=other_headers).status_code == 404
    )
    assert client.delete("/connectors/missing", headers=headers).status_code == 404
    assert (
        client.get("/projects", headers=headers).json()["projects"][0]["id"] == project
    )
    assert (
        client.get("/projects", headers=other_headers).json()["projects"][0]["id"]
        == other_project
    )
    assert client.delete(f"/connectors/{device}", headers=headers).status_code == 204
    assert (
        client.get("/projects", headers=other_headers).json()["projects"][0]["id"]
        == other_project
    )


def test_token_rotation_keeps_device_projects(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Retained")
    add_session(client, device, project, "retained")
    response = client.post(f"/connectors/{device}/revoke", headers=headers)
    assert response.status_code == 200, response.text
    assert (
        client.get("/projects", headers=headers).json()["projects"][0]["id"] == project
    )
    assert (
        client.get(f"/projects/{project}/sessions", headers=headers).json()["sessions"][
            0
        ]["projectId"]
        == project
    )


def test_failed_project_cleanup_rolls_back_device_deletion_and_session_links(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Rollback")
    session = add_session(client, device, project, "rollback")

    async def reject_cleanup():
        async with client.app.state.store.engine.begin() as connection:
            await connection.execute(
                text(
                    "CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects "
                    "BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END"
                )
            )

    asyncio.run(reject_cleanup())
    with pytest.raises(IntegrityError, match="cleanup failed"):
        client.delete(f"/connectors/{device}", headers=headers)

    async def check_rows():
        async with client.app.state.store.engine.connect() as connection:
            assert (
                await connection.execute(
                    select(connectors.c.revoked).where(connectors.c.id == device)
                )
            ).scalar_one() == 0
            assert (
                await connection.execute(
                    select(sessions.c.project_id).where(sessions.c.id == session)
                )
            ).scalar_one() == project
            assert (
                await connection.execute(select(projects.c.id))
            ).scalar_one() == project

    asyncio.run(check_rows())


@pytest.mark.parametrize("existing_session", [False, True])
def test_late_connector_sync_cannot_recreate_projects_after_device_deletion(
    api, existing_session
):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Deleted")
    session = (
        add_session(client, device, project, "existing")
        if existing_session
        else "late-session"
    )
    assert client.delete(f"/connectors/{device}", headers=headers).status_code == 204

    async def sync():
        store = client.app.state.store
        with pytest.raises(KeyError):
            await store.upsert_connector_session(
                connector_id=device,
                session_id=session,
                runtime="codex",
                external_session_id="existing" if existing_session else "late-session",
                cwd="/work/Deleted",
            )
        async with store.engine.connect() as connection:
            assert (
                list((await connection.execute(select(projects.c.id))).scalars()) == []
            )

    asyncio.run(sync())
