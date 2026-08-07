from __future__ import annotations

import asyncio
from collections.abc import Mapping
from types import SimpleNamespace, TracebackType
from typing import Any, Self

from openai_codex.generated.v2_all import (
    AgentMessageThreadItem,
    ContextCompactedNotification,
    Thread,
    ThreadItem,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadStartParams,
    Turn,
    TurnStartParams,
    TurnStatus,
)
from openai_codex.models import (
    AgentMessageDeltaNotification,
    Notification,
    TurnCompletedNotification,
)

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.codex.sdk.client import (
    CodexSdkClient,
    _create_sdk_client,
    _sdk_config,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import (
    CodexInterruptTurnRequest,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexTurnInputAttachment,
)
from connector.runtimes.codex.sdk.shapes import sdk_approval_mode, thread_read_result


def test_codex_sdk_client_delegates_runtime_protocol_methods() -> None:
    asyncio.run(_test_codex_sdk_client_delegates_runtime_protocol_methods())


def test_codex_sdk_approval_mode_maps_platform_permission_modes() -> None:
    sdk = _FakeAsyncCodexSdkModule()

    assert sdk_approval_mode(sdk, "request_approval") is None
    assert sdk_approval_mode(sdk, "on-request") is None
    assert sdk_approval_mode(sdk, None) is None
    assert sdk_approval_mode(sdk, "auto_review") == _FakeApprovalMode.auto_review
    assert sdk_approval_mode(sdk, "full_access") == _FakeApprovalMode.deny_all
    assert sdk_approval_mode(sdk, "never") == _FakeApprovalMode.deny_all


def test_codex_sdk_thread_read_result_preserves_typed_thread() -> None:
    thread = Thread.model_validate(
        {
            "id": "thread_1",
            "cliVersion": "0.1.0",
            "createdAt": 1,
            "cwd": "/repo",
            "ephemeral": False,
            "modelProvider": "openai",
            "preview": "hello",
            "sessionId": "codex_session_1",
            "source": "appServer",
            "status": {"type": "notLoaded"},
            "turns": [],
            "updatedAt": 2,
        }
    )
    result = thread_read_result(ThreadReadResponse(thread=thread))

    assert result.thread is thread


async def _test_codex_sdk_client_delegates_runtime_protocol_methods() -> None:
    native = _NativeSdkClient()
    client = CodexSdkClient(native)

    async def handler(message: dict[str, Any]) -> None:
        native.handled.append(message)

    await client.start(handler)
    result = await client.list_threads(limit=1)
    await client.respond("req_1", {"decision": "approve"})
    await client.stop()

    assert native.started is True
    assert native.stopped is True
    assert native.requests == [("thread/list", {"limit": 1})]
    assert native.responses == [("req_1", {"decision": "approve"})]
    assert result.threads == ()


def test_create_sdk_client_prefers_explicit_runtime_factory() -> None:
    config = RuntimeConfig(runtime="codex", revision=1, values={"environment": {}})
    sdk = _FakeSdkModule()

    client = _create_sdk_client(sdk, config)

    assert isinstance(client, _NativeSdkClient)
    assert sdk.created_with == config


def test_create_sdk_client_prefers_async_codex_sdk_entrypoint() -> None:
    config = RuntimeConfig(
        runtime="codex",
        revision=1,
        values={
            "environment": {"EXAMPLE": "1"},
        },
    )
    sdk = _FakeAsyncCodexSdkModule()

    client = _create_sdk_client(sdk, config)

    assert isinstance(client, _FakeAsyncCodex)
    assert isinstance(client.config, _FakeCodexConfig)
    assert client.config.codex_bin is None
    assert client.config.env == {"EXAMPLE": "1"}


def test_codex_sdk_client_adapts_async_codex_thread_turn_flow() -> None:
    asyncio.run(_test_codex_sdk_client_adapts_async_codex_thread_turn_flow())


def test_codex_sdk_client_uses_low_level_permission_payloads() -> None:
    asyncio.run(_test_codex_sdk_client_uses_low_level_permission_payloads())


def test_codex_sdk_client_resumes_thread_before_low_level_turn_start() -> None:
    asyncio.run(_test_codex_sdk_client_resumes_thread_before_low_level_turn_start())


def test_codex_sdk_client_sends_attachments_as_user_input() -> None:
    asyncio.run(_test_codex_sdk_client_sends_attachments_as_user_input())


def test_codex_sdk_client_resumes_thread_after_read_handle_cache() -> None:
    asyncio.run(_test_codex_sdk_client_resumes_thread_after_read_handle_cache())


def test_codex_sdk_client_resumes_thread_before_compact() -> None:
    asyncio.run(_test_codex_sdk_client_resumes_thread_before_compact())


def test_codex_sdk_client_retries_turn_start_after_thread_not_found() -> None:
    asyncio.run(_test_codex_sdk_client_retries_turn_start_after_thread_not_found())


async def _test_codex_sdk_client_adapts_async_codex_thread_turn_flow() -> None:
    sdk = _FakeAsyncCodexSdkModule()
    native = _FakeAsyncCodex(_sdk_config(sdk, _sdk_config_values()))
    client = CodexSdkClient(native, sdk=sdk)
    notifications: list[Any] = []

    async def handler(message: Any) -> None:
        notifications.append(message)

    await client.start(handler)
    models = await client.list_models()
    started = await client.start_thread(
        CodexStartThreadRequest(
            cwd="/repo",
            model="gpt-example",
            sandbox="workspace-write",
        )
    )
    turn = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_sdk",
            content="hello",
        )
    )
    steered = await client.steer_turn(
        CodexSteerTurnRequest(
            thread_id="thread_sdk",
            turn_id="turn_sdk",
            content="more",
        )
    )
    interrupted = await client.interrupt_turn(
        CodexInterruptTurnRequest(
            thread_id="thread_sdk",
            turn_id="turn_sdk",
        )
    )
    await asyncio.sleep(0)
    await client.stop()

    assert models.models[0]["id"] == "gpt-example"
    assert started.thread_id == "thread_sdk"
    assert started.payload["id"] == "thread_sdk"
    assert turn.turn_id == "turn_sdk"
    assert turn.payload["id"] == "turn_sdk"
    assert steered.turn_id == "turn_sdk"
    assert steered.payload["turnId"] == "turn_sdk"
    assert interrupted.turn_id == "turn_sdk"
    assert interrupted.payload["id"] == "turn_sdk"
    assert native.entered is True
    assert native.exited is True
    assert native.started_kwargs["approval_mode"] is None
    assert native.started_kwargs["sandbox"] == _FakeSandbox.workspace_write
    assert notifications[0]["method"] == "turn/started"
    assert notifications[0]["params"]["turn"]["id"] == "turn_sdk"
    assert any(
        isinstance(message, CodexSdkEvent)
        and message.event_type == "item/agentMessage/delta"
        and message.content == "hi"
        for message in notifications
    )
    assert any(
        isinstance(message, CodexSdkEvent) and message.event_type == "turn/completed"
        for message in notifications
    )


