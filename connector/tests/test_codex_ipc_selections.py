from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from openai_codex.generated.v2_all import Thread

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.catalogs import (
    codex_permission_catalog_items,
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
)
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.domain.selections import selections_from_thread_state
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    CodexIpcOwnerService,
    CodexIpcSessionProjector,
    CodexIpcTurnController,
    FollowedThread,
    FollowerEvent,
    IpcRequest,
    IpcRouter,
    ThreadFollower,
    conversation_state_from_thread,
)
from connector.runtimes.codex.ipc.control import thread_settings_with_overrides
from connector.runtimes.codex.ipc.projection import ipc_settings_state
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sessions.reader import thread_state_from_sdk_thread

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD = "01a124e5-815c-7e42-aea7-25d46a8450c3"

MODEL_CATALOG = model_catalog_from_codex_items(
    [
        {
            "id": "gpt-6.1-sol",
            "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}],
        },
        {"id": "gpt-5.5", "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]},
    ],
    revision=1,
)
PERMISSION_CATALOG = permission_catalog_from_codex_items(codex_permission_catalog_items(), revision=1)


async def read_models() -> RuntimeModelCatalog:
    return MODEL_CATALOG


async def read_permissions() -> RuntimePermissionCatalog:
    return PERMISSION_CATALOG


def _selection(model: str, effort: str) -> str:
    for item in MODEL_CATALOG.models:
        if item.id == model:
            for reasoning in item.reasoning_items:
                if reasoning.id == effort:
                    assert reasoning.selection_id is not None
                    return reasoning.selection_id
    raise AssertionError("unknown model/effort")


def _permission(permission_id: str) -> str:
    for item in PERMISSION_CATALOG.permissions:
        if item.id == permission_id:
            return item.selection_id
    raise AssertionError("unknown permission")


def _state(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": THREAD,
        "title": "回应问候",
        "cwd": "/tmp/project",
        "threadRuntimeStatus": {"type": "idle"},
        "requests": [],
        "latestModel": "gpt-6.1-sol",
        "latestReasoningEffort": "high",
        "latestCollaborationMode": {"mode": "default", "settings": {"model": "gpt-6.1-sol", "reasoning_effort": "high"}},
        "latestThreadSettings": {
            "disabledPluginIds": [],
            "cwd": "/tmp/project",
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "sandboxPolicy": {"type": "dangerFullAccess"},
            "activePermissionProfile": {"id": ":danger-full-access", "extends": None},
            "permissions": ":danger-full-access",
            "model": "gpt-6.1-sol",
            "effort": "high",
            "collaborationMode": {"mode": "default", "settings": {"model": "gpt-6.1-sol", "reasoning_effort": "high"}},
        },
        "currentPermissions": {
            "activePermissionProfile": {"id": ":danger-full-access", "extends": None},
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "sandboxPolicy": {"type": "dangerFullAccess"},
        },
        "turnHistory": {"history": {"entitiesByKey": {}, "islands": []}},
        "updatedAt": 1791621499000,
    }
    base.update(overrides)
    return base


# -- SDK path: model selection readable before any turn ---------------------------


def test_sdk_thread_state_keeps_model_and_effort() -> None:
    thread = Thread.model_validate(
        {
            "id": THREAD,
            "model": "gpt-6.1-sol",
            "reasoningEffort": "high",
            "modelProvider": "OpenAI",
            "cwd": "/tmp",
            "createdAt": 1,
            "updatedAt": 1,
            "preview": "",
            "status": {"type": "idle"},
            "source": "vscode",
            "cliVersion": "0.162.0",
            "turns": [],
            "sessionId": THREAD,
            "ephemeral": False,
        }
    )
    state = thread_state_from_sdk_thread(thread)
    assert state["model"] == "gpt-6.1-sol"
    assert state["reasoningEffort"] == "high"

    async def run() -> None:
        selections = await selections_from_thread_state(state, read_models, read_permissions)
        assert selections == {"model": _selection("gpt-6.1-sol", "high")}

    asyncio.run(run())


# -- IPC follower: owner settings -> selections ---------------------------------


def test_ipc_settings_state_flattens_owner_settings() -> None:
    flat = ipc_settings_state(_state())
    assert flat == {
        "model": "gpt-6.1-sol",
        "reasoningEffort": "high",
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandboxPolicy": {"type": "dangerFullAccess"},
    }
    assert ipc_settings_state({"latestThreadSettings": {"model": "gpt-5.5", "effort": "medium"}}) == {
        "model": "gpt-5.5",
        "reasoningEffort": "medium",
    }


class _Host(RuntimeHostClient):
    def __init__(self) -> None:
        self.states: list[dict[str, Any]] = []
        self.notices: list[SessionNotice] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_meta_upsert(self, *a, **k):
        pass

    async def session_state_update(self, session_id, runtime, status=None, selections=None, external_session_id=None, status_reason=None, error=None, metadata=None):
        self.states.append({"session_id": session_id, "status": status, "selections": dict(selections or {}), "metadata": dict(metadata or {})})

    async def notice_upsert(self, notice):
        self.notices.append(notice)

    async def session_capabilities_update(self, capabilities):
        pass

    async def timeline_sync(self, *a, **k):
        pass

    async def timeline_item_upsert(self, item):
        pass

    async def session_turn_ended(self, *a, **k):
        pass


def test_projector_publishes_selections_from_owner_settings() -> None:
    async def run() -> None:
        host = _Host()
        states = RuntimeSessionStateCache("codex", host)
        projector = CodexIpcSessionProjector(
            host=host,
            session_states=states,
            notices=CodexNoticeRegistry(),
            read_model_catalog=read_models,
            read_permission_catalog=read_permissions,
        )
        thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="owner-1", revision=1, state=_state())
        await projector.handle(FollowerEvent(kind="snapshot", thread=thread))
        assert host.states[-1]["selections"] == {
            "model": _selection("gpt-6.1-sol", "high"),
            "permission": _permission("full_access"),
        }

        # The window switches model: only latestThreadSettings patches arrive.
        changed = _state(latestModel="gpt-5.5", latestReasoningEffort="medium")
        thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="owner-1", revision=2, state=changed)
        await projector.handle(FollowerEvent(kind="patches", thread=thread, patches=({"op": "replace", "path": ["latestThreadSettings", "model"], "value": "gpt-5.5"},)))
        assert host.states[-1]["selections"]["model"] == _selection("gpt-5.5", "medium")

    asyncio.run(run())


