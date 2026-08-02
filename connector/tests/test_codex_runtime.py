from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeConfig, SessionNotice
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.runtime import (
    CodexRuntime,
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
    stable_session_id,
)


class FakeCodexClient:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: list[tuple[str | int, dict[str, Any]]] = []
        self.results: dict[str, dict[str, Any]] = {
            "model/list": {
                "models": [
                    {
                        "id": "gpt-example",
                        "displayName": "GPT Example",
                        "supportedReasoningEfforts": ["low", "high"],
                    },
                    {
                        "id": "gpt-plain",
                        "displayName": "GPT Plain",
                    },
                ]
            },
            "thread/loaded/list": {},
            "thread/list": {
                "threads": [
                    {
                        "id": "thread_1",
                        "name": "Fix tests",
                        "cwd": "/repo",
                        "updatedAt": "2026-08-02T00:00:00Z",
                    },
                    {
                        "id": "thread_archived",
                        "name": "Archived",
                        "archived": True,
                    },
                ]
            },
            "thread/read": {
                "thread": {
                    "id": "thread_1",
                    "items": [
                        {
                            "id": "item_user",
                            "type": "message",
                            "role": "user",
                            "status": "done",
                            "content": {"text": "hello", "format": "markdown"},
                            "turnId": "turn_1",
                        },
                        {
                            "id": "item_assistant",
                            "type": "message",
                            "role": "assistant",
                            "text": "hi",
                            "status": "done",
                        },
                    ],
                }
            },
            "thread/start": {
                "thread": {
                    "id": "thread_new",
                    "name": "New thread",
                }
            },
            "turn/start": {
                "turn": {
                    "id": "turn_new",
                }
            },
            "turn/steer": {
                "turn": {
                    "id": "turn_new",
                }
            },
            "turn/interrupt": {
                "turn": {
                    "id": "turn_new",
                }
            },
            "thread/compact/start": {},
        }

    async def start(self, handler) -> None:  # type: ignore[no-untyped-def]
        _ = handler
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.requests.append((method, dict(params or {})))
        result = self.results.get(method, {})
        if isinstance(result, Exception):
            raise result
        return result

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        self.responses.append((request_id, dict(result or {})))


class FakeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.meta_upserts: list[dict[str, Any]] = []
        self.state_updates: list[dict[str, Any]] = []
        self.timeline_syncs: list[dict[str, Any]] = []
        self.timeline_item_upserts: list[Any] = []
        self.notice_upserts: list[SessionNotice] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_meta_upsert(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        ordering_time: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.meta_upserts.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "title": title,
                "cwd": cwd,
                "ordering_time": ordering_time,
                "metadata": dict(metadata or {}),
            }
        )

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.state_updates.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "status": status,
                "selections": dict(selections or {}),
                "external_session_id": external_session_id,
                "status_reason": status_reason,
                "error": dict(error) if error is not None else None,
                "metadata": dict(metadata or {}),
            }
        )

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[Any, ...],
        external_session_id: str | None = None,
        complete: bool = True,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.timeline_syncs.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "items": items,
                "complete": complete,
                "metadata": dict(metadata or {}),
            }
        )

    async def timeline_item_upsert(self, item: Any) -> None:
        self.timeline_item_upserts.append(item)

    async def notice_upsert(self, notice: SessionNotice) -> None:
        self.notice_upserts.append(notice)


def test_codex_runtime_lifecycle_and_config() -> None:
    asyncio.run(_test_codex_runtime_lifecycle_and_config())


async def _test_codex_runtime_lifecycle_and_config() -> None:
    client = FakeCodexClient()
    config = _config()
    runtime = CodexRuntime(config=config, host=FakeHost(), client=client)

    assert runtime.identity.runtime == "codex"
    assert await runtime.get_config() == config

    await runtime.start()
    await runtime.stop()

    assert client.started is True
    assert client.stopped is True


def test_codex_runtime_model_catalog_from_app_server() -> None:
    asyncio.run(_test_codex_runtime_model_catalog_from_app_server())


async def _test_codex_runtime_model_catalog_from_app_server() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    catalog = await runtime.list_model_catalog()

    assert [model.id for model in catalog.models] == ["gpt-example", "gpt-plain"]
    assert catalog.models[0].selection_id is None
    assert [item.id for item in catalog.models[0].reasoning_items] == ["low", "high"]
    assert catalog.models[0].reasoning_items[0].selection_id.startswith("sel_model_")
    assert catalog.models[1].selection_id.startswith("sel_model_")


