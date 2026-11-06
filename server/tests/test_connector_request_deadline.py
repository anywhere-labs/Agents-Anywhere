from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from agent_server.infra import connector_rpc as rpc_module
from agent_server.infra.connector_rpc import (
    ConnectorTransportTimeout,
    bounded_connector_request,
    connector_request_timeout,
    current_request_deadline,
    routed_request_timeout,
)


def test_nested_requests_inherit_one_deadline_and_call_identity():
    async def exercise():
        assert current_request_deadline() is None
        async with connector_request_timeout(10, call_id="original") as outer:
            async with connector_request_timeout(0, call_id="replacement") as inner:
                assert inner is outer and inner.call_id == "original"
                assert 0 < inner.remaining() <= 10
            assert current_request_deadline() is outer
        assert current_request_deadline() is None
    asyncio.run(exercise())


@pytest.mark.parametrize("delivery", ["not_dispatched", "outcome_unknown"])
def test_deadline_reports_delivery_state_and_restores_context(delivery):
    async def exercise():
        async with asyncio.timeout(2):
            with pytest.raises(ConnectorTransportTimeout) as caught:
                async with connector_request_timeout(0.01, call_id="call") as deadline:
                    deadline.delivery_state = delivery
                    await asyncio.Event().wait()
        assert caught.value.details == {"deliveryState": delivery, "controlCallId": "call"}
        assert current_request_deadline() is None
    asyncio.run(exercise())


def test_domain_timeout_is_not_relabelled_as_transport_timeout():
    async def exercise():
        original = TimeoutError("runtime process timed out")
        with pytest.raises(TimeoutError) as caught:
            async with connector_request_timeout(10):
                raise original
        assert caught.value is original
        assert current_request_deadline() is None
    asyncio.run(exercise())


def test_external_cancellation_stays_cancellation_and_restores_context():
    async def exercise():
        entered = asyncio.Event()
        async def request():
            try:
                async with connector_request_timeout(10):
                    entered.set()
                    await asyncio.Event().wait()
            finally:
                assert current_request_deadline() is None
        task = asyncio.create_task(request())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert current_request_deadline() is None
    asyncio.run(exercise())


def test_parallel_requests_do_not_share_contextvars():
    async def exercise():
        entered = asyncio.Queue()
        release = asyncio.Event()
        async def request(identity):
            async with connector_request_timeout(10, call_id=identity) as deadline:
                entered.put_nowait(deadline)
                await release.wait()
                assert current_request_deadline() is deadline and deadline.call_id == identity
            assert current_request_deadline() is None
        tasks = [asyncio.create_task(request(identity)) for identity in ("one", "two")]
        try:
            one, two = await entered.get(), await entered.get()
            assert one is not two and current_request_deadline() is None
            release.set()
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(exercise())


@pytest.mark.parametrize("timeout", [0, -1])
def test_expired_budget_rejects_before_entering_handler(timeout):
    async def exercise():
        calls = []
        @bounded_connector_request
        async def request(*, timeout):
            calls.append(timeout)
        with pytest.raises(ConnectorTransportTimeout) as caught:
            await request(timeout=timeout)
        assert not calls and caught.value.details["deliveryState"] == "not_dispatched"
        assert current_request_deadline() is None
    asyncio.run(exercise())


@pytest.mark.parametrize("payload,expected", [
    ({}, 30), ({"timeout": 3}, 3), ({"timeout": 30, "deadlineAt": 105}, 5),
    ({"timeout": 3, "deadlineAt": 105}, 3), ({"timeout": 30, "deadlineAt": 99}, 0),
])
def test_redis_relay_budget_subtracts_elapsed_wall_clock_time(monkeypatch, payload, expected):
    monkeypatch.setattr(rpc_module, "time", SimpleNamespace(time=lambda: 100))
    assert routed_request_timeout(payload) == expected
