from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import insert

from agent_server.app import create_app
from agent_server.core.models import TimelineItemIn
from agent_server.infra.db import dashboard_daily_metrics as dashboard_daily_metrics_t


def make_client(tmp_path) -> TestClient:
    return TestClient(create_app(tmp_path / "test.sqlite3"))


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register_admin(client: TestClient) -> dict[str, str]:
    cfg = client.get("/auth/config").json()
    body: dict[str, Any] = {"userId": "admin", "password": "secret"}
    if cfg["needsBootstrap"]:
        body["setupToken"] = client.app.state.setup_token.peek()
    response = client.post("/auth/register", json=body)
    assert response.status_code == 200, response.text
    return bearer(response.json()["accessToken"])


def create_member(client: TestClient, admin_headers: dict[str, str], user_id: str) -> dict[str, str]:
    response = client.post(
        "/admin/users",
        headers=admin_headers,
        json={"userId": user_id, "password": "secret", "role": "member"},
    )
    assert response.status_code == 201, response.text
    login = client.post("/auth/login", json={"userId": user_id, "password": "secret"})
    assert login.status_code == 200, login.text
    return bearer(login.json()["accessToken"])


def create_connector(client: TestClient, headers: dict[str, str], name: str) -> str:
    response = client.post("/connectors", headers=headers, json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()["connector"]["id"]


async def seed_dashboard_activity(client: TestClient) -> dict[str, str]:
    store = client.app.state.store
    admin_headers = register_admin(client)
    bob_headers = create_member(client, admin_headers, "bob")
    admin_connector = create_connector(client, admin_headers, "admin-mac")
    bob_connector = create_connector(client, bob_headers, "bob-win")
    await store.set_connector_status(admin_connector, "offline", device_os="macos")
    await store.set_connector_status(bob_connector, "offline", device_os="windows")
    await store.attach_runtime(admin_connector, "codex", {"selected": {"source": "path", "path": "/bin/codex"}})
    await store.attach_runtime(bob_connector, "claude", {"selected": {"source": "path", "path": "/bin/claude"}})
    admin_session = await store.upsert_connector_session(
        connector_id=admin_connector,
        session_id="sess_admin_codex",
        runtime="codex",
        external_session_id="thr_admin",
        title="Admin Codex",
        cwd="/repo",
        status="idle",
        origin="platform",
    )
    bob_session = await store.upsert_connector_session(
        connector_id=bob_connector,
        session_id="sess_bob_claude",
        runtime="claude",
        external_session_id="thr_bob",
        title="Bob Claude",
        cwd="/repo",
        status="idle",
        origin="platform",
    )
    await store.upsert_timeline_item(
        session_id=admin_session.id,
        item=_turn_start(admin_session.id, "turn_admin_1", 1, "codex"),
    )
    await store.upsert_timeline_item(
        session_id=admin_session.id,
        item=_platform_user_message(admin_session.id, "turn_admin_1", 2, "codex", "cm_admin_1"),
    )
    await store.upsert_timeline_item(
        session_id=admin_session.id,
        item=_turn_start(admin_session.id, "turn_admin_2", 3, "codex"),
    )
    await store.upsert_timeline_item(
        session_id=admin_session.id,
        item=_platform_user_message(admin_session.id, "turn_admin_2", 4, "codex", "cm_admin_2"),
    )
    await store.upsert_timeline_item(
        session_id=bob_session.id,
        item=_turn_start(bob_session.id, "turn_bob_1", 1, "claude"),
    )
    await store.upsert_timeline_item(
        session_id=bob_session.id,
        item=_platform_user_message(bob_session.id, "turn_bob_1", 2, "claude", "cm_bob_1"),
    )
    return admin_headers


def _turn_start(session_id: str, turn_id: str, order_seq: int, runtime: str) -> TimelineItemIn:
    return TimelineItemIn(
        id=f"tl_{turn_id}",
        sessionId=session_id,
        turnId=turn_id,
        type="turn.start",
        status="running",
        content={},
        source={
            "runtime": runtime,
            "turnId": turn_id,
            "event": "turn/started",
            "derivedKey": "turn-start",
        },
        orderSeq=order_seq,
        revision=1,
        contentHash=f"sha256:{turn_id}",
    )


def _platform_user_message(
    session_id: str,
    turn_id: str,
    order_seq: int,
    runtime: str,
    client_message_id: str,
) -> TimelineItemIn:
    return TimelineItemIn(
        id=f"tl_msg_{client_message_id}",
        sessionId=session_id,
        turnId=turn_id,
        type="message",
        status="done",
        role="user",
        content={"text": "Run it", "format": "markdown"},
        source={
            "runtime": runtime,
            "turnId": turn_id,
            "event": "item/completed",
            "clientMessageId": client_message_id,
        },
        orderSeq=order_seq,
        revision=1,
        contentHash=f"sha256:{client_message_id}",
    )


def _history_user_message(session_id: str, turn_id: str, order_seq: int, runtime: str) -> TimelineItemIn:
    return TimelineItemIn(
        id=f"tl_history_msg_{turn_id}",
        sessionId=session_id,
        turnId=turn_id,
        type="message",
        status="done",
        role="user",
        content={"text": "Local history", "format": "markdown"},
        source={
            "runtime": runtime,
            "turnId": turn_id,
            "event": "history/response_item",
        },
        orderSeq=order_seq,
        revision=1,
        contentHash=f"sha256:history:{turn_id}",
    )


def today() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()


def test_admin_dashboard_overview_builds_daily_snapshot(tmp_path):
    client = make_client(tmp_path)
    admin_headers = asyncio.run(seed_dashboard_activity(client))
    current = today()

    response = client.get(
        "/admin/dashboard/overview",
        headers=admin_headers,
        params={"from": current, "to": current},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["summary"]["totalUsers"] == 2
    assert body["summary"]["newUsers"] == 2
    assert body["summary"]["dau"] == 2
    assert body["summary"]["activeUsers"] == 2
    assert body["summary"]["totalTurns"] == 3
    assert body["summary"]["activeSessions"] == 2
    assert body["summary"]["avgTurnsPerActiveUser"] == 1.5
    assert body["summary"]["avgActiveSessionsPerActiveUser"] == 1.0
    assert body["summary"]["totalDevices"] == 2
    assert body["deviceBreakdown"] == [
        {"key": "macos", "label": "macOS", "value": 1.0, "percent": 50.0},
        {"key": "windows", "label": "Windows", "value": 1.0, "percent": 50.0},
        {"key": "linux", "label": "Linux", "value": 0.0, "percent": 0.0},
        {"key": "unknown", "label": "Unknown", "value": 0.0, "percent": 0.0},
    ]
    assert {item["key"]: item["value"] for item in body["agentBreakdown"]} == {
        "codex": 1.0,
        "claude": 1.0,
    }
    assert {item["key"]: item["value"] for item in body["sessionAgentBreakdown"]} == {
        "codex": 1.0,
        "claude": 1.0,
    }
    assert body["settings"]["intensity"] == {"basis": "turns", "lightMax": 1, "mediumMax": 2}
    assert body["settings"]["histogramBins"]["turns"] == [0, 1]
    assert body["settings"]["histogramBins"]["sessions"] == [0, 1]
    assert body["turnHistogram"] == [
        {"key": "0-1", "label": "0-1", "count": 1, "min": 0, "max": 1},
        {"key": "2+", "label": "2+", "count": 1, "min": 2, "max": None},
    ]
    assert {item["segment"]: item["count"] for item in body["userSegments"]} == {
        "light": 1,
        "medium": 1,
        "heavy": 0,
    }
    assert len(body["series"]) == 1
    assert body["series"][0]["activeUsers"] == 2


def test_admin_dashboard_ignores_connector_history_for_usage_metrics(tmp_path):
    client = make_client(tmp_path)
    store = client.app.state.store
    admin_headers = register_admin(client)
    connector_id = create_connector(client, admin_headers, "admin-mac")
    current = today()

    async def seed_history_import() -> None:
        await store.set_connector_status(connector_id, "offline", device_os="macos")
        await store.attach_runtime(connector_id, "codex", {"selected": {"source": "path", "path": "/bin/codex"}})
        imported = await store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_imported_codex",
            runtime="codex",
            external_session_id="thr_imported",
            title="Imported history",
            cwd="/repo",
            status="idle",
        )
        await store.upsert_timeline_item(
            session_id=imported.id,
            item=_turn_start(imported.id, "turn_history_1", 1, "codex"),
        )
        await store.upsert_timeline_item(
            session_id=imported.id,
            item=_history_user_message(imported.id, "turn_history_1", 2, "codex"),
        )
        async with store.engine.begin() as conn:
            await conn.execute(
                insert(dashboard_daily_metrics_t),
                [
                    {
                        "date": current,
                        "metric_key": "users.dau",
                        "dimension_key": "",
                        "dimension_value": "",
                        "value": 9,
                        "computed_at": f"{current}T00:00:00Z",
                    },
                    {
                        "date": current,
                        "metric_key": "usage.turns",
                        "dimension_key": "",
                        "dimension_value": "",
                        "value": 99,
                        "computed_at": f"{current}T00:00:00Z",
                    },
                    {
                        "date": current,
                        "metric_key": "usage.active_sessions",
                        "dimension_key": "",
                        "dimension_value": "",
                        "value": 12,
                        "computed_at": f"{current}T00:00:00Z",
                    },
                ],
            )

    asyncio.run(seed_history_import())

    response = client.get(
        "/admin/dashboard/overview",
        headers=admin_headers,
        params={"from": current, "to": current},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["summary"]["dau"] == 1
    assert body["summary"]["activeUsers"] == 0
    assert body["summary"]["totalTurns"] == 0
    assert body["summary"]["activeSessions"] == 0
    assert {item["key"]: item["value"] for item in body["sessionAgentBreakdown"]} == {
        "codex": 0.0,
        "claude": 0.0,
    }
    assert {item["key"]: item["value"] for item in body["agentBreakdown"]} == {
        "codex": 1.0,
        "claude": 0.0,
    }


def test_admin_dashboard_settings_drive_segments(tmp_path):
    client = make_client(tmp_path)
    admin_headers = asyncio.run(seed_dashboard_activity(client))
    current = today()

    settings = client.patch(
        "/admin/dashboard/settings",
        headers=admin_headers,
        json={"intensity": {"basis": "turns", "lightMax": 0, "mediumMax": 1}},
    )
    assert settings.status_code == 200, settings.text
    refreshed = client.post(f"/admin/dashboard/snapshots/{current}", headers=admin_headers)
    assert refreshed.status_code == 200, refreshed.text

    overview = client.get(
        "/admin/dashboard/overview",
        headers=admin_headers,
        params={"from": current, "to": current},
    ).json()
    assert {item["segment"]: item["count"] for item in overview["userSegments"]} == {
        "light": 0,
        "medium": 1,
        "heavy": 1,
    }


def test_admin_dashboard_rejects_non_admin(tmp_path):
    client = make_client(tmp_path)
    admin_headers = register_admin(client)
    member_headers = create_member(client, admin_headers, "bob")

    response = client.get("/admin/dashboard/overview", headers=member_headers)

    assert response.status_code == 403
