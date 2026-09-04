from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import insert

from agent_server.app import create_app
from agent_server.infra.db import app_releases
from conftest import ApiV2TestClient as TestClient


def _register_admin(client: TestClient) -> dict[str, str]:
    config = client.get("/auth/config").json()
    body: dict[str, Any] = {"userId": "admin", "password": "secret"}
    if config["needsBootstrap"]:
        body["setupToken"] = client.app.state.setup_token.peek()
    response = client.post("/auth/register", json=body)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def test_update_check_uses_latest_published_release_for_platform(tmp_path) -> None:
    app = create_app(tmp_path / "releases.sqlite3")
    client = TestClient(app)

    async def seed_releases() -> None:
        async with app.state.store.engine.begin() as conn:
            await conn.execute(
                insert(app_releases),
                [
                    {
                        "platform": "android",
                        "version_code": 7,
                        "version_name": "0.1.8",
                        "download_url": "https://downloads.example.com/app-0.1.8.apk",
                        "published": 1,
                        "created_at": "2026-08-26T00:00:00Z",
                        "updated_at": "2026-08-26T00:00:00Z",
                    },
                    {
                        "platform": "desktop",
                        "version_code": 20,
                        "version_name": "0.2.0",
                        "download_url": "https://downloads.example.com/app-0.2.0.dmg",
                        "published": 1,
                        "created_at": "2026-08-26T00:00:00Z",
                        "updated_at": "2026-08-26T00:00:00Z",
                    },
                ],
            )

    asyncio.run(seed_releases())

    response = client.get("/client-releases/check?platform=android&versionCode=6")

    assert response.status_code == 200
    assert response.json() == {
        "platform": "android",
        "updateAvailable": True,
        "latestVersionCode": 7,
        "latestVersionName": "0.1.8",
        "downloadUrl": "https://downloads.example.com/app-0.1.8.apk",
    }


def test_desktop_targets_keep_macos_and_windows_installers_separate(tmp_path) -> None:
    app = create_app(tmp_path / "desktop-targets.sqlite3")
    client = TestClient(app)

    async def seed_releases() -> None:
        async with app.state.store.engine.begin() as conn:
            await conn.execute(
                insert(app_releases),
                [
                    {
                        "platform": "desktop-macos",
                        "version_code": 7,
                        "version_name": "0.1.8",
                        "download_url": "https://downloads.example.com/agents-anywhere-0.1.8.dmg",
                        "published": 1,
                        "created_at": "2026-09-05T00:00:00Z",
                        "updated_at": "2026-09-05T00:00:00Z",
                    },
                    {
                        "platform": "desktop-windows",
                        "version_code": 7,
                        "version_name": "0.1.8",
                        "download_url": "https://downloads.example.com/agents-anywhere-0.1.8.exe",
                        "published": 1,
                        "created_at": "2026-09-05T00:00:00Z",
                        "updated_at": "2026-09-05T00:00:00Z",
                    },
                ],
            )

    asyncio.run(seed_releases())

    macos = client.get("/client-releases/check?platform=desktop-macos&versionCode=6")
    windows = client.get(
        "/client-releases/check?platform=desktop-windows&versionCode=6"
    )

    assert macos.status_code == 200
    assert macos.json()["platform"] == "desktop-macos"
    assert macos.json()["downloadUrl"].endswith(".dmg")
    assert windows.status_code == 200
    assert windows.json()["platform"] == "desktop-windows"
    assert windows.json()["downloadUrl"].endswith(".exe")


def test_update_check_reports_current_android_version(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "current-release.sqlite3"))

    response = client.get("/client-releases/check?platform=android&versionCode=6")

    assert response.status_code == 200
    assert response.json()["updateAvailable"] is False
    assert response.json()["latestVersionCode"] == 6
    assert response.json()["latestVersionName"] == "0.1.7.2"


def test_update_check_rejects_unsupported_platform(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "invalid-platform.sqlite3"))

    response = client.get("/client-releases/check?platform=ios&versionCode=1")

    assert response.status_code == 422


def test_admin_can_create_and_list_releases(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "admin-releases.sqlite3"))
    headers = _register_admin(client)

    create = client.post(
        "/admin/client-releases",
        headers=headers,
        json={
            "platform": "desktop",
            "versionCode": 20,
            "versionName": "0.2.0",
            "downloadUrl": "https://downloads.example.com/app-0.2.0.dmg",
            "published": True,
        },
    )

    assert create.status_code == 201, create.text
    assert create.json()["platform"] == "desktop"
    releases = client.get("/admin/client-releases", headers=headers)
    assert releases.status_code == 200
    assert {
        (item["platform"], item["versionCode"]) for item in releases.json()["releases"]
    } == {
        ("android", 6),
        ("desktop", 20),
    }

    duplicate = client.post(
        "/admin/client-releases",
        headers=headers,
        json={
            "platform": "desktop",
            "versionCode": 20,
            "versionName": "0.2.0",
            "downloadUrl": "https://downloads.example.com/app-0.2.0.dmg",
        },
    )
    assert duplicate.status_code == 409


def test_release_admin_endpoints_require_admin(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "protected-releases.sqlite3"))

    response = client.get("/admin/client-releases")

    assert response.status_code == 401
