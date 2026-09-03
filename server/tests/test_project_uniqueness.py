from __future__ import annotations

from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app


def _authenticated_client(tmp_path) -> tuple[TestClient, dict[str, str]]:
    client = TestClient(create_app(tmp_path / "projects.sqlite3"))
    client.get("/auth/config")
    registered = client.post(
        "/auth/register",
        json={
            "userId": "project-owner",
            "password": "secret",
            "setupToken": client.app.state.setup_token.peek(),
        },
    )
    assert registered.status_code == 200, registered.text
    return client, {
        "Authorization": f"Bearer {registered.json()['accessToken']}"
    }


def test_project_create_reuses_workspace_and_rejects_duplicate_name(tmp_path) -> None:
    client, headers = _authenticated_client(tmp_path)
    connector = client.post(
        "/connectors",
        headers=headers,
        json={"name": "dev"},
    )
    assert connector.status_code == 200, connector.text
    connector_id = connector.json()["connector"]["id"]

    first = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Original",
            "connectorId": connector_id,
            "workspacePath": "/repo/",
        },
    )
    assert first.status_code == 200, first.text
    project_id = first.json()["project"]["id"]

    replacement = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Renamed",
            "connectorId": connector_id,
            "workspacePath": "/repo",
        },
    )
    assert replacement.status_code == 200, replacement.text
    assert replacement.json()["project"]["id"] == project_id
    assert replacement.json()["project"]["name"] == "Renamed"

    other = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Already used",
            "connectorId": connector_id,
            "workspacePath": "/other",
        },
    )
    assert other.status_code == 200, other.text

    duplicate_name = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Already used",
            "connectorId": connector_id,
            "workspacePath": "/third",
        },
    )
    assert duplicate_name.status_code == 409, duplicate_name.text
    assert duplicate_name.json()["detail"]["code"] == "project_name_conflict"

    projects = client.get("/projects", headers=headers).json()["projects"]
    assert len(projects) == 2
    assert next(project for project in projects if project["id"] == project_id)[
        "name"
    ] == "Renamed"
