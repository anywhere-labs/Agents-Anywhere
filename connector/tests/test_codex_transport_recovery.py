from __future__ import annotations

import asyncio
import gc
from typing import Any

import pytest
from test_codex_runtime import FakeHost, _config, _input_request_notification

from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import CodexSdkClient


class NativeReadClient:
    def __init__(self, *, closed: bool = False) -> None:
        self.closed = closed
        self.started = False
        self.stopped = False
        self.reads = 0

    async def start(self, handler: Any) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def thread_list(self, **kwargs: Any) -> dict[str, Any]:
        self.reads += 1
        if self.closed:
            raise BrokenPipeError(32, "fake app-server transport closed")
        return {"data": []}


class LiveTurn:
    id = "turn_1"

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.complete = asyncio.Event()
        self.terminal_delivered = asyncio.Event()
        self.hold = asyncio.Event()

    async def stream(self):
        self.started.set()
        await self.complete.wait()
        yield {
            "method": "turn/completed",
            "params": {"threadId": "thread_1", "turnId": self.id},
        }
        self.terminal_delivered.set()
        await self.hold.wait()


@pytest.mark.parametrize("is_blocking", [False, True])
@pytest.mark.parametrize("stream_started", [False, True])
def test_recovery_fails_active_turn_and_closes_questionnaire(
    is_blocking: bool, stream_started: bool
) -> None:
    async def run() -> None:
        failed = NativeReadClient(closed=True)
        replacement = NativeReadClient()
        client = CodexSdkClient(failed, client_factory=lambda: replacement)
        host = FakeHost()
        runtime = CodexRuntime(config=_config(), host=host, client=client)
        await runtime.start()
        turn = LiveTurn()
        client._remember_turn("thread_1", turn)
        client._start_stream_task("thread_1", turn)
        try:
            await client._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "platformSessionId": "sess_1",
                        "threadId": "thread_1",
                        "turnId": "turn_1",
                    },
                }
            )
            await runtime._handle_notification(
                _input_request_notification(is_blocking=is_blocking)
            )
            async with asyncio.timeout(1):
                if stream_started:
                    await turn.started.wait()
                result = await client.list_threads(limit=1)

            assert result.threads == ()
            assert failed.stopped is True
            assert replacement.started is True
            assert failed.reads == replacement.reads == 1
            assert runtime._active_turn_ids == {}
            assert host.turn_ends == [
                {
                    "session_id": "sess_1",
                    "runtime": "codex",
                    "external_session_id": "thread_1",
                    "turn_id": "turn_1",
                    "outcome": "failed",
                    "metadata": {"source": "codex.turn/failed"},
                }
            ]
            questionnaire = next(
                notice
                for notice in reversed(host.notice_upserts)
                if notice.notice_id == "notice_codex_input_input_req_1"
            )
            assert questionnaire.status == "closed"
            assert questionnaire.context["inputStatus"] == "closed"
            assert questionnaire.response_required is False
            assert questionnaire.actions == ()
            assert host.state_updates[-1]["status"] == "error"
            assert host.state_updates[-1]["error"]["code"] == "codex_transport_closed"
            assert client._stream_tasks == {}
            assert client._turns == {}
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_recovery_does_not_fail_a_turn_that_already_emitted_terminal() -> None:
    async def run() -> None:
        client = CodexSdkClient(
            NativeReadClient(closed=True), client_factory=NativeReadClient
        )
        events: list[Any] = []

        async def handler(message: Any) -> None:
            events.append(message)

        await client.start(handler)
        turn = LiveTurn()
        client._remember_turn("thread_1", turn)
        client._start_stream_task("thread_1", turn)
        try:
            turn.complete.set()
            async with asyncio.timeout(1):
                await turn.terminal_delivered.wait()
                await client.list_threads(limit=1)
            methods = [
                event.get("method") if isinstance(event, dict) else event.event_type
                for event in events
            ]
            assert methods.count("turn/completed") == 1
            assert "turn/failed" not in methods
        finally:
            await client.stop()

    asyncio.run(run())