def test_codex_runtime_model_catalog_query_and_limit() -> None:
    asyncio.run(_test_codex_runtime_model_catalog_query_and_limit())


async def _test_codex_runtime_model_catalog_query_and_limit() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    catalog = await runtime.list_model_catalog(query="plain", limit=1)

    assert [model.id for model in catalog.models] == ["gpt-plain"]


def test_codex_runtime_permission_catalog() -> None:
    asyncio.run(_test_codex_runtime_permission_catalog())


async def _test_codex_runtime_permission_catalog() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    catalog = await runtime.list_permission_catalog(query="full")

    assert [item.id for item in catalog.permissions] == ["never_danger_full_access"]
    assert catalog.permissions[0].selection_id.startswith("sel_permission_")
    assert catalog.permissions[0].metadata["nativeSettings"]["sandbox"] == "danger-full-access"


def test_codex_runtime_lists_sessions_from_thread_list() -> None:
    asyncio.run(_test_codex_runtime_lists_sessions_from_thread_list())


async def _test_codex_runtime_lists_sessions_from_thread_list() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    sessions = await runtime.list_sessions(limit=10)

    assert len(sessions) == 1
    assert sessions[0].session_id == stable_session_id("conn_test", "thread_1")
    assert sessions[0].external_session_id == "thread_1"
    assert sessions[0].title == "Fix tests"
    assert sessions[0].cwd == "/repo"
    assert sessions[0].ordering_time == "2026-08-02T00:00:00Z"


def test_codex_runtime_session_state_defaults_to_idle_for_known_external_session() -> None:
    asyncio.run(_test_codex_runtime_session_state_defaults_to_idle_for_known_external_session())


async def _test_codex_runtime_session_state_defaults_to_idle_for_known_external_session() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    state = await runtime.get_session_state("sess_1", external_session_id="thread_1")

    assert state is not None
    assert state.status == "idle"
    assert state.runtime == "codex"


def test_codex_runtime_reads_session_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_session_snapshot())


async def _test_codex_runtime_reads_session_snapshot() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert snapshot.runtime == "codex"
    assert snapshot.external_session_id == "thread_1"
    assert [item.id for item in snapshot.items] == ["item_user", "item_assistant"]
    assert snapshot.items[0].content_hash.startswith("sha256:")
    assert snapshot.items[0].role == "user"
    assert snapshot.items[0].turn_id == "turn_1"
    assert snapshot.items[1].content == {"text": "hi", "format": "markdown"}


def test_codex_runtime_reads_nested_turn_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_nested_turn_snapshot())


async def _test_codex_runtime_reads_nested_turn_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "turns": [
                {
                    "items": [
                        {
                            "type": "message",
                            "role": "user",
                            "text": "nested",
                        }
                    ]
                }
            ],
        }
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    assert snapshot.items[0].id.startswith("codex_thread_1_0_")
    assert snapshot.items[0].content == {"text": "nested", "format": "markdown"}


def test_codex_runtime_returns_empty_snapshot_without_external_session() -> None:
    asyncio.run(_test_codex_runtime_returns_empty_snapshot_without_external_session())


async def _test_codex_runtime_returns_empty_snapshot_without_external_session() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    snapshot = await runtime.get_session_snapshot("sess_1")

    assert snapshot.items == ()
    assert snapshot.complete is True


def test_codex_runtime_starts_existing_turn_and_reports_running_state() -> None:
    asyncio.run(_test_codex_runtime_starts_existing_turn_and_reports_running_state())


async def _test_codex_runtime_starts_existing_turn_and_reports_running_state() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello",
        client_message_id="cm_1",
    )

    assert result.ok is True
    assert result.result["turnId"] == "turn_new"
    assert client.requests[-1] == (
        "turn/start",
        {
            "threadId": "thread_1",
            "input": [{"type": "text", "text": "hello", "text_elements": []}],
            "clientUserMessageId": "cm_1",
        },
    )
    assert [update["status"] for update in host.state_updates[-2:]] == ["waiting", "running"]
    state = await runtime.get_session_state("sess_1")
    assert state is not None
    assert state.status == "running"


def test_codex_runtime_create_and_start_session_reports_meta_and_state() -> None:
    asyncio.run(_test_codex_runtime_create_and_start_session_reports_meta_and_state())