async def _test_codex_sdk_client_uses_low_level_permission_payloads() -> None:
    sdk = _FakeLowLevelSdkModule()
    native = _FakeLowLevelAsyncCodex()
    client = CodexSdkClient(native, sdk=sdk)

    async def handler(message: Any) -> None:
        native.handled.append(message)

    await client.start(handler)
    started = await client.start_thread(
        CodexStartThreadRequest(
            cwd="/repo",
            approval_policy="request_approval",
            sandbox="workspace-write",
        )
    )
    turn = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_low",
            content="hello",
            approval_policy="auto_review",
            sandbox="workspace-write",
        )
    )
    full_access = await client.start_thread(
        CodexStartThreadRequest(
            approval_policy="full_access",
            sandbox="danger-full-access",
        )
    )
    await asyncio.sleep(0)
    await client.stop()

    assert started.thread_id == "thread_low"
    assert turn.turn_id == "turn_low"
    assert full_access.thread_id == "thread_low"
    assert native.initialized is True
    assert native.low_level.thread_start_params[0]["approvalPolicy"] == "on-request"
    assert native.low_level.thread_start_params[0]["approvalsReviewer"] == "user"
    assert native.low_level.thread_start_params[0]["sandbox"] == "workspace-write"
    assert native.low_level.turn_start_params[0]["approvalPolicy"] == "on-request"
    assert native.low_level.turn_start_params[0]["approvalsReviewer"] == "auto_review"
    assert native.low_level.turn_start_params[0]["sandboxPolicy"]["type"] == (
        "workspaceWrite"
    )
    assert (
        native.low_level.turn_start_params[0]["sandboxPolicy"]["networkAccess"] is False
    )
    assert native.low_level.thread_start_params[1]["approvalPolicy"] == "never"
    assert "approvalsReviewer" not in native.low_level.thread_start_params[1]
    assert native.low_level.thread_start_params[1]["sandbox"] == "danger-full-access"