class PausedTerminalHost(FakeHost):
    def __init__(self, phase: str, *, fail_delivery: bool = False) -> None:
        super().__init__()
        self.phase = phase
        self.fail_delivery = fail_delivery
        self.paused = asyncio.Event()
        self.release = asyncio.Event()
        self.delivery_cancelled = False

    async def pause_delivery(self) -> None:
        self.paused.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.delivery_cancelled = True
            raise
        if self.fail_delivery:
            raise RuntimeError("fake host terminal delivery failed")

    async def notice_upsert(self, notice: Any) -> None:
        if self.phase == "notice" and notice.status == "closed":
            await self.pause_delivery()
        await super().notice_upsert(notice)

    async def session_state_update(self, *args: Any, **kwargs: Any) -> None:
        if self.phase == "state" and kwargs.get("status") == "idle":
            await self.pause_delivery()
        await super().session_state_update(*args, **kwargs)


@pytest.mark.parametrize("phase", ["notice", "state"])
@pytest.mark.parametrize("is_blocking", [False, True])
@pytest.mark.parametrize("recover", [False, True])
def test_terminal_delivery_finishes_before_recovery_or_shutdown(
    phase: str, is_blocking: bool, recover: bool
) -> None:
    async def run() -> None:
        failed = NativeReadClient(closed=True)
        replacement = NativeReadClient()
        client = CodexSdkClient(failed, client_factory=lambda: replacement)
        host = PausedTerminalHost(phase)
        runtime = CodexRuntime(config=_config(), host=host, client=client)
        await runtime.start()
        turn = LiveTurn()
        client._remember_turn("thread_1", turn)
        client._start_stream_task("thread_1", turn)
        stream_task = client._stream_tasks[turn.id]
        operation: asyncio.Task[Any] | None = None
        try:
            await client._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "platformSessionId": "sess_1",
                        "threadId": "thread_1",
                        "turnId": turn.id,
                    },
                }
            )
            await runtime._handle_notification(
                _input_request_notification(is_blocking=is_blocking)
            )
            turn.complete.set()
            async with asyncio.timeout(1):
                await host.paused.wait()
                operation = asyncio.create_task(
                    client.list_threads(limit=1) if recover else client.stop()
                )
                while not stream_task.cancelling():
                    await asyncio.sleep(0)
                assert failed.stopped is False
                assert operation.done() is False
                host.release.set()
                await operation

            assert host.delivery_cancelled is False
            assert [event["outcome"] for event in host.turn_ends] == ["completed"]
            assert runtime._active_turn_ids == {}
            questionnaire = next(
                notice
                for notice in reversed(host.notice_upserts)
                if notice.notice_id == "notice_codex_input_input_req_1"
            )
            assert questionnaire.status == "closed"
            assert questionnaire.context["inputStatus"] == "closed"
            assert questionnaire.response_required is False
            assert questionnaire.actions == ()
            assert host.state_updates[-1]["status"] == "idle"
            assert host.state_updates[-1]["error"] is None
            assert not any(
                notice.interaction_type == "execution_error"
                for notice in host.notice_upserts
            )
            assert failed.stopped is True
            if recover:
                assert replacement.started is True
                assert failed.reads == replacement.reads == 1
            assert client._stream_tasks == {}
            assert client._stream_states == {}
            assert client._turns == {}
        finally:
            host.release.set()
            if operation is not None:
                await asyncio.gather(operation, return_exceptions=True)
            await runtime.stop()

    asyncio.run(run())


