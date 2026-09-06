from __future__ import annotations

from conftest import ApiV2TestClient as TestClient

from agent_server.app import create_app


def _authenticated_client(tmp_path) -> tuple[TestClient, dict[str, str]]:
    client = TestClient(create_app(tmp_path / "projects.sqlite3"))
    client.get("/auth/config")
    registered = client.post(
        "/auth/register",
        json={
            "email": "project-owner@example.com",
            "displayName": "Project Owner",
            "password": "secret",
            "setupToken": client.app.state.setup_token.peek(),
        },
    )
    assert registered.status_code == 200, registered.text
    return client, {"Authorization": f"Bearer {registered.json()['accessToken']}"}


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
    assert first.json()["project"]["manuallyCreated"] is True

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
    assert replacement.json()["project"]["manuallyCreated"] is True

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
    assert (
        next(project for project in projects if project["id"] == project_id)["name"]
        == "Renamed"
    )

    archived = client.post(
        f"/projects/{project_id}/sessions/archive-all",
        headers=headers,
        json={"archived": True, "scope": "all"},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["affected"] == 0
    projects = client.get("/projects", headers=headers).json()["projects"]
    assert (
        next(project for project in projects if project["id"] == project_id)[
            "manuallyCreated"
        ]
        is False
    )


def test_project_resolve_reuses_names_and_creates_automatic_projects(tmp_path) -> None:
    client, headers = _authenticated_client(tmp_path)
    connector_id = client.post(
        "/connectors", headers=headers, json={"name": "dev"}
    ).json()["connector"]["id"]
    manual = client.post(
        "/projects",
        headers=headers,
        json={
            "name": "Custom name",
            "connectorId": connector_id,
            "workspacePath": "/repo",
        },
    ).json()["project"]

    def resolve(path):
        response = client.post(
            "/projects/resolve",
            headers=headers,
            json={"connectorId": connector_id, "workspacePath": path},
        )
        assert response.status_code == 200, response.text
        return response.json()["project"]

    reused = resolve("/repo/./")
    assert reused["id"] == manual["id"]
    assert reused["name"] == "Custom name"
    assert reused["manuallyCreated"] is True
    automatic = resolve("/work/repo")
    assert automatic["name"] == "repo"
    assert automatic["manuallyCreated"] is False
    again = resolve("/work/repo/")
    assert again["id"] == automatic["id"]
    assert again["manuallyCreated"] is False
    other = resolve("/other/repo")
    assert other["id"] != automatic["id"]
    assert other["name"] == "repo (1)"
    assert len(client.get("/projects", headers=headers).json()["projects"]) == 3


def test_project_resolve_validates_ownership_paths_and_revocation(tmp_path) -> None:
    client, headers = _authenticated_client(tmp_path)
    connector_id = client.post(
        "/connectors", headers=headers, json={"name": "dev"}
    ).json()["connector"]["id"]
    body = {"connectorId": connector_id, "workspacePath": "/repo"}
    assert client.post("/projects/resolve", json=body).status_code == 401
    for invalid in ("", "relative/path", "~"):
        assert (
            client.post(
                "/projects/resolve",
                headers=headers,
                json={**body, "workspacePath": invalid},
            ).status_code
            == 422
        )
    assert (
        client.post(
            "/projects/resolve",
            headers=headers,
            json={**body, "connectorId": "missing"},
        ).status_code
        == 404
    )
    client.patch("/admin/settings", headers=headers, json={"registrationOpen": True})
    other = client.post(
        "/auth/register",
        json={
            "email": "other@example.com",
            "displayName": "Other",
            "password": "secret",
        },
    )
    assert other.status_code == 200, other.text
    other_headers = {"Authorization": f"Bearer {other.json()['accessToken']}"}
    assert (
        client.post("/projects/resolve", headers=other_headers, json=body).status_code
        == 404
    )
    assert client.get("/projects", headers=headers).json()["projects"] == []
    revoked = client.delete(f"/connectors/{connector_id}", headers=headers)
    assert revoked.status_code == 204, revoked.text
    assert (
        client.post("/projects/resolve", headers=headers, json=body).status_code == 404
    )


def test_project_auto_names_fit_the_name_limit_with_suffixes() -> None:
    from agent_server.infra.repositories.projects import _next_project_name

    name = "文" * 255
    next_name = _next_project_name(name, {name})
    assert len(next_name) == 255
    assert next_name.endswith(" (1)")
