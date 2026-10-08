from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from connector.runtimes.pi.rpc import PiRpcProcess, PiRpcRequestFailed, response_data


async def test_request_response_roundtrip(fake_pi: Path) -> None:
    events: list[dict] = []
    process = PiRpcProcess(
        [str(fake_pi), "--mode", "rpc"],
        on_event=lambda record: _collect(events, record),
        request_timeout=5.0,
    )
    await process.start()
    try:
        response = await process.request({"type": "get_state"})
        data = response_data(response)
        assert data["sessionFile"]
        assert data["isStreaming"] is False
    finally:
        await process.close()
    assert process.alive is False


async def test_streaming_events_are_delivered(fake_pi: Path) -> None:
    events: list[dict] = []
    process = PiRpcProcess(
        [str(fake_pi), "--mode", "rpc"],
        on_event=lambda record: _collect(events, record),
        request_timeout=5.0,
    )
    await process.start()
    try:
        await process.request({"type": "prompt", "message": "hello"})
        for _ in range(200):
            if any(event.get("type") == "agent_settled" for event in events):
                break
            await asyncio.sleep(0.02)
    finally:
        await process.close()
    kinds = [event.get("type") for event in events]
    assert "agent_start" in kinds
    assert "message_end" in kinds
    assert "agent_settled" in kinds


async def test_unknown_command_fails(fake_pi: Path) -> None:
    process = PiRpcProcess([str(fake_pi), "--mode", "rpc"], request_timeout=5.0)
    await process.start()
    try:
        with pytest.raises(PiRpcRequestFailed):
            await process.request({"type": "definitely_not_a_command"})
    finally:
        await process.close()


async def test_slow_events_keep_wire_order_without_blocking_responses(fake_pi: Path) -> None:
    from .conftest import wait_for

    events: list[str] = []
    release = asyncio.Event()

    async def collect(record) -> None:
        if record["type"] == "agent_start":
            await release.wait()
        events.append(record["type"])

    process = PiRpcProcess([str(fake_pi), "--mode", "rpc"], on_event=collect)
    await process.start()
    try:
        await process.request({"type": "prompt", "message": "hello"})
        await process.request({"type": "get_state"}, timeout=1)
        assert events == []
        release.set()
        await wait_for(lambda: "agent_settled" in events)
        assert events[0] == "agent_start"
        assert events[-1] == "agent_settled"
        assert events.index("message_update") < events.index("agent_settled")
    finally:
        release.set()
        await process.close()


async def _collect(events: list[dict], record) -> None:
    events.append(dict(record))
