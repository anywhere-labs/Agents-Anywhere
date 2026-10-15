"""Fixes found while running the IPC takeover against the real Codex App on Windows.

These run on every platform; the socket-based IPC suites are skipped on win32.
"""

from __future__ import annotations

import asyncio
from typing import Any

from test_codex_runtime import FakeCodexClient, FakeHost, _config

from connector.runtime_protocol import RuntimeSessionStateCache
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.domain.sessions import stable_session_id
from connector.runtimes.codex.ipc import control
from connector.runtimes.codex.ipc.client import CodexIpcClient, IpcRequest, IpcResponse
from connector.runtimes.codex.ipc.control import CodexIpcTurnController
from connector.runtimes.codex.ipc.follower import FollowedThread
from connector.runtimes.codex.ipc.owner import CodexIpcOwnerService
from connector.runtimes.codex.ipc.projection import CodexIpcSessionProjector
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.runtime_client import CodexTurnResult

THREAD = "019a0000-0000-7000-8000-0000000000d1"


def _history(*turns: tuple[str, str]) -> dict[str, Any]:
    return {
        "turnHistory": {
            "kind": "canonical",
            "history": {
                "islands": [{"entries": [{"key": key} for key, _ in turns]}],
                "entitiesByKey": {
                    key: {"turnId": turn_id, "status": "completed", "items": []}
                    for key, turn_id in turns
                },
            },
        }
    }


def test_projector_publishes_under_the_bound_session_id() -> None:
    async def scenario() -> None:
        host = FakeHost()
        states = RuntimeSessionStateCache("codex", host)
        projector = CodexIpcSessionProjector(
            host=host, session_states=states, notices=CodexNoticeRegistry()
        )
        assert projector.session_id_for(THREAD) == stable_session_id(
            getattr(host, "session_namespace", host.connector_id), THREAD
        )
        # A session AA created carries the server's id, not the derived one.
        await states.update(session_id="sess_bound", external_session_id=THREAD, status="idle")
        assert projector.session_id_for(THREAD) == "sess_bound"

    asyncio.run(scenario())


def test_state_cached_under_the_derived_id_is_rebound_to_the_server_binding() -> None:
    async def scenario() -> None:
        host = FakeHost()
        runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())
        derived = stable_session_id(getattr(host, "session_namespace", host.connector_id), THREAD)
        await runtime._session_states.update(
            session_id=derived,
            external_session_id=THREAD,
            status="idle",
            metadata={"source": "codex.ipc"},
        )

        # Before the fix the reply carried the derived id and the server answered
        # 502 "connector returned sessionId that does not match the session binding".
        state = await runtime.get_session_state("sess_bound", external_session_id=THREAD)

        assert state is not None and state.session_id == "sess_bound"
        rebound = runtime._session_states.get_by_external_session_id(THREAD)
        assert rebound is not None and rebound.session_id == "sess_bound"

    asyncio.run(scenario())


class TimeoutClient:
    """The App owner runs the turn but answers start-turn with its own timeout."""

    def __init__(self, follower: Any, *, turn_appears: bool) -> None:
        self.follower = follower
        self.turn_appears = turn_appears
        self.requests: list[str] = []

    async def request(self, method, params, **_kwargs):
        self.requests.append(method)
        if self.turn_appears:
            self.follower.thread = FollowedThread(
                THREAD,
                "following",
                owner_client_id="app",
                state=_history(("turn:old", "old"), ("turn:new", "new")),
            )
        return IpcResponse(
            request_id="r1", result_type="error", error="thread-follower-start-turn-timeout"
        )


class OneThreadFollower:
    def __init__(self) -> None:
        self.thread = FollowedThread(
            THREAD, "following", owner_client_id="app", state=_history(("turn:old", "old"))
        )

    def get(self, thread_id: str) -> FollowedThread | None:
        return self.thread if thread_id == THREAD else None


def _controller(*, turn_appears: bool):
    host = FakeHost()
    follower = OneThreadFollower()
    client = TimeoutClient(follower, turn_appears=turn_appears)
    states = RuntimeSessionStateCache("codex", host)
    controller = CodexIpcTurnController(
        client=client,  # type: ignore[arg-type]
        follower=follower,  # type: ignore[arg-type]
        host=host,
        session_states=states,
        active_turn_ids={},
        notices=CodexNoticeRegistry(),
        pending_messages=PendingClientMessageRegistry(connector_id="conn_test"),
    )
    return controller, client, follower, states


def test_start_turn_timeout_is_confirmed_by_the_new_turn_in_owner_state() -> None:
    async def scenario() -> None:
        controller, client, follower, states = _controller(turn_appears=True)
        result = await controller.start_turn("sess_1", follower.thread, "hi")
        assert result.ok
        assert result.result["turnId"] == "new"
        assert client.requests == ["thread-follower-start-turn"]
        state = states.get("sess_1")
        assert state is not None and state.status == "running"

    asyncio.run(scenario())