# -- IPC follower: AA -> window --------------------------------------------------


def test_thread_settings_with_overrides_applies_model_and_permissions() -> None:
    settings = thread_settings_with_overrides(
        _state(),
        model="gpt-5.5",
        effort="medium",
        approval_policy="on-request",
        approvals_reviewer="user",
        sandbox="workspace-write",
    )
    assert settings["model"] == "gpt-5.5" and settings["effort"] == "medium"
    assert settings["collaborationMode"]["settings"] == {"model": "gpt-5.5", "reasoning_effort": "medium"}
    assert settings["approvalPolicy"] == "on-request"
    assert settings["sandboxPolicy"] == {
        "type": "workspaceWrite",
        "writableRoots": ["/tmp/project"],
        "excludeSlashTmp": False,
        "excludeTmpdirEnvVar": False,
        "networkAccess": False,
    }
    assert settings["runtimeWorkspaceRoots"] == ["/tmp/project"]
    assert "permissions" not in settings
    assert settings["activePermissionProfile"] == {"id": ":workspace", "extends": None}
    assert settings["cwd"] == "/tmp/project"


class _TempHome:
    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="aa-ipcs-", dir="/tmp"))
        return self.path

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def _client(home: Path, path: Path, client_type: str) -> CodexIpcClient:
    return CodexIpcClient(codex_home=home, socket_path=path, allow_router=False, reconnect_delay=0.05, request_timeout_ms=3000, client_type=client_type)


async def _wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


class FakeOwnerWindow:
    def __init__(self, client: CodexIpcClient, state: dict[str, Any]) -> None:
        self.client = client
        self.state = state
        self.updates: list[Mapping[str, Any]] = []
        client.add_request_handler("thread-owner-discovery", self._owns, self._discovered)
        client.add_request_handler("thread-follower-update-thread-settings", self._owns, self._update)
        client.add_broadcast_handler("thread-stream-following-changed", self._on_following)

    async def _owns(self, params: Any, request: IpcRequest) -> bool:
        return isinstance(params, Mapping) and params.get("conversationId") == THREAD

    async def _discovered(self, request: IpcRequest) -> Any:
        return {"supportsUntrustedAppInput": True}

    async def _update(self, request: IpcRequest) -> Any:
        self.updates.append(request.params)
        return {"method": request.method, "applied": True}

    async def _on_following(self, broadcast):
        if broadcast.params.get("following") and broadcast.params.get("conversationId") == THREAD:
            await self.client.broadcast(
                "thread-stream-state-changed",
                {"conversationId": THREAD, "hostId": "local", "change": {"type": "snapshot", "revision": 1, "conversationState": self.state}},
                target_client_ids=[broadcast.source_client_id],
            )