async def _test_codex_sdk_client_sends_attachments_as_user_input() -> None:
    sdk = _FakeLowLevelSdkModule()
    native = _FakeLowLevelAsyncCodex()
    client = CodexSdkClient(native, sdk=sdk)

    async def handler(message: Any) -> None:
        native.handled.append(message)

    await client.start(handler)
    await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_low",
            content="hello",
            attachments=(
                CodexTurnInputAttachment(
                    name="note.txt",
                    path="/tmp/note.txt",
                    media_type="text/plain",
                ),
                CodexTurnInputAttachment(
                    name="image.png",
                    path="/tmp/image.png",
                    media_type="image/png",
                ),
            ),
        )
    )
    await client.stop()

    turn_input = native.low_level.turn_start_inputs[0]
    assert turn_input[0] == {
        "text": "hello",
        "type": "text",
    }
    assert turn_input[1] == {
        "name": "note.txt",
        "path": "/tmp/note.txt",
        "type": "mention",
    }
    assert turn_input[2] == {
        "path": "/tmp/image.png",
        "type": "localImage",
    }
    assert len(turn_input) == 3
    params_input = native.low_level.turn_start_params[0]["input"]
    assert params_input[0]["text"] == "hello"
    assert params_input[1] == turn_input[1]
    assert params_input[2] == turn_input[2]
    assert len(params_input) == 3


async def _test_codex_sdk_client_resumes_thread_before_low_level_turn_start() -> None:
    sdk = _FakeLowLevelSdkModule()
    native = _FakeLowLevelAsyncCodex()
    client = CodexSdkClient(native, sdk=sdk)

    async def handler(message: Any) -> None:
        native.handled.append(message)

    await client.start(handler)
    result = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_existing",
            content="hello",
            model="gpt-example",
            approval_policy="request_approval",
            sandbox="workspace-write",
        )
    )
    await asyncio.sleep(0)
    await client.stop()

    assert result.turn_id == "turn_low"
    assert native.low_level.request_order == [
        "thread/resume:thread_existing",
        "turn/start:thread_existing",
    ]
    assert native.low_level.thread_resume_params[0]["threadId"] == "thread_existing"
    assert native.low_level.thread_resume_params[0]["model"] == "gpt-example"
    assert native.low_level.thread_resume_params[0]["approvalPolicy"] == "on-request"
    assert native.low_level.thread_resume_params[0]["approvalsReviewer"] == "user"
    assert native.low_level.thread_resume_params[0]["sandbox"] == "workspace-write"


async def _test_codex_sdk_client_resumes_thread_after_read_handle_cache() -> None:
    sdk = _FakeLowLevelSdkModule()
    native = _FakeLowLevelAsyncCodex()
    client = CodexSdkClient(native, sdk=sdk)

    async def handler(message: Any) -> None:
        native.handled.append(message)

    await client.start(handler)
    await client.read_thread("thread_existing", include_turns=False)
    result = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_existing",
            content="hello after read",
        )
    )
    await asyncio.sleep(0)
    await client.stop()

    assert result.turn_id == "turn_low"
    assert native.low_level.request_order == [
        "thread/resume:thread_existing",
        "turn/start:thread_existing",
    ]


async def _test_codex_sdk_client_resumes_thread_before_compact() -> None:
    sdk = _FakeLowLevelSdkModule()
    native = _FakeLowLevelAsyncCodex()
    client = CodexSdkClient(native, sdk=sdk)

    handled: list[Any] = []

    async def handler(message: Any) -> None:
        handled.append(message)

    await client.start(handler)
    result = await client.compact_thread("thread_existing")
    await native.publish_global_notification(
        Notification(
            method="thread/compacted",
            payload=ContextCompactedNotification(
                threadId="thread_existing",
                turnId="turn_compact",
            ),
        )
    )
    for _ in range(10):
        await asyncio.sleep(0)
        if handled:
            break
    await client.stop()

    assert result.payload == {"compacted": True}
    assert handled[0].method == "thread/compacted"
    assert native.low_level.request_order == [
        "thread/resume:thread_existing",
        "thread/compact/start:thread_existing",
    ]
    assert native.low_level.thread_resume_params[0]["threadId"] == "thread_existing"


