from __future__ import annotations

import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

from agent_server.app import create_app
from agent_server.infra.db.migrations import CURRENT_SCHEMA_VERSION


def test_health_reports_the_application_version_and_releases_are_retired(tmp_path) -> None:
    app = create_app(tmp_path / "versions.sqlite3")
    client = TestClient(app)
    expected = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())["project"]["version"]
    for route in ("/api/v2/health", "/api/v2/health/live"):
        response = client.get(route)
        assert response.status_code == 200
        assert response.json()["version"] == app.version == expected
        assert response.json()["status"] == "ok"
    assert not any("client-releases" in route for route in app.openapi()["paths"])
    assert client.get("/api/v2/client-releases/check?platform=desktop&versionCode=1").status_code == 404
    assert client.get("/api/v2/admin/client-releases").status_code == 404
    assert client.post("/api/v2/admin/client-releases", json={}).status_code == 404


def test_liveness_and_readiness_are_separate(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "health.sqlite3"))

    assert client.get("/api/v2/health/live").json()["status"] == "ok"
    response = client.get("/api/v2/health/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["checks"] == {
        "database": {"status": "ok", "schemaVersion": CURRENT_SCHEMA_VERSION},
        "redis": {"status": "not_configured"},
    }


def test_readiness_fails_closed_when_redis_is_unavailable(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "redis-health.sqlite3"))

    class UnavailableRedis:
        distributed = True

        async def ping(self, *, timeout_seconds: float = 2) -> None:
            raise ConnectionError("redis unavailable")

    client.app.state.redis = UnavailableRedis()
    response = client.get("/api/v2/health/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert response.json()["checks"]["database"]["status"] == "ok"
    assert response.json()["checks"]["redis"] == {
        "status": "error",
        "message": "redis unavailable",
    }
