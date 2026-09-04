from __future__ import annotations

from fastapi.testclient import TestClient

from agent_server.app import create_app
from agent_server.infra.db.migrations import CURRENT_SCHEMA_VERSION


def test_liveness_and_readiness_are_separate(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "health.sqlite3"))

    for path in ("/api/v2/health", "/api/v2/health/live"):
        liveness = client.get(path)
        assert liveness.status_code == 200
        assert liveness.json()["status"] == "ok"
        assert liveness.json()["version"] == client.app.version
        assert liveness.json()["serverTime"]

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
