from __future__ import annotations

import asyncpg
import pytest
from conftest import TEST_DATABASE_URL, _asyncpg_url
from session_fixtures import create_session_with_project
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as DatabasePoolTimeoutError

from agent_server.core.models import ConnectorNotification, TimelineItemIn
from agent_server.infra.repositories import timeline as timeline_repository
from agent_server.infra.repositories.facade import Store
from agent_server.infra.repositories.timeline import session_timeline_lock_key
from agent_server.services.connector_ingest import (
    ingest_error_is_retryable,
    ingest_rejection_from_exception,
)


def _notification() -> ConnectorNotification:
    return ConnectorNotification(
        method="timeline.itemUpsert",
        params={"sessionId": "sess_1"},
    )


class _DriverError(Exception):
    def __init__(self, sqlstate: str) -> None:
        super().__init__(f"driver error {sqlstate}")
        self.sqlstate = sqlstate


def test_lock_timeout_rejection_is_retryable() -> None:
    error = TimeoutError(
        "timed out acquiring distributed lock: session-revision:sess_1"
    )

    assert ingest_error_is_retryable(error) is True
    rejection = ingest_rejection_from_exception(0, _notification(), error)
    assert rejection.code == "notification_failed"
    assert rejection.errorType == "TimeoutError"
    assert rejection.retryable is True


def test_validation_rejection_is_not_retryable() -> None:
    error = ValueError("invalid timeline item")

    assert ingest_error_is_retryable(error) is False
    rejection = ingest_rejection_from_exception(0, _notification(), error)
    assert rejection.code == "notification_failed"
    assert rejection.errorType == "ValueError"
    assert rejection.retryable is False


def test_exhausted_connection_pool_is_retryable() -> None:
    error = DatabasePoolTimeoutError("QueuePool limit of size 5 overflow 10 reached")

    assert ingest_error_is_retryable(error) is True


@pytest.mark.parametrize(
    ("sqlstate", "retryable"),
    [
        ("55P03", True),  # lock_not_available
        ("40P01", True),  # deadlock_detected
        ("40001", True),  # serialization_failure
        ("23505", False),  # unique_violation
        ("22P02", False),  # invalid_text_representation
    ],
)
def test_wrapped_database_errors_follow_their_sqlstate(
    sqlstate: str, retryable: bool
) -> None:
    driver = _DriverError(sqlstate)
    wrapped = OperationalError("SELECT 1", {}, driver)

    assert ingest_error_is_retryable(wrapped) is retryable


def test_retryable_cause_is_found_through_the_chain() -> None:
    try:
        try:
            raise TimeoutError("lock wait")
        except TimeoutError as cause:
            raise RuntimeError("timeline write failed") from cause
    except RuntimeError as error:
        assert ingest_error_is_retryable(error) is True


@pytest.mark.anyio
async def test_timeline_writer_lock_timeout_is_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The writer lock added for #415 times out inside PostgreSQL, not in Python."""

    monkeypatch.setattr(timeline_repository, "TIMELINE_LOCK_TIMEOUT", "200ms")
    store = Store()
    holder = await asyncpg.connect(_asyncpg_url(TEST_DATABASE_URL))
    try:
        connector, _, _ = await store.create_connector(name="dev", user_id="user_1")
        session = await create_session_with_project(store, connector_id=connector.id)
        transaction = holder.transaction()
        await transaction.start()
        await holder.execute(
            "SELECT pg_advisory_xact_lock($1)", session_timeline_lock_key(session.id)
        )
        try:
            with pytest.raises(Exception) as caught:
                await store.upsert_timeline_item(
                    session_id=session.id,
                    item=TimelineItemIn.model_validate(
                        {
                            "id": "item_1",
                            "sessionId": session.id,
                            "type": "message",
                            "status": "done",
                            "role": "assistant",
                            "content": {"text": "hello", "format": "markdown"},
                            "source": {
                                "runtime": "codex",
                                "sessionId": "thread_1",
                                "itemId": "item_1",
                            },
                            "orderSeq": 1,
                            "revision": 1,
                            "contentHash": "sha256:item_1",
                        }
                    ),
                )
        finally:
            await transaction.rollback()
    finally:
        await holder.close()
        await store.close()

    assert not isinstance(caught.value, TimeoutError)
    assert ingest_error_is_retryable(caught.value) is True
    rejection = ingest_rejection_from_exception(0, _notification(), caught.value)
    assert rejection.retryable is True
