from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeConfig
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
        return self.results.get(method, {})


class FakeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.meta_upserts: list[dict[str, Any]] = []
        self.state_updates: list[dict[str, Any]] = []

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
