from __future__ import annotations

import asyncio
from typing import Any

from connector.logging import install_rpc_log_sink, logger


def test_rpc_log_sink_forwards_loguru_records() -> None:
    async def exercise() -> list[tuple[str, Any]]:
        events: list[tuple[str, Any]] = []

        async def notify(method: str, params: Any) -> None:
            events.append((method, params))

        sink = install_rpc_log_sink(notify, level="INFO")
        try:
            logger.info("desktop visible log {}", "entry")
            await asyncio.sleep(0)
        finally:
            await sink.close()
        return events

    events = asyncio.run(exercise())

    assert events[0][0] == "connector/log"
    assert events[0][1]["level"] == "INFO"
    assert events[0][1]["message"] == "desktop visible log entry"


def test_rpc_log_sink_defaults_to_info_level() -> None:
    async def exercise() -> list[tuple[str, Any]]:
        events: list[tuple[str, Any]] = []

        async def notify(method: str, params: Any) -> None:
            events.append((method, params))

        sink = install_rpc_log_sink(notify)
        try:
            logger.debug("hidden debug")
            logger.info("visible info")
            await asyncio.sleep(0)
        finally:
            await sink.close()
        return events

    events = asyncio.run(exercise())

    assert [event[1]["message"] for event in events] == ["visible info"]


def test_rpc_log_sink_clips_records_to_the_service_limits() -> None:
    async def exercise() -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        sink = install_rpc_log_sink(lambda method, payload: events.append(payload), level="INFO")
        try:
            logger.info("x" * 20_000)
            await asyncio.sleep(0)
        finally:
            await sink.close()
        return events

    events = asyncio.run(exercise())

    assert len(events) == 1
    assert len(events[0]["message"]) == 16_000
    assert events[0]["message"].endswith("…")


def test_log_service_access_logs_are_excluded_to_prevent_feedback() -> None:
    async def exercise():
        events = []
        sink = install_rpc_log_sink(lambda method, payload: events.append(payload), level="DEBUG")
        try:
            logger.bind(meshcall_service="aa.local.v2.Logs").debug("write succeeded")
            logger.debug("RPC call aa.local.v2.Logs.read status=ok")
            logger.bind(meshcall_service="aa.local.v2.Control", meshcall_method="getState", meshcall_call_id="call-1").info("control")
        finally:
            await sink.close()
        assert len(events) == 1
        assert 'call-1' in events[0]['details']
    asyncio.run(exercise())


def test_rpc_log_sink_records_the_exception_traceback() -> None:
    async def exercise() -> list[Any]:
        events: list[Any] = []

        def notify(method: str, params: Any) -> None:
            events.append(params)

        sink = install_rpc_log_sink(notify, level="INFO")
        try:
            try:
                raise ValueError("Batch for a subscription that already ended")
            except ValueError:
                logger.exception("Unhandled exception in aa.dsh.v2.Sync.ingestBatch")
        finally:
            await sink.close()
        return events

    exception = asyncio.run(exercise())[0]["exception"]
    # Readable traceback text instead of the repr of Loguru's record tuple.
    assert exception.startswith("Traceback (most recent call last):")
    assert "in exercise" in exception
    assert exception.rstrip().endswith("ValueError: Batch for a subscription that already ended")
