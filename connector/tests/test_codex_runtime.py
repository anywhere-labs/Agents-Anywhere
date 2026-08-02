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
    @property
    def connector_id(self) -> str:
        return "conn_test"


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