def test_start_turn_timeout_without_new_turn_is_unknown_not_an_error(monkeypatch) -> None:
    async def scenario() -> None:
        monkeypatch.setattr(control, "START_TURN_CONFIRM_TIMEOUT", 0.3)
        controller, client, follower, states = _controller(turn_appears=False)
        result = await controller.start_turn("sess_1", follower.thread, "hi")
        assert not result.ok
        assert result.code == "codex_ipc_start_turn_outcome_unknown"
        # Never resent, and the session is not flagged as failed.
        assert client.requests == ["thread-follower-start-turn"]
        state = states.get("sess_1")
        assert state is not None and state.status != "error"

    asyncio.run(scenario())


class RecordingClient:
    def __init__(self) -> None:
        self.broadcasts: list[tuple[str, Any]] = []

    async def broadcast(self, method, params, *, target_client_ids=None):
        self.broadcasts.append((method, params))


class StartingSdk:
    def __init__(self) -> None:
        self.started: list[Any] = []

    async def start_turn(self, request):
        self.started.append(request)
        return CodexTurnResult(turn_id=f"turn-{len(self.started)}", payload={})


def _owner():
    host = FakeHost()
    states = RuntimeSessionStateCache("codex", host)
    client, sdk = RecordingClient(), StartingSdk()
    active: dict[str, str] = {}
    owner = CodexIpcOwnerService(
        client=client,  # type: ignore[arg-type]
        sdk=sdk,  # type: ignore[arg-type]
        session_states=states,
        notices=CodexNoticeRegistry(),
        active_turn_ids=active,
        session_id_for=lambda thread_id: "sess_aa",
        host=host,
    )
    return owner, client, sdk, states, active


def _queue_request(method: str, **params: Any) -> IpcRequest:
    return IpcRequest(
        request_id="r", method=method, params={"conversationId": THREAD, **params},
        version=1, source_client_id="app",
    )


def _message(message_id: str, text: str) -> dict[str, Any]:
    return {"id": message_id, "text": text, "context": {"prompt": text}}


def test_window_follow_up_on_an_idle_aa_thread_is_sent_by_the_owner() -> None:
    async def scenario() -> None:
        owner, client, sdk, states, _ = _owner()
        await states.update(session_id="sess_aa", external_session_id=THREAD, status="idle")
        # The App window hands its queue to the owner instead of starting a turn.
        await owner._handle_follower(
            _queue_request(
                "thread-follower-set-queued-follow-ups-state",
                state={THREAD: [_message("m1", "收到")]},
                discardedMessageIds=[],
            )
        )
        assert [(r.content, r.client_message_id) for r in sdk.started] == [("收到", "m1")]
        assert [p["messages"] for _, p in client.broadcasts] == [[_message("m1", "收到")], []]
        assert all(m == "thread-queued-followups-changed" for m, _ in client.broadcasts)
        assert owner.queues == {}

    asyncio.run(scenario())


def test_follow_up_queued_while_running_is_sent_when_the_turn_ends() -> None:
    async def scenario() -> None:
        owner, _client, sdk, states, active = _owner()
        active["sess_aa"] = "turn-running"
        await states.update(session_id="sess_aa", external_session_id=THREAD, status="running")
        await owner._handle_follower(
            _queue_request(
                "thread-follower-set-queued-follow-ups-state",
                state={THREAD: [_message("m1", "next"), _message("m2", "skip")]},
                discardedMessageIds=["m2"],
            )
        )
        assert sdk.started == []
        assert owner.queues[THREAD] == [_message("m1", "next")]

        active.pop("sess_aa")
        idle = await states.update(session_id="sess_aa", external_session_id=THREAD, status="idle")
        owner.notify_state(idle)
        for _ in range(20):
            if sdk.started:
                break
            await asyncio.sleep(0.01)
        assert [r.content for r in sdk.started] == ["next"]
        assert owner.queues == {}

    asyncio.run(scenario())


def test_remove_and_clear_queued_messages() -> None:
    async def scenario() -> None:
        owner, _, sdk, states, active = _owner()
        active["sess_aa"] = "turn-running"
        await states.update(session_id="sess_aa", external_session_id=THREAD, status="running")
        await owner._handle_follower(
            _queue_request(
                "thread-follower-set-queued-follow-ups-state",
                state={THREAD: [_message("m1", "a"), _message("m2", "b")]},
                discardedMessageIds=[],
            )
        )
        removed = await owner._handle_follower(
            _queue_request("thread-follower-remove-queued-message", messageId="m1")
        )
        assert removed["removed"] is True
        cleared = await owner._handle_follower(
            _queue_request("thread-follower-clear-queued-messages")
        )
        assert [m["id"] for m in cleared["messages"]] == ["m2"]
        assert owner.queues == {} and sdk.started == []

    asyncio.run(scenario())


