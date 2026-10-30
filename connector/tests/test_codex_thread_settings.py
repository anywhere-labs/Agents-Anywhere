from __future__ import annotations

import asyncio
from typing import Any

import pytest
from openai_codex import JsonRpcError

from connector.runtimes.codex.domain.selections import (
    CodexModelSettings,
    CodexPermissionSettings,
    permission_selection_from_thread_state,
    thread_settings_update,
)
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.codex.sdk.runtime_client import CodexStartThreadRequest
from tests.test_codex_runtime import FakeCodexClient, FakeHost, _config
from tests.test_codex_sdk_client import _FakeLowLevelAsyncCodex, _FakeLowLevelSdkModule

# -- settings payloads ----------------------------------------------------------


def test_settings_update_sends_only_the_selected_values() -> None:
    model = CodexModelSettings(model="gpt-example", effort="high")
    full_access = CodexPermissionSettings(approval_policy="never", sandbox="danger-full-access")

    assert thread_settings_update(model, CodexPermissionSettings()) == {"model": "gpt-example", "effort": "high"}
    # By profile name, never with sandboxPolicy: app-server rejects the pair and
    # the legacy field alone clears the thread's activePermissionProfile.
    assert thread_settings_update(CodexModelSettings(), full_access) == {
        "permissions": ":danger-full-access",
        "approvalPolicy": "never",
    }


def test_profile_names_map_back_to_permission_selections() -> None:
    async def run() -> None:
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

        async def catalog():
            return await runtime.list_permission_catalog()

        ids = {item.id: item.selection_id for item in (await catalog()).permissions}
        assert await permission_selection_from_thread_state({"permissions": ":danger-full-access"}, catalog) == ids["full_access"]
        assert (
            await permission_selection_from_thread_state(
                {"activePermissionProfile": {"id": ":workspace"}, "approvalPolicy": "on-request", "approvalsReviewer": "auto_review"},
                catalog,
            )
            == ids["auto_review"]
        )

    asyncio.run(run())


# -- SDK client -----------------------------------------------------------------


async def _sdk_client_with_thread() -> tuple[CodexSdkClient, Any]:
    native = _FakeLowLevelAsyncCodex()
    client = CodexSdkClient(native, sdk=_FakeLowLevelSdkModule())

    async def handler(message: Any) -> None:
        native.handled.append(message)

    await client.start(handler)
    await client.start_thread(CodexStartThreadRequest(cwd="/repo"))
    return client, native


def test_sdk_client_updates_settings_of_threads_it_holds() -> None:
    async def run() -> None:
        client, native = await _sdk_client_with_thread()
        settings = {"permissions": ":danger-full-access", "approvalPolicy": "never"}

        assert await client.update_thread_settings("thread_low", settings) is True
        # A thread this app-server never loaded is left alone: loading it would
        # take its writer lock.
        assert await client.update_thread_settings("thread_elsewhere", settings) is False
        assert await client.update_turn_settings("thread_low", "turn_1", {"approvalsReviewer": "auto_review"}) is True
        await client.stop()

        assert native.low_level.raw_requests == [
            ("thread/settings/update", {"threadId": "thread_low", **settings}),
            ("turn/settings/update", {"threadId": "thread_low", "turnId": "turn_1", "approvalsReviewer": "auto_review"}),
        ]

    asyncio.run(run())


def test_sdk_client_stops_asking_an_app_server_without_settings_updates() -> None:
    async def run() -> None:
        client, native = await _sdk_client_with_thread()
        calls: list[str] = []

        async def request(method: str, params: dict[str, Any], *, response_model: Any) -> Any:
            calls.append(method)
            raise JsonRpcError(-32600, f"Invalid request: unknown variant `{method}`")

        native.low_level.request = request

        assert await client.update_thread_settings("thread_low", {"model": "gpt-example"}) is False
        assert await client.update_thread_settings("thread_low", {"model": "gpt-example"}) is False
        assert calls == ["thread/settings/update"]
        await client.stop()

    asyncio.run(run())


def test_sdk_client_raises_when_app_server_rejects_the_settings() -> None:
    async def run() -> None:
        client, native = await _sdk_client_with_thread()

        async def request(method: str, params: dict[str, Any], *, response_model: Any) -> Any:
            raise JsonRpcError(-32600, "`permissions` cannot be combined with `sandboxPolicy`")

        native.low_level.request = request

        with pytest.raises(JsonRpcError):
            await client.update_thread_settings("thread_low", {"permissions": ":workspace"})
        await client.stop()

    asyncio.run(run())


