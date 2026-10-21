"""Real SDK stdio transport, with only the app-server process replaced."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import openai_codex
import pytest
from openai_codex import (
    AsyncCodex,
    CodexConfig,
    MethodNotFoundError,
    TransportClosedError,
)
from pydantic import RootModel

from connector.runtime_protocol import RuntimeConflictError, RuntimeInvalidRequestError
from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import (
    CodexInterruptTurnRequest,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
)

SERVER = r"""
import json, sys, time
from pathlib import Path
root = Path(sys.argv[1])
pending = {}
def send(value):
    print(json.dumps(value), flush=True)
def thread(id):
    return {"id":id,"cliVersion":"0.144.4","createdAt":1,"cwd":str(root),
        "ephemeral":False,"modelProvider":"openai","preview":"","sessionId":"session","source":"appServer",
        "status":{"type":"idle"},"turns":[],"updatedAt":2}
def turn(id, status="inProgress"):
    return {"id":id,"status":status,"items":[],"completedAt":None,"durationMs":None,
        "error":None,"itemsView":None,"startedAt":None}
for line in sys.stdin:
    request = json.loads(line)
    with (root / "requests.jsonl").open("a") as log:
        log.write(json.dumps(request) + "\n")
    if "id" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    config = json.loads((root / "control.json").read_text())
    if method in config.get("disconnect", []):
        sys.exit(0)
    if method in config.get("hang", []):
        continue
    if method in config.get("errors", {}):
        send({"id":request["id"],"error":config["errors"][method]})
        continue
    for event in config.get("before", {}).get(method, []):
        send(event)
    if method in config.get("before", {}):
        time.sleep(0.04)
    if method == "initialize":
        result = {"userAgent":"codex/0.144.4"}
    elif method in ("thread/start", "thread/resume"):
        result = {"thread":thread(params.get("threadId", "thread")),"model":"native-model",
            "modelProvider":"openai","reasoningEffort":None,"cwd":str(root),
            "approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"}}
        result.update(config.get("resume", {}))
        if "resume_thread_id" in config:
            result["thread"]["id"] = config["resume_thread_id"]
        for key in config.get("omit_resume", []):
            result.pop(key, None)
    elif method == "turn/start":
        result = {"turn":turn("ordinary")}
    elif method == "turn/steer":
        result = {"turnId":params["expectedTurnId"]}
    else:
        result = {}
    result = config.get("results", {}).get(method, result)
    response = {"id":request["id"],"result":result}
    if method in config.get("hold", []):
        pending[method] = response
        continue
    send(response)
    for held in config.get("release_after", {}).get(method, []):
        send(pending.pop(held))
"""


class Wire:
    def __init__(self, root: Path):
        self.root = root
        self.configure()
        self.events: list[CodexSdkEvent] = []

    def configure(self, **values):
        (self.root / "control.json").write_text(json.dumps(values))

    @property
    def requests(self):
        return [
            json.loads(line)
            for line in (self.root / "requests.jsonl").read_text().splitlines()
        ]

    def calls(self, method):
        return [
            request["params"]
            for request in self.requests
            if request["method"] == method
        ]

    async def flush(self, sdk):
        """Let the fake server deliver configured events and pending replies."""
        await sdk._client.request("test/notify", {}, response_model=RootModel[dict])

    async def notified(self, count):
        async with asyncio.timeout(2):
            while len(self.events) < count:
                await asyncio.sleep(0.001)


@asynccontextmanager
async def fixture(tmp_path):
    wire = Wire(tmp_path)
    server = tmp_path / "app_server.py"
    server.write_text(SERVER)
    sdk = AsyncCodex(
        CodexConfig(
            launch_args_override=(sys.executable, "-u", str(server), str(tmp_path))
        )
    )
    client = CodexSdkClient(sdk, sdk=openai_codex)

    async def receive(message):
        wire.events.append(
            message
            if isinstance(message, CodexSdkEvent)
            else CodexSdkEvent.from_value(message)
        )

    await client.start(receive)
    try:
        yield client, wire, sdk
    finally:
        await client.stop()


def assert_no_native_turn_buffers(sdk):
    router = sdk._client._sync._router
    assert router._turn_notifications == {}
    if hasattr(router, "_turn_states"):
        # SDK 0.158 tracks retained events and subscribers together. Neither may
        # remain after an ordinary stream or for a globally observed command.
        assert router._turn_states == {}
        assert router._pending_turn_requests == {}
    else:
        assert router._pending_turn_notifications == {}


def test_stop_with_active_ordinary_stream_releases_sdk_worker_process(tmp_path):
    Wire(tmp_path)
    server = tmp_path / "app_server.py"
    server.write_text(SERVER)
    probe = r"""