def test_controller_pushes_selection_changes_to_owner() -> None:
    async def run() -> None:
        with _TempHome() as home:
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            owner_client = _client(home, path, "vscode")
            owner = FakeOwnerWindow(owner_client, _state())
            client = _client(home, path, "agents-anywhere")
            for c in (owner_client, client):
                await c.start()
                await c.wait_until_initialized(timeout=2)
            follower = ThreadFollower(client=client, discovery_timeout_ms=1500)
            follower.attach()
            await follower.follow(THREAD)
            await _wait_for(lambda: follower.get(THREAD).has_state)

            host = _Host()
            states = RuntimeSessionStateCache("codex", host)
            controller = CodexIpcTurnController(
                client=client,
                follower=follower,
                host=host,
                session_states=states,
                active_turn_ids={},
                notices=CodexNoticeRegistry(),
                pending_messages=PendingClientMessageRegistry(connector_id="conn_test"),
                read_model_catalog=read_models,
                read_permission_catalog=read_permissions,
            )
            thread = controller.attached_thread(THREAD)
            assert thread is not None
            result = await controller.update_selections(
                "sess_1",
                thread,
                {"model": _selection("gpt-5.5", "medium"), "permission": _permission("request_approval")},
            )
            assert result.ok and result.result["applied"] is True
            sent = owner.updates[-1]
            assert sent["conversationId"] == THREAD and sent["activeTurnId"] is None
            assert sent["threadSettings"]["model"] == "gpt-5.5"
            assert sent["threadSettings"]["effort"] == "medium"
            assert sent["threadSettings"]["approvalPolicy"] == "on-request"
            assert sent["threadSettings"]["sandboxPolicy"]["type"] == "workspaceWrite"
            assert sent["threadSettings"]["sandboxPolicy"]["writableRoots"] == ["/tmp/project"]
            assert sent["threadSettings"]["activePermissionProfile"]["id"] == ":workspace"
            assert host.states[-1]["selections"]["model"] == _selection("gpt-5.5", "medium")

            bad = await controller.update_selections("sess_1", thread, {"model": "nope"})
            assert not bad.ok and bad.code == "codex_invalid_selection"

            await client.stop()
            await owner_client.stop()
            await router.close()

    asyncio.run(run())


# -- owner side: selections -> snapshot, window settings -> selections ----------


