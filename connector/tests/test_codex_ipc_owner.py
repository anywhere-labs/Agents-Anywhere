from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeSessionStateCache, SessionNotice
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    CodexIpcOwnerService,
    IpcRouter,
    conversation_state_from_thread,
)
from connector.runtimes.codex.sdk.runtime_client import (
    CodexInterruptTurnRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexThreadReadResult,
    CodexThreadTurnsResult,
    CodexTurnResult,
)

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD = "01a124e5-815c-7e42-aea7-25d46a8450c3"
OTHER = "01a12048-c50d-7cb3-9de3-f0a61be677b8"


def _raw_thread() -> dict[str, Any]:
    return {
        "id": THREAD,
        "name": "测试线程",
        "cwd": "/tmp/project",
        "model": "gpt-6.1-sol",
        "reasoningEffort": "high",
        "modelProvider": "openai",
        "originator": "agents-anywhere",
        "source": "cli",
        "createdAt": 1791620383,
        "updatedAt": 1791621499,
        "turns": [],
    }


def _raw_turns() -> tuple[dict[str, Any], ...]:
    return (
        {
            "id": "turn-1",
            "status": "completed",
            "startedAt": 1791620383,
            "durationMs": 3392,
            "items": [
                {"type": "userMessage", "id": "um-1", "clientId": "cm-1", "content": [{"type": "text", "text": "你好"}]},
                {"type": "agentMessage", "id": "msg-1", "text": "你好！", "phase": "final_answer"},
            ],
        },
        {
            "id": "turn-2",
            "status": "inProgress",
            "items": [{"type": "userMessage", "id": "um-2", "content": [{"type": "text", "text": "再来"}]}],
        },
    )


# -- conversationState -----------------------------------------------------------


def test_conversation_state_from_thread_builds_v11_shape() -> None:
    raw = _raw_thread()
    raw["turns"] = list(_raw_turns())
    state = conversation_state_from_thread(
        raw,
        thread_id=THREAD,
        host_id="local",
        runtime_status="running",
        requests=[{"method": "item/commandExecution/requestApproval", "requestId": 3, "params": {}}],
        active_turn_id="turn-2",
        now=lambda: 1_791_700_000.0,
    )
    assert state["id"] == THREAD and state["hostId"] == "local"
    assert state["title"] == "测试线程" and state["cwd"] == "/tmp/project"
    assert state["threadRuntimeStatus"] == {"type": "active", "activeFlags": []}
    assert state["resumeState"] == "resumed" and state["historyMode"] == "paginated"
    assert state["requests"][0]["requestId"] == 3
    history = state["turnHistory"]["history"]
    assert [e["key"] for e in history["islands"][0]["entries"]] == ["turn:turn-1", "turn:turn-2"]
    first = history["entitiesByKey"]["turn:turn-1"]
    assert first["status"] == "completed" and first["turnId"] == "turn-1"
    assert first["params"]["input"] == [{"type": "text", "text": "你好"}]
    assert first["params"]["clientUserMessageId"] == "cm-1"
    assert first["completedItemIds"] == {"um-1": True, "msg-1": True}
    assert first["turnStartedAtMs"] == 1791620383000
    second = history["entitiesByKey"]["turn:turn-2"]
    assert second["status"] == "inProgress" and second["completedItemIds"] == {}
    assert state["turnsPagination"]["oldestLoadedTurnId"] == "turn-1"
    assert state["latestCollaborationMode"]["settings"]["model"] == "gpt-6.1-sol"
    assert state["createdAt"] == 1791620383000 and state["updatedAt"] == 1791621499000
    assert state["environments"][0]["cwd"] == "/tmp/project"
    for key in ("latestModel", "currentPermissions", "turnsPagination", "paginatedHistory", "hasUnreadTurn", "turns"):
        assert key in state

    idle = conversation_state_from_thread(
        _raw_thread(), thread_id=THREAD, host_id="local", runtime_status="waiting_approval", requests=[], active_turn_id=None
    )
    assert idle["threadRuntimeStatus"] == {"type": "active", "activeFlags": ["waitingOnApproval"]}
    assert idle["turnHistory"]["history"]["islands"][0]["entries"] == []
    assert idle["turnsPagination"]["oldestLoadedTurnId"] is None


# -- fakes ---------------------------------------------------------------------


class _TempHome:
    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="aa-ipco-", dir="/tmp"))
        return self.path

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


