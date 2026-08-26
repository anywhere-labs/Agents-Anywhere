from __future__ import annotations

import asyncio

from sqlalchemy import insert

from agent_server.app import create_app
from agent_server.infra.db import android_app_releases
from conftest import ApiV2TestClient as TestClient


def test_android_update_check_uses_latest_published_release(tmp_path) -> None:
    app = create_app(tmp_path / "releases.sqlite3")
    client = TestClient(app)

    async def seed_release() -> None:
        async with app.state.store.engine.begin() as conn:
            await conn.execute(
                insert(android_app_releases).values(
                    version_code=7,
                    version_name="0.1.8",
                    download_url="https://downloads.example.com/agents-anywhere-0.1.8.apk",
                    sha256="a" * 64,
                    published=1,
                    created_at="2026-08-26T00:00:00Z",
                    updated_at="2026-08-26T00:00:00Z",
                )
            )

    asyncio.run(seed_release())

    response = client.get("/client-releases/android/check?versionCode=6")

    assert response.status_code == 200
    assert response.json() == {
        "updateAvailable": True,
        "latestVersionCode": 7,
        "latestVersionName": "0.1.8",
        "downloadUrl": "https://downloads.example.com/agents-anywhere-0.1.8.apk",
        "sha256": "a" * 64,
    }


def test_android_update_check_reports_current_version(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "current-release.sqlite3"))

    response = client.get("/client-releases/android/check?versionCode=6")

    assert response.status_code == 200
    assert response.json()["updateAvailable"] is False
    assert response.json()["latestVersionCode"] == 6
    assert response.json()["latestVersionName"] == "0.1.7.2"
