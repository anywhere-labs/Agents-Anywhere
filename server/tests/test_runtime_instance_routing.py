from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy import insert

from agent_server.core.models import SessionView
from agent_server.infra.db import connectors
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_notifications import (
    InteractionNotificationHandler,
    NotificationValidationError,
    TimelineNotificationHandler,
)


def test_session_catalog_and_active_run_state_are_instance_scoped(tmp_path) -> None:
    path = tmp_path / "runtime-routing.sqlite3"
    upgrade_database(db_url=f"sqlite+aiosqlite:///{path}")
    store = Store(path)
    try:
        asyncio.run(_insert_connector(store, "conn_a"))
        first = asyncio.run(
            store.upsert_connector_session(
                connector_id="conn_a",
                session_id="sess_work",
                runtime="codex",
                runtime_id="rti_work",
                external_session_id="shared_external",
            )
        )
        second = asyncio.run(
            store.upsert_connector_session(
                connector_id="conn_a",
                session_id="sess_personal",
                runtime="codex",
                runtime_id="rti_personal",
                external_session_id="shared_external",
            )
        )

        assert first.id == "sess_work"
        assert first.runtimeId == "rti_work"
        assert second.id == "sess_personal"
        assert second.runtimeId == "rti_personal"

        work_catalog = {
            "runtime": "codex",
            "revision": 1,
            "models": [
                {
                    "id": "work-model",
                    "displayName": "Work model",
                    "selectionId": "sel_work",
                }
            ],
        }
        personal_catalog = {
            "runtime": "codex",
            "revision": 1,
            "models": [
                {
                    "id": "personal-model",
                    "displayName": "Personal model",
                    "selectionId": "sel_personal",
                }
            ],
        }
        asyncio.run(
            store.update_protocol_catalog(
                "conn_a",
                runtime="codex",
                runtime_id="rti_work",
                catalog_type="model",
                revision=1,
                catalog=work_catalog,
            )
        )
        asyncio.run(
            store.update_protocol_catalog(
                "conn_a",
                runtime="codex",
                runtime_id="rti_personal",
                catalog_type="model",
                revision=1,
                catalog=personal_catalog,
            )
        )
        assert (
            asyncio.run(
                store.get_protocol_catalog(
                    "conn_a",
                    runtime_id="rti_work",
                    catalog_type="model",
                )
            )
            == work_catalog
        )
        assert (
            asyncio.run(
                store.get_protocol_catalog(
                    "conn_a",
                    runtime_id="rti_personal",
                    catalog_type="model",
                )
            )
            == personal_catalog
        )

        asyncio.run(
            store.start_active_run(
                session_id=first.id,
                runtime="codex",
                runtime_id="rti_work",
            )
        )
        active = asyncio.run(store.get_active_run(first.id))
        assert active is not None
        assert active["runtime"] == "codex"
        assert active["runtimeId"] == "rti_work"
    finally:
        asyncio.run(store.close())


def test_connector_cannot_rebind_an_existing_session(tmp_path) -> None:
    path = tmp_path / "connector-binding.sqlite3"
    upgrade_database(db_url=f"sqlite+aiosqlite:///{path}")
    store = Store(path)
    try:
        asyncio.run(_insert_connector(store, "conn_a"))
        asyncio.run(_insert_connector(store, "conn_b"))
        asyncio.run(
            store.upsert_connector_session(
                connector_id="conn_a",
                session_id="sess_owned",
                runtime="codex",
                runtime_id="rti_work",
                external_session_id="external_a",
            )
        )

        with pytest.raises(ValueError, match="connector binding is immutable"):
            asyncio.run(
                store.upsert_connector_session(
                    connector_id="conn_b",
                    session_id="sess_owned",
                    runtime="codex",
                    runtime_id="rti_work",
                    external_session_id="external_b",
                )
            )

        session = asyncio.run(store.get_session("sess_owned"))
        assert session.connectorId == "conn_a"
        assert session.externalSessionId == "external_a"
    finally:
        asyncio.run(store.close())


def test_timeline_notification_rejects_connector_or_runtime_rebinding() -> None:
    session = SessionView(
        id="sess_owned",
        connectorId="conn_a",
        connectorStatus="online",
        runtime="codex",
        runtimeId="rti_work",
        status="idle",
        takeover=False,
        updatedSeq=1,
    )

    class Repository:
        async def resolve_connector_session_id(self, **values: Any) -> str:
            raise KeyError(values["session_id"])

        async def get_session(
            self,
            session_id: str,
            *,
            user_id: str | None = None,
        ) -> SessionView:
            assert session_id == session.id
            assert user_id is None
            return session

    handler = TimelineNotificationHandler(Repository())  # type: ignore[arg-type]
    params = {
        "sessionId": session.id,
        "runtime": "codex",
        "runtimeId": "rti_other",
        "items": [],
    }

    with pytest.raises(NotificationValidationError) as raised:
        asyncio.run(
            handler.apply(
                connector_id="conn_b",
                method="timeline.sync",
                params=params,
            )
        )

    assert raised.value.code == "session_connector_mismatch"


def test_notice_notification_uses_nested_runtime_instance_identity() -> None:
    session = SessionView(
        id="sess_owned",
        connectorId="conn_a",
        connectorStatus="online",
        runtime="codex",
        runtimeId="rti_work",
        status="idle",
        takeover=False,
        updatedSeq=1,
    )

    class Repository:
        async def get_session(
            self,
            session_id: str,
            *,
            user_id: str | None = None,
        ) -> SessionView:
            assert session_id == session.id
            assert user_id is None
            return session

    handler = InteractionNotificationHandler(Repository())  # type: ignore[arg-type]
    effect = asyncio.run(
        handler.apply(
            connector_id="conn_a",
            method="notice.upsert",
            params={
                "noticeId": "notice_1",
                "sessionId": session.id,
                "type": "notification",
                "title": "Ready",
                "source": {
                    "runtime": "codex",
                    "runtimeType": "codex",
                    "runtimeId": "rti_work",
                },
            },
        )
    )

    assert effect is not None
    assert effect.session_id == session.id
    assert [notice.noticeId for notice in effect.notices] == ["notice_1"]


def test_notice_notification_rejects_runtime_instance_rebinding() -> None:
    session = SessionView(
        id="sess_owned",
        connectorId="conn_a",
        connectorStatus="online",
        runtime="codex",
        runtimeId="rti_work",
        status="idle",
        takeover=False,
        updatedSeq=1,
    )

    class Repository:
        async def get_session(
            self,
            session_id: str,
            *,
            user_id: str | None = None,
        ) -> SessionView:
            return session

    handler = InteractionNotificationHandler(Repository())  # type: ignore[arg-type]
    with pytest.raises(NotificationValidationError) as raised:
        asyncio.run(
            handler.apply(
                connector_id="conn_a",
                method="notice.upsert",
                params={
                    "noticeId": "notice_1",
                    "sessionId": session.id,
                    "type": "notification",
                    "title": "Wrong instance",
                    "source": {
                        "runtime": "codex",
                        "runtimeId": "rti_other",
                    },
                },
            )
        )

    assert raised.value.code == "session_runtime_mismatch"


async def _insert_connector(store: Store, connector_id: str) -> None:
    now = "2026-08-25T00:00:00Z"
    async with store.engine.begin() as connection:
        await connection.execute(
            insert(connectors).values(
                id=connector_id,
                user_id="user_runtime_routing",
                name=connector_id,
                status="offline",
                token_hash=f"hash_{connector_id}",
                token_prefix=f"prefix_{connector_id}",
                revoked=0,
                created_at=now,
                updated_at=now,
            )
        )