def test_owner_snapshot_reflects_selections_and_accepts_window_settings() -> None:
    async def run() -> None:
        host = _Host()
        states = RuntimeSessionStateCache("codex", host)
        applied: list[tuple[str, str, Mapping[str, str | None]]] = []

        async def apply(session_id: str, thread_id: str, selections: Mapping[str, str | None]) -> RuntimeOperationResult:
            applied.append((session_id, thread_id, dict(selections)))
            await states.update(session_id, thread_id, status="idle", selections=selections)
            return RuntimeOperationResult(ok=True)

        class Sdk:
            async def read_thread(self, thread_id, include_turns=True):
                from connector.runtimes.codex.sdk.runtime_client import (
                    CodexThreadReadResult,
                )

                return CodexThreadReadResult(thread={"id": thread_id, "model": "gpt-6.1-sol", "reasoningEffort": "high", "cwd": "/tmp/project", "turns": []})

            async def list_thread_turns(self, thread_id):
                from connector.runtimes.codex.sdk.runtime_client import (
                    CodexThreadTurnsResult,
                )

                return CodexThreadTurnsResult(turns=())

        class Ipc:
            client_id = "self"

            def add_request_handler(self, *a, **k):
                return lambda: None

            def add_broadcast_handler(self, *a, **k):
                return lambda: None

        session_id = codex_sessions.stable_session_id("conn_test", THREAD)
        owner = CodexIpcOwnerService(
            client=Ipc(),  # type: ignore[arg-type]
            sdk=Sdk(),  # type: ignore[arg-type]
            session_states=states,
            notices=CodexNoticeRegistry(),
            active_turn_ids={},
            session_id_for=lambda tid: codex_sessions.stable_session_id("conn_test", tid),
            read_model_catalog=read_models,
            read_permission_catalog=read_permissions,
            apply_selections=apply,
        )
        await states.update(
            session_id,
            THREAD,
            status="idle",
            selections={"model": _selection("gpt-5.5", "medium"), "permission": _permission("request_approval")},
            metadata={"source": "codex.turn/completed"},
        )
        state = await owner.build_conversation_state(THREAD)
        assert state["latestModel"] == "gpt-5.5" and state["latestReasoningEffort"] == "medium"
        assert state["currentPermissions"]["approvalPolicy"] == "on-request"
        assert state["currentPermissions"]["sandboxPolicy"]["type"] == "workspaceWrite"
        assert state["currentPermissions"]["sandboxPolicy"]["writableRoots"] == ["/tmp/project"]
        assert state["currentPermissions"]["activePermissionProfile"]["id"] == ":workspace"
        assert state["latestThreadSettings"]["model"] == "gpt-5.5"
        assert "permissions" not in state["latestThreadSettings"]
        assert state["latestThreadSettings"]["activePermissionProfile"] == {"id": ":workspace", "extends": None}

        request = IpcRequest(
            request_id="r1",
            method="thread-follower-update-thread-settings",
            params={"conversationId": THREAD, "threadSettings": {"model": "gpt-6.1-sol", "effort": "high", "approvalPolicy": "never", "approvalsReviewer": "user", "sandboxPolicy": {"type": "dangerFullAccess"}}},
            version=2,
        )
        response = await owner._handle_follower(request)
        assert response["applied"] is True
        assert applied[-1][2] == {"model": _selection("gpt-6.1-sol", "high"), "permission": _permission("full_access")}

    asyncio.run(run())


def test_conversation_state_without_selections_leaves_permissions_unset() -> None:
    state = conversation_state_from_thread(
        {"id": THREAD, "model": "gpt-6.1-sol", "turns": []},
        thread_id=THREAD,
        host_id="local",
        runtime_status="idle",
        requests=[],
        active_turn_id=None,
    )
    assert state["currentPermissions"] is None
    assert state["latestThreadSettings"]["model"] == "gpt-6.1-sol"


# -- runtime routing -------------------------------------------------------------


class _StubService:
    def __init__(self, thread: FollowedThread) -> None:
        self.follower = self

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    def get(self, thread_id: str):
        return self._thread if thread_id == self._thread.thread_id else None


def test_runtime_routes_selection_updates_through_ipc() -> None:
    async def run() -> None:
        from connector.runtimes.codex.ipc import IpcResponse

        calls: list[tuple[str, Any]] = []

        class RecordingClient:
            client_id = "self-1"

            async def request(self, method, params, *, target_client_id=None, host_id=None, timeout_ms=None):
                calls.append((method, params))
                return IpcResponse(request_id="r", result_type="success", method=method, handled_by_client_id=target_client_id, result={"applied": True})

            async def start(self) -> None: ...

            async def stop(self) -> None: ...

        thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="owner-1", revision=1, state=_state())
        service = _StubService(thread)
        service._thread = thread  # type: ignore[attr-defined]
        host = _Host()
        runtime = CodexRuntime(
            config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
            host=host,
            client=None,
            ipc=RecordingClient(),  # type: ignore[arg-type]
            ipc_service=service,  # type: ignore[arg-type]
        )
        # Runtime catalogs come from the SDK client; inject the test catalogs instead.
        runtime._ipc_model_catalog = read_models  # type: ignore[method-assign]
        runtime._ipc_permission_catalog = read_permissions  # type: ignore[method-assign]
        result = await runtime.update_session_selections("sess_ipc", THREAD, {"model": _selection("gpt-5.5", "medium")})
        assert result.ok and result.result["transport"] == "ipc"
        assert calls[-1][0] == "thread-follower-update-thread-settings"
        assert calls[-1][1]["threadSettings"]["model"] == "gpt-5.5"

    asyncio.run(run())