# -- runtime: selections apply at once --------------------------------------------


class _SettingsClient(FakeCodexClient):
    def __init__(self, *, loaded: bool = True, supported: bool = True, reject: Exception | None = None) -> None:
        super().__init__()
        self.loaded = {"thread_1"} if loaded else set()
        self.supported = supported
        self.reject = reject

    def thread_loaded(self, thread_id: str) -> bool:
        return thread_id in self.loaded

    async def update_thread_settings(self, thread_id: str, settings: dict[str, Any]) -> bool:
        if self.reject is not None:
            raise self.reject
        if not self.supported or thread_id not in self.loaded:
            return False
        self.record_request("thread/settings/update", {"threadId": thread_id, **settings})
        return True

    async def update_turn_settings(self, thread_id: str, turn_id: str, settings: dict[str, Any]) -> bool:
        self.record_request("turn/settings/update", {"threadId": thread_id, "turnId": turn_id, **settings})
        return True


async def _permission(runtime: CodexRuntime, permission_id: str) -> str:
    catalog = await runtime.list_permission_catalog()
    return next(item.selection_id for item in catalog.permissions if item.id == permission_id)


def _settings_requests(client: FakeCodexClient) -> list[tuple[str, dict[str, Any]]]:
    return [(method, params) for method, params in client.requests if method.endswith("/settings/update")]


def test_permission_change_applies_to_a_held_thread_at_once() -> None:
    async def run() -> None:
        client = _SettingsClient()
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
        full_access = await _permission(runtime, "full_access")

        result = await runtime.update_session_selections("sess_1", "thread_1", {"permission": full_access})

        assert result.ok and result.result["applied"] is True
        assert _settings_requests(client) == [
            (
                "thread/settings/update",
                {"threadId": "thread_1", "permissions": ":danger-full-access", "approvalPolicy": "never"},
            )
        ]
        state = runtime._session_states.get("sess_1")
        assert state is not None and state.selections == {"permission": full_access}
        assert state.metadata["pendingSelectionScopes"] == []

    asyncio.run(run())


def test_model_change_applies_to_a_held_thread_at_once() -> None:
    async def run() -> None:
        client = _SettingsClient()
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
        catalog = await runtime.list_model_catalog()
        model = next(item for item in catalog.models if item.id == "gpt-example")
        high = next(item.selection_id for item in model.reasoning_items if item.id == "high")

        result = await runtime.update_session_selections("sess_1", "thread_1", {"model": high})

        assert result.ok and result.result["applied"] is True
        assert _settings_requests(client) == [
            ("thread/settings/update", {"threadId": "thread_1", "model": "gpt-example", "effort": "high"})
        ]

    asyncio.run(run())


@pytest.mark.parametrize("client", [_SettingsClient(loaded=False), _SettingsClient(supported=False)])
def test_selection_waits_for_the_next_turn_when_it_cannot_apply_now(client: _SettingsClient) -> None:
    async def run() -> None:
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
        full_access = await _permission(runtime, "full_access")

        result = await runtime.update_session_selections("sess_1", "thread_1", {"permission": full_access})

        assert result.ok and result.result["applied"] is False
        assert _settings_requests(client) == []
        state = runtime._session_states.get("sess_1")
        assert state is not None and state.metadata["pendingSelectionScopes"] == ["permission"]

    asyncio.run(run())


def test_rejected_settings_fail_the_update() -> None:
    async def run() -> None:
        client = _SettingsClient(reject=JsonRpcError(-32600, "invalid settings"))
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
        full_access = await _permission(runtime, "full_access")

        result = await runtime.update_session_selections("sess_1", "thread_1", {"permission": full_access})

        assert not result.ok and result.code == "codex_thread_settings_rejected"
        assert runtime._session_states.get("sess_1") is None

    asyncio.run(run())


def test_reviewer_change_also_reaches_the_running_turn() -> None:
    async def run() -> None:
        client = _SettingsClient()
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
        runtime._active_turn_ids["sess_1"] = "turn_7"
        auto_review = await _permission(runtime, "auto_review")

        result = await runtime.update_session_selections("sess_1", "thread_1", {"permission": auto_review})

        assert result.ok
        assert _settings_requests(client)[-1] == (
            "turn/settings/update",
            {"threadId": "thread_1", "turnId": "turn_7", "approvalsReviewer": "auto_review"},
        )

    asyncio.run(run())