def test_terminal_delivery_error_does_not_block_transport_cleanup() -> None:
    async def run() -> None:
        failed = NativeReadClient(closed=True)
        replacement = NativeReadClient()
        client = CodexSdkClient(failed, client_factory=lambda: replacement)
        host = PausedTerminalHost("state", fail_delivery=True)
        runtime = CodexRuntime(config=_config(), host=host, client=client)
        await runtime.start()
        turn = LiveTurn()
        client._remember_turn("thread_1", turn)
        client._start_stream_task("thread_1", turn)
        stream_task = client._stream_tasks[turn.id]
        operation: asyncio.Task[Any] | None = None
        unhandled_errors: list[dict[str, Any]] = []
        asyncio.get_running_loop().set_exception_handler(
            lambda loop, context: unhandled_errors.append(context)
        )
        try:
            await client._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "platformSessionId": "sess_1",
                        "threadId": "thread_1",
                        "turnId": turn.id,
                    },
                }
            )
            turn.complete.set()
            async with asyncio.timeout(1):
                await host.paused.wait()
                operation = asyncio.create_task(client.list_threads(limit=1))
                while not stream_task.cancelling():
                    await asyncio.sleep(0)
                host.release.set()
                result = await operation

            assert result.threads == ()
            assert host.delivery_cancelled is False
            assert [event["outcome"] for event in host.turn_ends] == ["completed"]
            assert failed.stopped is True
            assert replacement.started is True
            assert failed.reads == replacement.reads == 1
            assert client._stream_tasks == {}
            assert client._stream_states == {}
            assert client._turns == {}
            assert unhandled_errors == []
        finally:
            host.release.set()
            if operation is not None:
                await asyncio.gather(operation, return_exceptions=True)
            await runtime.stop()

    asyncio.run(run())


def test_terminal_delivery_error_without_recovery_is_observed() -> None:
    async def run() -> None:
        client = CodexSdkClient(NativeReadClient(), client_factory=NativeReadClient)
        host = PausedTerminalHost("state", fail_delivery=True)
        runtime = CodexRuntime(config=_config(), host=host, client=client)
        await runtime.start()
        turn = LiveTurn()
        client._remember_turn("thread_1", turn)
        client._start_stream_task("thread_1", turn)
        unhandled_errors: list[dict[str, Any]] = []
        asyncio.get_running_loop().set_exception_handler(
            lambda loop, context: unhandled_errors.append(context)
        )
        try:
            await client._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "platformSessionId": "sess_1",
                        "threadId": "thread_1",
                        "turnId": turn.id,
                    },
                }
            )
            turn.complete.set()
            async with asyncio.timeout(1):
                await host.paused.wait()
                host.release.set()
                while client._stream_tasks:
                    await asyncio.sleep(0)
            await asyncio.sleep(0)
            gc.collect()
            await asyncio.sleep(0)

            assert unhandled_errors == []
            assert [event["outcome"] for event in host.turn_ends] == ["completed"]
            assert host.state_updates[-1]["status"] == "running"
            assert runtime._active_turn_ids == {}
            assert client._stream_states == {}
            assert client._turns == {}
        finally:
            host.release.set()
            await runtime.stop()

    asyncio.run(run())


def test_shutdown_cancels_live_stream_without_transport_failure() -> None:
    async def run() -> None:
        client = CodexSdkClient(NativeReadClient(), client_factory=NativeReadClient)
        events: list[Any] = []

        async def handler(message: Any) -> None:
            events.append(message)

        await client.start(handler)
        turn = LiveTurn()
        client._remember_turn("thread_1", turn)
        client._start_stream_task("thread_1", turn)
        async with asyncio.timeout(1):
            await turn.started.wait()
            await client.stop()

        assert events == []
        assert client._stream_tasks == {}
        assert client._turns == {}

    asyncio.run(run())


def test_failed_replacement_read_is_not_retried_again() -> None:
    async def run() -> None:
        failed = NativeReadClient(closed=True)
        replacement = NativeReadClient(closed=True)
        replacements: list[NativeReadClient] = []

        def create_replacement() -> NativeReadClient:
            replacements.append(replacement)
            return replacement

        client = CodexSdkClient(failed, client_factory=create_replacement)

        async def handler(message: Any) -> None:
            pass

        await client.start(handler)
        try:
            with pytest.raises(BrokenPipeError):
                await client.list_threads(limit=1)
            assert failed.reads == replacement.reads == 1
            assert replacements == [replacement]
        finally:
            await client.stop()

    asyncio.run(run())