import asyncio, faulthandler, sys
import openai_codex
from openai_codex import AsyncCodex, CodexConfig
from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import CodexStartTurnRequest

faulthandler.dump_traceback_later(3)
async def run():
    sdk = AsyncCodex(CodexConfig(
        launch_args_override=(sys.executable, "-u", sys.argv[1], sys.argv[2])
    ))
    client = CodexSdkClient(sdk, sdk=openai_codex)
    events = []
    async def receive(message):
        events.append(CodexSdkEvent.from_value(message).event_type)
    await client.start(receive)
    loop = asyncio.get_running_loop()
    waiting = asyncio.Event()
    next_notification = sdk._client._sync.next_turn_notification
    def observed_next(turn_id):
        loop.call_soon_threadsafe(waiting.set)
        return next_notification(turn_id)
    sdk._client._sync.next_turn_notification = observed_next
    await client.start_turn(CodexStartTurnRequest("thread", "hello"))
    await asyncio.wait_for(waiting.wait(), 2)
    await asyncio.sleep(0.02)
    # Exercise production shutdown directly: no router.fail_all test helper.
    await client.stop()
    assert client._stream_tasks == {}
    assert sdk._client._sync._router._turn_notifications == {}
    assert events == ["turn/started"], events
asyncio.run(run())
print("asyncio.run exited")
"""
    result = subprocess.run(
        [sys.executable, "-c", probe, str(server), str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=8,
        check=True,
    )
    assert "asyncio.run exited" in result.stdout
    assert "Task exception was never retrieved" not in result.stderr


def lifecycle(turn_id, *, completed=False):
    return {
        "method": "turn/completed" if completed else "turn/started",
        "params": {
            "threadId": "thread",
            "turn": {
                "id": turn_id,
                "status": "completed" if completed else "inProgress",
                "items": [],
                "completedAt": None,
                "durationMs": None,
                "error": None,
                "itemsView": None,
                "startedAt": None,
            },
        },
    }


@pytest.mark.parametrize("start", [False, True])
def test_compact_acquires_native_writer_once_without_starting_a_user_turn(
    tmp_path, start
):
    async def run():
        async with fixture(tmp_path) as (client, wire, _):
            if start:
                await client.start_thread(CodexStartThreadRequest())
            await client.compact_thread("thread")
            await client.compact_thread("thread")
            assert len(wire.calls("thread/resume")) == (0 if start else 1)
            assert wire.calls("thread/compact/start") == [{"threadId": "thread"}] * 2
            assert not wire.calls("turn/start")

    asyncio.run(run())


def test_native_writer_conflict_prevents_compaction(tmp_path):
    async def run():
        async with fixture(tmp_path) as (client, wire, _):
            wire.configure(
                errors={
                    "thread/resume": {
                        "code": -32600,
                        "message": "thread already has an active writer",
                    }
                }
            )
            with pytest.raises(RuntimeConflictError):
                await client.compact_thread("thread")
            assert not wire.calls("thread/compact/start")
            assert not wire.calls("turn/start")

    asyncio.run(run())


def test_wrong_resume_identity_cannot_grant_writer_or_send_command(tmp_path):
    async def run():
        async with fixture(tmp_path) as (client, wire, _):
            wire.configure(resume_thread_id="another-thread")
            with pytest.raises(RuntimeError, match="identity"):
                await client.compact_thread("thread")
            assert not wire.calls("thread/compact/start")
            wire.configure()
            await client.compact_thread("thread")
            assert len(wire.calls("thread/resume")) == 2

    asyncio.run(run())


def test_unsupported_native_compact_method_remains_a_visible_rejection(tmp_path):
    async def run():
        async with fixture(tmp_path) as (client, wire, _):
            wire.configure(
                errors={
                    "thread/compact/start": {
                        "code": -32601,
                        "message": "unsupported method",
                    }
                }
            )
            with pytest.raises(MethodNotFoundError):
                await client.compact_thread("thread")
            assert len(wire.calls("thread/compact/start")) == 1
            assert not wire.calls("turn/start")

    asyncio.run(run())


@pytest.mark.parametrize("disconnect", [False, True])
def test_postdispatch_transport_loss_or_timeout_never_replays_command(
    tmp_path, disconnect
):
    async def run():
        async with fixture(tmp_path) as (client, wire, _):
            wire.configure(
                **{"disconnect" if disconnect else "hang": ["thread/compact/start"]}
            )
            with pytest.raises((TimeoutError, TransportClosedError)):
                async with asyncio.timeout(0.5):
                    await client.compact_thread("thread")
            assert len(wire.calls("thread/compact/start")) == 1

    asyncio.run(run())


def test_compact_turns_before_ack_remain_visible_and_interruptible(
    tmp_path,
):
    async def run():
        async with fixture(tmp_path) as (client, wire, sdk):
            wire.configure(before={"thread/compact/start": [lifecycle("compact-1")]})
            await client.compact_thread("thread")
            await wire.notified(1)
            await client.interrupt_turn(
                CodexInterruptTurnRequest("thread", "compact-1")
            )
            wire.configure(
                before={
                    "test/notify": [
                        lifecycle("compact-2"),
                        lifecycle("compact-1", completed=True),
                    ]
                }
            )
            await wire.flush(sdk)
            await wire.notified(3)
            with pytest.raises(RuntimeInvalidRequestError):
                await client.interrupt_turn(
                    CodexInterruptTurnRequest("thread", "compact-1")
                )
            await client.interrupt_turn(
                CodexInterruptTurnRequest("thread", "compact-2")
            )
            assert wire.calls("turn/interrupt") == [
                {"threadId": "thread", "turnId": "compact-1"},
                {"threadId": "thread", "turnId": "compact-2"},
            ]
            assert [event.event_type for event in wire.events] == [
                "turn/started",
                "turn/started",
                "turn/completed",
            ]
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


def test_fast_compact_completion_before_ack_does_not_resurrect_a_turn(tmp_path):
    async def run():
        async with fixture(tmp_path) as (client, wire, sdk):
            wire.configure(
                before={
                    "thread/compact/start": [
                        lifecycle("compact"),
                        lifecycle("compact", completed=True),
                    ]
                }
            )
            await client.compact_thread("thread")
            await wire.notified(2)
            with pytest.raises(RuntimeInvalidRequestError):
                await client.interrupt_turn(
                    CodexInterruptTurnRequest("thread", "compact")
                )
            assert len(wire.events) == 2
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


def test_ordinary_turn_after_command_keeps_one_stream_and_no_native_queue_leak(
    tmp_path,
):
    async def run():
        async with fixture(tmp_path) as (client, wire, sdk):
            await client.compact_thread("thread")
            wire.configure(
                before={
                    "turn/start": [
                        lifecycle("ordinary"),
                        lifecycle("ordinary", completed=True),
                    ]
                }
            )
            await client.start_turn(CodexStartTurnRequest("thread", "hello"))
            await wire.notified(2)
            await asyncio.sleep(0.02)
            assert [event.event_type for event in wire.events] == [
                "turn/started",
                "turn/completed",
            ]
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


def test_first_command_during_ordinary_turn_preserves_its_stream_and_interrupt(
    tmp_path,
):
    async def run():
        async with fixture(tmp_path) as (client, wire, sdk):
            wire.configure(before={"turn/start": [lifecycle("ordinary")]})
            await client.start_turn(CodexStartTurnRequest("thread", "hello"))
            await wire.notified(1)
            wire.configure()
            await client.compact_thread("thread")
            await client.interrupt_turn(CodexInterruptTurnRequest("thread", "ordinary"))
            await client.steer_turn(
                CodexSteerTurnRequest("thread", "ordinary", "use the existing turn")
            )
            wire.configure(
                before={
                    "test/notify": [
                        {
                            "method": "item/agentMessage/delta",
                            "params": {
                                "threadId": "thread",
                                "turnId": "ordinary",
                                "itemId": "answer",
                                "delta": "answer",
                            },
                        },
                        lifecycle("ordinary", completed=True),
                    ]
                }
            )
            await wire.flush(sdk)
            await wire.notified(3)
            await asyncio.sleep(0.01)
            assert [event.event_type for event in wire.events] == [
                "turn/started",
                "item/agentMessage/delta",
                "turn/completed",
            ]
            assert wire.calls("turn/interrupt") == [
                {"threadId": "thread", "turnId": "ordinary"}
            ]
            assert wire.calls("turn/steer") == [
                {
                    "threadId": "thread",
                    "expectedTurnId": "ordinary",
                    "input": [{"type": "text", "text": "use the existing turn"}],
                }
            ]
            assert client._stream_tasks == {}
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


def test_first_command_while_ordinary_start_ack_is_pending_preserves_early_events(
    tmp_path,
):
    async def run():
        async with fixture(tmp_path) as (client, wire, sdk):
            wire.configure(
                hold=["turn/start"],
                release_after={"thread/compact/start": ["turn/start"]},
                before={
                    "turn/start": [lifecycle("ordinary")],
                    "thread/compact/start": [
                        {
                            "method": "item/agentMessage/delta",
                            "params": {
                                "threadId": "thread",
                                "turnId": "ordinary",
                                "itemId": "answer",
                                "delta": "early",
                            },
                        }
                    ],
                },
            )
            starting = asyncio.create_task(
                client.start_turn(CodexStartTurnRequest("thread", "hello"))
            )
            async with asyncio.timeout(2):
                while not wire.calls("turn/start"):
                    await asyncio.sleep(0.001)
            await client.compact_thread("thread")
            await starting
            wire.configure(
                before={"test/notify": [lifecycle("ordinary", completed=True)]}
            )
            await wire.flush(sdk)
            await wire.notified(3)
            assert [event.event_type for event in wire.events] == [
                "turn/started",
                "item/agentMessage/delta",
                "turn/completed",
            ]
            assert client._stream_tasks == {}
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


@pytest.mark.parametrize("disconnect", [False, True])
def test_stop_and_disconnect_invalidate_native_writer_and_turn_ownership(
    tmp_path, disconnect
):
    async def run():
        async with fixture(tmp_path) as (client, wire, sdk):
            wire.configure(before={"thread/compact/start": [lifecycle("compact")]})
            await client.compact_thread("thread")
            await wire.notified(1)
            if disconnect:
                wire.configure(disconnect=["test/notify"])
                with pytest.raises(TransportClosedError):
                    await wire.flush(sdk)
                async with asyncio.timeout(2):
                    while client._loaded_thread_ids:
                        await asyncio.sleep(0.001)
            else:
                await client.stop()
            assert client._loaded_thread_ids == set()
            assert client._threads == {} and client._turns == {}

    asyncio.run(run())