class _Host(RuntimeHostClient):
    def __init__(self) -> None:
        self.notices: list[SessionNotice] = []
        self.states: list[Any] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def notice_upsert(self, notice):
        self.notices.append(notice)

    async def session_state_update(self, *args, **kwargs):
        self.states.append(kwargs)


class FakeSdk:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.turns = list(_raw_turns())
        self.fail_turns_list = False

    async def read_thread(self, thread_id: str, include_turns: bool = True) -> CodexThreadReadResult:
        self.calls.append(("read_thread", (thread_id, include_turns)))
        raw = _raw_thread()
        if include_turns:
            raw["turns"] = list(self.turns)
        return CodexThreadReadResult(thread=raw)

    async def list_thread_turns(self, thread_id: str) -> CodexThreadTurnsResult:
        self.calls.append(("list_thread_turns", thread_id))
        if self.fail_turns_list:
            raise RuntimeError("legacy thread")
        return CodexThreadTurnsResult(turns=tuple(self.turns))

    async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
        self.calls.append(("start_turn", request))
        return CodexTurnResult(turn_id="turn-3", payload={"turn": {"id": "turn-3", "status": "inProgress", "items": []}})

    async def steer_turn(self, request: CodexSteerTurnRequest) -> CodexTurnResult:
        self.calls.append(("steer_turn", request))
        return CodexTurnResult(turn_id=request.turn_id, payload={"turn": {"id": request.turn_id}})

    async def interrupt_turn(self, request: CodexInterruptTurnRequest) -> CodexTurnResult:
        self.calls.append(("interrupt_turn", request))
        return CodexTurnResult(turn_id=request.turn_id, payload={})

    async def respond(self, request_id, result=None):
        self.calls.append(("respond", (request_id, dict(result or {}))))

    async def compact_thread(self, thread_id: str):
        self.calls.append(("compact", thread_id))


def _client(home: Path, path: Path, client_type: str) -> CodexIpcClient:
    return CodexIpcClient(codex_home=home, socket_path=path, allow_router=False, reconnect_delay=0.05, request_timeout_ms=3000, client_type=client_type)


async def _wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


class Window:
    """A Codex window following a thread the Connector owns."""

    def __init__(self, client: CodexIpcClient) -> None:
        self.client = client
        self.snapshots: list[Mapping[str, Any]] = []
        client.add_broadcast_handler("thread-stream-state-changed", self._on_state)

    async def _on_state(self, broadcast):
        change = broadcast.params["change"]
        if change["type"] == "snapshot":
            self.snapshots.append({"revision": change["revision"], "state": change["conversationState"], "from": broadcast.source_client_id})