async def _test_codex_runtime_create_and_start_session_reports_meta_and_state() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    model_selection = (await runtime.list_model_catalog()).models[0].reasoning_items[0].selection_id
    permission_selection = (await runtime.list_permission_catalog(query="read only")).permissions[0].selection_id

    result = await runtime.create_and_start_session(
        session_id="sess_new",
        content="start",
        title="New",
        cwd="/repo",
        selections={
            "model": model_selection,
            "permission": permission_selection,
        },
        client_message_id="cm_new",
    )

    assert result.ok is True
    assert result.result["externalSessionId"] == "thread_new"
    thread_start = next(request for request in client.requests if request[0] == "thread/start")
    assert thread_start[1]["cwd"] == "/repo"
    assert thread_start[1]["model"] == "gpt-example"
    assert thread_start[1]["approvalPolicy"] == "on-request"
    assert thread_start[1]["sandbox"] == "read-only"
    assert host.meta_upserts[0]["session_id"] == "sess_new"
    assert host.meta_upserts[0]["external_session_id"] == "thread_new"
    assert [update["status"] for update in host.state_updates] == ["idle", "waiting", "running"]
    assert host.state_updates[0]["selections"] == {
        "model": model_selection,
        "permission": permission_selection,
    }


def test_codex_runtime_lists_compact_command_for_loaded_thread() -> None:
    asyncio.run(_test_codex_runtime_lists_compact_command_for_loaded_thread())


async def _test_codex_runtime_lists_compact_command_for_loaded_thread() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    commands = await runtime.list_commands(
        "sess_1",
        external_session_id="thread_1",
        query="comp",
    )

    assert [command.id for command in commands] == ["compact"]
    assert commands[0].enabled is True


def test_codex_runtime_compact_command_calls_app_server() -> None:
    asyncio.run(_test_codex_runtime_compact_command_calls_app_server())


async def _test_codex_runtime_compact_command_calls_app_server() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
        raw="/compact",
    )

    assert result.ok is True
    assert result.code == "started"
    assert client.requests[-1] == (
        "thread/compact/start",
        {"threadId": "thread_1"},
    )


def test_codex_runtime_rejects_unknown_command_without_transport_error() -> None:
    asyncio.run(_test_codex_runtime_rejects_unknown_command_without_transport_error())


async def _test_codex_runtime_rejects_unknown_command_without_transport_error() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    result = await runtime.execute_command("sess_1", "nope", external_session_id="thread_1")

    assert result.ok is False
    assert result.code == "unknown_command"


def test_codex_runtime_turn_completed_notification_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_turn_completed_notification_sets_idle())


async def _test_codex_runtime_turn_completed_notification_sets_idle() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
            },
        }
    )

    assert host.state_updates[-1]["status"] == "idle"
    state = await runtime.get_session_state("sess_1")
    assert state is not None
    assert state.status == "idle"


def test_codex_runtime_agent_message_delta_upserts_timeline_item() -> None:
    asyncio.run(_test_codex_runtime_agent_message_delta_upserts_timeline_item())


async def _test_codex_runtime_agent_message_delta_upserts_timeline_item() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_agent",
                "delta": "hel",
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_agent",
                "delta": "lo",
            },
        }
    )

    assert len(host.timeline_item_upserts) == 2
    first, second = host.timeline_item_upserts
    assert first.id == "item_agent"
    assert first.order_seq == second.order_seq
    assert second.type == "message"
    assert second.role == "assistant"
    assert second.status == "running"
    assert second.turn_id == "turn_1"
    assert second.content == {"text": "hello", "format": "markdown"}
    assert second.source["event"] == "item/agentMessage/delta"


def test_codex_runtime_completed_turn_syncs_timeline_snapshot() -> None:
    asyncio.run(_test_codex_runtime_completed_turn_syncs_timeline_snapshot())


async def _test_codex_runtime_completed_turn_syncs_timeline_snapshot() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_done",
                    "items": [
                        {
                            "id": "item_user",
                            "type": "userMessage",
                            "text": "hi",
                            "status": "completed",
                        },
                        {
                            "id": "item_agent",
                            "type": "agentMessage",
                            "text": "hello",
                            "status": "completed",
                        },
                    ],
                },
            },
        }
    )

    assert len(host.timeline_syncs) == 1
    sync = host.timeline_syncs[0]
    assert sync["session_id"] == "sess_1"
    assert sync["external_session_id"] == "thread_1"
    assert sync["complete"] is False
    assert [item.id for item in sync["items"]] == ["item_user", "item_agent"]
    assert [item.role for item in sync["items"]] == ["user", "assistant"]
    assert [item.type for item in sync["items"]] == ["message", "message"]
    assert [item.status for item in sync["items"]] == ["done", "done"]
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_approval_request_upserts_session_notice() -> None:
    asyncio.run(_test_codex_runtime_approval_request_upserts_session_notice())