def test_pending_thread_settings_win_over_lagging_current_permissions() -> None:
    from connector.runtimes.codex.ipc.projection import ipc_settings_state

    # AA just switched the App thread to full access; currentPermissions keeps
    # the old mode until the next turn runs.
    flat = ipc_settings_state(
        {
            "latestModel": "gpt-old",
            "latestThreadSettings": {
                "model": "gpt-new",
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            },
            "currentPermissions": {
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": []},
            },
        }
    )
    assert flat["model"] == "gpt-new"
    assert flat["approvalPolicy"] == "never"
    assert flat["sandboxPolicy"] == {"type": "dangerFullAccess"}
    assert flat["approvalsReviewer"] == "user"


def test_switching_back_to_workspace_write_keeps_the_apps_writable_roots() -> None:
    from connector.runtimes.codex.ipc.control import thread_settings_with_overrides

    settings = thread_settings_with_overrides(
        {
            "cwd": "E:/AA",
            "latestThreadSettings": {"sandboxPolicy": {"type": "dangerFullAccess"}},
            "currentPermissions": {
                "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": ["C:/codex/vis/t1"]},
            },
        },
        model=None,
        effort=None,
        approval_policy="on-request",
        approvals_reviewer=None,
        sandbox="workspace-write",
    )
    assert settings["sandboxPolicy"]["writableRoots"] == ["C:/codex/vis/t1"]
    assert "permissions" not in settings


def test_thread_an_owner_announces_after_startup_is_followed_without_restart(tmp_path) -> None:
    from connector.runtimes.codex.ipc.client import CodexIpcClient, IpcBroadcast
    from connector.runtimes.codex.ipc.service import CodexIpcService

    async def scenario() -> None:
        client = CodexIpcClient(codex_home=tmp_path)
        client.client_id = "aa"

        async def on_event(event) -> None:
            return None

        service = CodexIpcService(client=client, codex_home=tmp_path, on_event=on_event)
        # The App creates a thread after the startup scan and asks for followers.
        await service._on_any_broadcast(
            IpcBroadcast(
                method="thread-stream-following-status-requested",
                source_client_id="app",
                params={"conversationId": THREAD, "hostId": "local"},
                version=1,
            )
        )
        assert service._extra_candidates == {THREAD}
        assert service._wake.is_set()  # request_scan() wakes the scan loop

        # An already followed thread is left alone.
        service._extra_candidates.clear()
        service._wake.clear()
        service.follower._threads[THREAD] = FollowedThread(
            THREAD, "following", owner_client_id="app", state={}
        )
        await service._on_any_broadcast(
            IpcBroadcast(
                method="thread-stream-following-status-requested",
                source_client_id="app",
                params={"conversationId": THREAD, "hostId": "local"},
                version=1,
            )
        )
        assert service._extra_candidates == set() and not service._wake.is_set()

    asyncio.run(scenario())


def test_thread_aa_creates_is_announced_to_the_app_sidebar() -> None:
    async def scenario() -> None:
        owner, client, _, states, _ = _owner()

        async def step(status: str, source: str) -> None:
            state = await states.update(
                session_id="sess_aa", external_session_id=THREAD, status=status,
                metadata={"source": source},
            )
            owner.notify_state(state)
            await asyncio.sleep(0.01)

        await step("idle", "codex.thread/start")
        await step("waiting", "codex.turn/start.requested")
        await step("running", "codex.turn/started")
        await step("idle", "codex.turn/completed")
        await step("running", "codex.turn/started")
        announced = [p for m, p in client.broadcasts if m == "thread-unarchived"]
        # Once when the rollout exists, once more to pick up the title; never again.
        assert announced == [{"hostId": "local", "conversationId": THREAD}] * 2

    asyncio.run(scenario())


def test_thread_aa_only_resumed_is_not_announced() -> None:
    async def scenario() -> None:
        owner, client, _, states, _ = _owner()
        # A thread the user archived in the App must not reappear because AA
        # resumed it: only threads AA started are announced.
        for status, source in (("running", "codex.turn/started"), ("idle", "codex.turn/completed")):
            state = await states.update(
                session_id="sess_aa", external_session_id=THREAD, status=status,
                metadata={"source": source},
            )
            owner.notify_state(state)
            await asyncio.sleep(0.01)
        assert [m for m, _ in client.broadcasts if m == "thread-unarchived"] == []

    asyncio.run(scenario())


# -- Windows: the client needs the proactor loop, not just the platform ----------


def test_windows_client_is_disabled_on_a_loop_without_pipe_support(tmp_path, monkeypatch) -> None:
    async def run() -> None:
        # The selector loop (and every loop outside Windows) has no
        # create_pipe_connection, which is what the named-pipe client needs.
        assert not hasattr(asyncio.get_running_loop(), "create_pipe_connection")
        monkeypatch.setattr("connector.runtimes.codex.ipc.client.sys.platform", "win32")
        client = CodexIpcClient(codex_home=tmp_path, reconnect_delay=0.01)
        await client.start()
        assert client._task is None
        await client.stop()

    asyncio.run(run())