def test_owner_serves_discovery_snapshots_and_follower_requests() -> None:
    async def run() -> None:
        with _TempHome() as home:
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            connector_client = _client(home, path, "agents-anywhere")
            window_client = _client(home, path, "vscode")
            for c in (connector_client, window_client):
                await c.start()
                await c.wait_until_initialized(timeout=2)

            host = _Host()
            states = RuntimeSessionStateCache("codex", host)
            notices = CodexNoticeRegistry()
            active: dict[str, str] = {}
            sdk = FakeSdk()
            session_id = codex_sessions.stable_session_id("conn_test", THREAD)
            owner = CodexIpcOwnerService(
                client=connector_client,
                sdk=sdk,  # type: ignore[arg-type]
                session_states=states,
                notices=notices,
                active_turn_ids=active,
                session_id_for=lambda tid: codex_sessions.stable_session_id("conn_test", tid),
                is_followed_elsewhere=lambda tid: tid == OTHER,
                host=host,
                publish_delay=0.05,
            )
            owner.attach()

            # Not owned yet: no state from our app-server.
            window = Window(window_client)
            missing = await window_client.request("thread-owner-discovery", {"hostId": "local", "conversationId": THREAD})
            assert missing.error == "no-client-found"

            await states.update(session_id, THREAD, status="running", metadata={"source": "codex.turn/started"})
            active[session_id] = "turn-2"
            assert owner.owns(THREAD)
            assert not owner.owns(OTHER)

            found = await window_client.request("thread-owner-discovery", {"hostId": "local", "conversationId": THREAD})
            assert found.ok and found.handled_by_client_id == connector_client.client_id
            assert found.result == {"supportsUntrustedAppInput": False}

            await window_client.broadcast(
                "thread-stream-following-changed",
                {"conversationId": THREAD, "hostId": "local", "following": True},
                target_client_ids=[connector_client.client_id or ""],
            )
            await _wait_for(lambda: len(window.snapshots) == 1)
            snap = window.snapshots[0]
            assert snap["revision"] == 1 and snap["from"] == connector_client.client_id
            assert snap["state"]["threadRuntimeStatus"] == {"type": "active", "activeFlags": []}
            assert snap["state"]["turnHistory"]["history"]["entitiesByKey"]["turn:turn-2"]["status"] == "inProgress"
            assert owner.owned_threads_with_followers() == [THREAD]

            # Window drives the thread through follower requests.
            started = await window_client.request(
                "thread-follower-start-turn",
                {"conversationId": THREAD, "turnStart": {"request": {"threadId": THREAD, "input": [{"type": "text", "text": "来自窗口"}], "clientUserMessageId": "w-1"}, "context": {}}},
                target_client_id=connector_client.client_id,
            )
            assert started.ok and started.result["result"]["turn"]["id"] == "turn-3"
            start_call = next(c for c in sdk.calls if c[0] == "start_turn")[1]
            assert start_call.content == "来自窗口" and start_call.client_message_id == "w-1"
            await _wait_for(lambda: len(window.snapshots) == 2)  # republished after the request

            steered = await window_client.request(
                "thread-follower-steer-turn",
                {"conversationId": THREAD, "input": [{"type": "text", "text": "补充"}], "clientUserMessageId": "w-2"},
                target_client_id=connector_client.client_id,
            )
            assert steered.ok
            assert next(c for c in sdk.calls if c[0] == "steer_turn")[1].turn_id == "turn-2"

            interrupted = await window_client.request(
                "thread-follower-interrupt-turn",
                {"conversationId": THREAD, "mode": "user-stop", "expectedTurnId": "turn-2"},
                target_client_id=connector_client.client_id,
            )
            assert interrupted.ok and interrupted.result["interruptedTurnId"] == "turn-2"

            notice = SessionNotice(
                notice_id="notice_approval_1",
                session_id=session_id,
                runtime="codex",
                type="interaction",
                title="approve",
                interaction_type="approval",
                blocking={"scope": "session", "targetId": session_id},
                response_required=True,
                context={"approvalSource": {"requestId": 42, "method": "item/commandExecution/requestApproval", "threadId": THREAD}, "command": "ls"},
            )
            notices.upsert(notice)
            state = await owner.build_conversation_state(THREAD)
            assert state["requests"][0]["requestId"] == 42 and state["requests"][0]["params"]["command"] == "ls"
            decided = await window_client.request(
                "thread-follower-command-approval-decision",
                {"conversationId": THREAD, "requestId": 42, "decision": "accept"},
                target_client_id=connector_client.client_id,
            )
            assert decided.ok
            assert ("respond", (42, {"decision": "accept"})) in sdk.calls
            assert notices.get("notice_approval_1").status == "resolved"
            assert host.notices[-1].status == "resolved"

            history = await window_client.request(
                "thread-follower-load-complete-history", {"conversationId": THREAD}, target_client_id=connector_client.client_id
            )
            assert history.ok and history.result["revision"] >= 3

            settings = await window_client.request(
                "thread-follower-read-model-settings", {"conversationId": THREAD}, target_client_id=connector_client.client_id
            )
            assert settings.result["settings"]["model"] == "gpt-6.1-sol"

            # State changes republish to followers (debounced).
            before = len(window.snapshots)
            await states.update(session_id, THREAD, status="idle", metadata={"source": "codex.turn/completed"})
            owner.notify_state(states.get(session_id))
            owner.notify_state(states.get(session_id))
            await _wait_for(lambda: len(window.snapshots) == before + 1)
            assert window.snapshots[-1]["state"]["threadRuntimeStatus"] == {"type": "idle"}

            # Legacy threads without paginated turns fall back to a full read.
            sdk.fail_turns_list = True
            legacy = await owner.build_conversation_state(THREAD)
            assert "turn:turn-1" in legacy["turnHistory"]["history"]["entitiesByKey"]

            await window_client.broadcast(
                "thread-stream-following-changed",
                {"conversationId": THREAD, "hostId": "local", "following": False},
                target_client_ids=[connector_client.client_id or ""],
            )
            await _wait_for(lambda: owner.owned_threads_with_followers() == [])

            owner.detach()
            await window_client.stop()
            await connector_client.stop()
            await router.close()

    asyncio.run(run())