async def _test_codex_runtime_approval_request_upserts_session_notice() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_cmd",
                "approvalId": "appr_cmd",
                "command": "ls -la",
            },
        }
    )

    assert len(host.notice_upserts) == 1
    notice = host.notice_upserts[0]
    assert notice.notice_id == "notice_approval_appr_cmd"
    assert notice.type == "interaction"
    assert notice.interaction_type == "approval"
    assert notice.blocking == {"scope": "session", "targetId": "sess_1"}
    assert notice.response_required is True
    assert notice.source == {"approvalId": "appr_cmd", "timelineItemId": "item_cmd"}
    assert notice.context["approvalId"] == "appr_cmd"
    assert notice.context["approvalStatus"] == "pending"
    assert notice.context["approvalSource"] == {
        "requestId": 42,
        "method": "item/commandExecution/requestApproval",
        "threadId": "thread_1",
        "turnId": "turn_1",
        "itemId": "item_cmd",
    }
    assert notice.context["turnId"] == "turn_1"
    assert notice.context["command"] == "ls -la"
    assert host.state_updates[-1]["status"] == "blocked"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_approval_appr_cmd"
    assert [action["actionId"] for action in notice.actions] == [
        "approve",
        "approve_for_session",
        "reject",
    ]


def test_codex_runtime_steers_active_turn() -> None:
    asyncio.run(_test_codex_runtime_steers_active_turn())


async def _test_codex_runtime_steers_active_turn() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.steer_turn(
        "sess_1",
        "thread_1",
        "more context",
        client_message_id="cm_steer",
    )

    assert result.ok is True
    assert result.result["steered"] is True
    assert result.result["turnId"] == "turn_new"
    assert client.requests[-1] == (
        "turn/steer",
        {
            "threadId": "thread_1",
            "input": [{"type": "text", "text": "more context", "text_elements": []}],
            "expectedTurnId": "turn_new",
            "clientUserMessageId": "cm_steer",
        },
    )
    assert host.state_updates[-1]["status"] == "running"


def test_codex_runtime_steer_without_active_turn_returns_conflict() -> None:
    asyncio.run(_test_codex_runtime_steer_without_active_turn_returns_conflict())


async def _test_codex_runtime_steer_without_active_turn_returns_conflict() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.steer_turn("sess_1", "thread_1", "late")

    assert result.ok is False
    assert result.code == "codex_no_active_turn"
    assert all(request[0] != "turn/steer" for request in client.requests)


def test_codex_runtime_interrupts_active_turn_and_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupts_active_turn_and_sets_idle())


async def _test_codex_runtime_interrupts_active_turn_and_sets_idle() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_turn("sess_1", "thread_1")
    second = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is True
    assert result.result["interrupted"] is True
    assert client.requests[-1] == (
        "turn/interrupt",
        {
            "threadId": "thread_1",
            "turnId": "turn_new",
        },
    )
    assert host.state_updates[-1]["status"] == "idle"
    assert second.ok is False
    assert second.code == "codex_no_active_turn"


def test_codex_runtime_interrupt_soft_failure_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupt_soft_failure_sets_idle())


async def _test_codex_runtime_interrupt_soft_failure_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["turn/interrupt"] = RuntimeError('{"message": "turn not found"}')
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is False
    assert result.code == "turn_not_found"
    assert result.result["interrupted"] is False
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_responds_to_approval_interaction() -> None:
    asyncio.run(_test_codex_runtime_responds_to_approval_interaction())


async def _test_codex_runtime_responds_to_approval_interaction() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    await runtime._set_session_state(
        session_id="sess_1",
        external_session_id="thread_1",
        status="blocked",
        metadata={"source": "test"},
    )

    result = await runtime.respond_interaction(
        "sess_1",
        "notice_1",
        "approve_for_session",
        {"approvalSource": {"requestId": "42"}},
    )

    assert result.ok is True
    assert result.result["decision"] == "acceptForSession"
    assert client.responses == [("42", {"decision": "acceptForSession"})]
    assert host.state_updates[-1]["status"] == "running"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_1"


def test_codex_catalog_helpers_ignore_unrecognized_items() -> None:
    models = model_catalog_from_codex_items([{}, {"id": "gpt"}], revision=3)
    permissions = permission_catalog_from_codex_items([{}, {"id": "perm", "label": "Perm"}], revision=3)

    assert [model.id for model in models.models] == ["gpt"]
    assert [permission.id for permission in permissions.permissions] == ["perm"]


def _config() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="codex",
        revision=3,
        values={"sdkMode": "app-server", "executablePath": "/opt/codex"},
    )