async def _test_codex_sdk_client_retries_turn_start_after_thread_not_found() -> None:
    sdk = _FakeLowLevelSdkModule()
    native = _FakeLowLevelAsyncCodex()
    native.low_level.fail_next_turn_start = RuntimeError(
        "JSON-RPC error -32600: thread not found: thread_existing"
    )
    client = CodexSdkClient(native, sdk=sdk)

    async def handler(message: Any) -> None:
        native.handled.append(message)

    await client.start(handler)
    await client.start_thread(CodexStartThreadRequest())
    result = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_low",
            content="retry after missing thread",
            approval_policy="request_approval",
        )
    )
    await asyncio.sleep(0)
    await client.stop()

    assert result.turn_id == "turn_low"
    assert native.low_level.request_order == [
        "thread/start",
        "turn/start:thread_low",
        "thread/resume:thread_low",
        "turn/start:thread_low",
    ]
    assert native.low_level.thread_resume_params[0]["threadId"] == "thread_low"
    assert native.low_level.thread_resume_params[0]["approvalPolicy"] == "on-request"


class _NativeSdkClient:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.handled: list[dict[str, Any]] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: list[tuple[str | int, dict[str, Any]]] = []

    async def start(self, handler: Any) -> None:
        self.started = True
        await handler({"method": "ready"})

    async def stop(self) -> None:
        self.stopped = True

    async def thread_list(
        self,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if cursor is not None:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = limit
        self.requests.append(("thread/list", params))
        return {"ok": True}

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        self.responses.append((request_id, dict(result or {})))


class _FakeSdkModule:
    def __init__(self) -> None:
        self.created_with: RuntimeConfig | None = None

    def create_runtime_client(self, config: RuntimeConfig) -> _NativeSdkClient:
        self.created_with = config
        return _NativeSdkClient()


def _sdk_config_values() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="codex",
        revision=1,
        values={"environment": {}},
    )


class _FakeApprovalMode:
    deny_all = "deny_all"
    auto_review = "auto_review"


class _FakeSandbox:
    read_only = "read-only"
    workspace_write = "workspace-write"
    full_access = "full-access"


class _FakeCodexConfig:
    def __init__(
        self,
        codex_bin: str | None = None,
        env: dict[str, str] | None = None,
        client_name: str = "",
        client_title: str = "",
    ) -> None:
        self.codex_bin = codex_bin
        self.env = env
        self.client_name = client_name
        self.client_title = client_title


class _FakeAsyncCodexSdkModule:
    ApprovalMode = _FakeApprovalMode
    Sandbox = _FakeSandbox
    CodexConfig = _FakeCodexConfig

    def AsyncCodex(self, config: _FakeCodexConfig | None = None) -> _FakeAsyncCodex:
        return _FakeAsyncCodex(config)

    def AsyncThread(self, codex: _FakeAsyncCodex, thread_id: str) -> _FakeThread:
        return _FakeThread(codex, thread_id)


class _FakeLowLevelSdkModule(_FakeAsyncCodexSdkModule):
    def AsyncThread(self, codex: Any, thread_id: str) -> _FakeThread:
        return _FakeThread(codex, thread_id)

    def AsyncTurnHandle(self, codex: Any, thread_id: str, turn_id: str) -> _FakeTurn:
        _ = codex
        _ = thread_id
        return _FakeTurn(turn_id)


class _FakeLowLevelClient:
    def __init__(self) -> None:
        self.request_order: list[str] = []
        self.thread_resume_params: list[dict[str, Any]] = []
        self.thread_start_params: list[dict[str, Any]] = []
        self.turn_start_inputs: list[list[dict[str, Any]]] = []
        self.turn_start_params: list[dict[str, Any]] = []
        self.fail_next_turn_start: Exception | None = None

    async def thread_resume(
        self,
        thread_id: str,
        params: ThreadResumeParams,
    ) -> Any:
        self.request_order.append(f"thread/resume:{thread_id}")
        self.thread_resume_params.append(generated_params_payload(params))
        return SimpleNamespace(thread=SimpleNamespace(id=thread_id))

    async def thread_start(self, params: ThreadStartParams) -> Any:
        self.request_order.append("thread/start")
        self.thread_start_params.append(generated_params_payload(params))
        return SimpleNamespace(thread=SimpleNamespace(id="thread_low"))

    async def turn_start(
        self,
        thread_id: str,
        input_items: list[dict[str, Any]],
        params: TurnStartParams,
    ) -> Any:
        self.request_order.append(f"turn/start:{thread_id}")
        self.turn_start_inputs.append(input_items)
        self.turn_start_params.append(generated_params_payload(params))
        if self.fail_next_turn_start is not None:
            error = self.fail_next_turn_start
            self.fail_next_turn_start = None
            raise error
        return SimpleNamespace(turn=SimpleNamespace(id="turn_low"))

    def register_turn_notifications(self, turn_id: str) -> None:
        _ = turn_id

    def unregister_turn_notifications(self, turn_id: str) -> None:
        _ = turn_id


class _FakeLowLevelAsyncCodex:
    def __init__(self) -> None:
        self._client = _FakeLowLevelClient()
        self.low_level = self._client
        self.initialized = False
        self.entered = False
        self.exited = False
        self.handled: list[Any] = []
        self.global_notifications: asyncio.Queue[Any] = asyncio.Queue()

    async def __aenter__(self) -> Self:
        self.entered = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        _ = exc_type
        _ = exc
        _ = tb
        self.exited = True

    async def _ensure_initialized(self) -> None:
        self.initialized = True

    async def next_notification(self) -> Any:
        return await self.global_notifications.get()

    async def publish_global_notification(self, notification: Any) -> None:
        await self.global_notifications.put(notification)


def generated_params_payload(
    params: ThreadResumeParams | ThreadStartParams | TurnStartParams,
) -> dict[str, Any]:
    payload = params.model_dump(
        by_alias=True,
        exclude_none=True,
        mode="json",
    )
    assert isinstance(payload, dict)
    return payload


class _FakeAsyncCodex:
    def __init__(self, config: _FakeCodexConfig | None = None) -> None:
        self.config = config
        self.entered = False
        self.exited = False
        self.started_kwargs: dict[str, Any] = {}

    async def __aenter__(self) -> Self:
        self.entered = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        _ = exc_type
        _ = exc
        _ = tb
        self.exited = True

    async def models(self, include_hidden: bool = False) -> _FakeModelDump:
        _ = include_hidden
        return _FakeModelDump({"data": [{"id": "gpt-example"}]})

    async def thread_start(self, **kwargs: Any) -> _FakeThread:
        self.started_kwargs = kwargs
        return _FakeThread(self, "thread_sdk")


class _FakeThread:
    def __init__(self, codex: _FakeAsyncCodex, thread_id: str) -> None:
        self.codex = codex
        self.id = thread_id

    async def read(self, include_turns: bool = False) -> _FakeModelDump:
        _ = include_turns
        return _FakeModelDump({"thread": {"id": self.id, "items": []}})

    async def turn(self, input: Any, **kwargs: Any) -> _FakeTurn:
        _ = input
        _ = kwargs
        return _FakeTurn()

    async def compact(self) -> dict[str, Any]:
        request_order = getattr(
            getattr(self.codex, "low_level", None),
            "request_order",
            None,
        )
        if isinstance(request_order, list):
            request_order.append(f"thread/compact/start:{self.id}")
        return {"compacted": True}


class _FakeTurn:
    def __init__(self, turn_id: str = "turn_sdk") -> None:
        self.id = turn_id

    async def steer(self, input: Any) -> _FakeModelDump:
        _ = input
        return _FakeModelDump({"turnId": self.id})

    async def interrupt(self) -> dict[str, Any]:
        return {}

    async def stream(self) -> Any:
        yield Notification(
            method="item/agentMessage/delta",
            payload=AgentMessageDeltaNotification(
                delta="hi",
                itemId="item_agent",
                threadId="thread_sdk",
                turnId=self.id,
            ),
        )
        yield Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_sdk",
                turn=Turn(
                    id=self.id,
                    status=TurnStatus.completed,
                    items=[
                        ThreadItem(
                            root=AgentMessageThreadItem(
                                id="item_agent",
                                type="agentMessage",
                                text="hi",
                                memoryCitation=None,
                                phase=None,
                            )
                        )
                    ],
                    completedAt=None,
                    durationMs=None,
                    error=None,
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        )


class _FakeModelDump:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        _ = kwargs
        return self.value
