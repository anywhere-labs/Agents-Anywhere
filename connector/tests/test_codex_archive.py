from __future__ import annotations

import asyncio
from typing import Any

import pytest
from openai_codex import JsonRpcError, MethodNotFoundError
from test_codex_runtime import FakeCodexClient, FakeHost, _config

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeSessionStateCache,
)
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.ipc import CodexIpcOwnerService
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import (
    CodexSdkClient,
    CodexThreadArchiveResponse,
)

THREAD = "01a124e5-815c-7e42-aea7-25d46a8450c3"


# -- CodexSdkClient -------------------------------------------------------------


class _LowLevelClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any], type]] = []
        self.error: Exception | None = None

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        response_model: type,
    ) -> Any:
        self.requests.append((method, dict(params), response_model))
        if self.error is not None:
            raise self.error
        return response_model()

    async def thread_start(self, params: Any) -> Any:
        _ = params
        return None

    async def turn_start(self, params: Any) -> Any:
        _ = params
        return None


class _NativeClient:
    def __init__(self) -> None:
        self._client = _LowLevelClient()


def test_codex_sdk_client_archives_and_unarchives_through_app_server() -> None:
    async def run() -> None:
        native = _NativeClient()
        client = CodexSdkClient(native)

        await client.set_thread_archived(THREAD, archived=True)
        await client.set_thread_archived(THREAD, archived=False)

        assert [
            (method, params) for method, params, _model in native._client.requests
        ] == [
            ("thread/archive", {"threadId": THREAD}),
            ("thread/unarchive", {"threadId": THREAD}),
        ]
        assert all(
            model is CodexThreadArchiveResponse
            for _method, _params, model in native._client.requests
        )

    asyncio.run(run())


def test_codex_sdk_client_reports_archive_method_missing_as_invalid_request() -> None:
    async def run() -> None:
        native = _NativeClient()
        native._client.error = MethodNotFoundError(-32601, "Method not found")
        client = CodexSdkClient(native)

        with pytest.raises(RuntimeInvalidRequestError, match="native archive"):
            await client.set_thread_archived(THREAD, archived=True)

    asyncio.run(run())


def test_codex_sdk_client_propagates_other_native_archive_errors() -> None:
    async def run() -> None:
        native = _NativeClient()
        native._client.error = JsonRpcError(
            -32600,
            "thread already has an active writer",
        )
        client = CodexSdkClient(native)

        with pytest.raises(JsonRpcError, match="active writer"):
            await client.set_thread_archived(THREAD, archived=True)

    asyncio.run(run())


# -- CodexRuntime.update_session_archive ----------------------------------------


class _ArchiveClient(FakeCodexClient):
    def __init__(self) -> None:
        super().__init__()
        self.archives: list[tuple[str, bool]] = []
        self.archive_error: Exception | None = None

    async def set_thread_archived(self, thread_id: str, archived: bool) -> None:
        if self.archive_error is not None:
            raise self.archive_error
        self.archives.append((thread_id, archived))


class _IpcOwner:
    def __init__(self) -> None:
        self.announced: list[str] = []
        self.detached = False

    async def announce_thread_unarchived(self, thread_id: str) -> bool:
        self.announced.append(thread_id)
        return True

    def detach(self) -> None:
        self.detached = True


async def _started_runtime(
    client: _ArchiveClient | None = None,
) -> tuple[CodexRuntime, _ArchiveClient]:
    archive_client = client or _ArchiveClient()
    runtime = CodexRuntime(
        config=_config(),
        host=FakeHost(),
        client=archive_client,
    )
    await runtime.start()
    return runtime, archive_client


def _expected(
    *,
    session_id: str = "sess_1",
    thread_id: str | None = THREAD,
    archived: bool = True,
    supported: bool = True,
    status: str = "archived",
    reason: str | None = None,
) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "externalSessionId": thread_id,
        "archived": archived,
        "native": True,
        "supported": supported,
        "status": status,
        "reason": reason,
    }


def test_codex_runtime_archives_native_thread() -> None:
    async def run() -> None:
        runtime, client = await _started_runtime()
        try:
            result = await runtime.update_session_archive(
                "sess_1",
                external_session_id=THREAD,
                archived=True,
            )
        finally:
            await runtime.stop()

        assert result == _expected(status="archived")
        assert client.archives == [(THREAD, True)]

    asyncio.run(run())


def test_codex_runtime_restores_native_thread_and_announces_to_codex_app() -> None:
    async def run() -> None:
        runtime, client = await _started_runtime()
        owner = _IpcOwner()
        runtime.ipc_owner = owner  # type: ignore[assignment]
        try:
            result = await runtime.update_session_archive(
                "sess_1",
                external_session_id=THREAD,
                archived=False,
            )
        finally:
            await runtime.stop()

        assert result == _expected(archived=False, status="restored")
        assert client.archives == [(THREAD, False)]
        assert owner.announced == [THREAD]
        assert owner.detached is True

    asyncio.run(run())


def test_codex_runtime_archive_does_not_announce_unarchived() -> None:
    async def run() -> None:
        runtime, _client = await _started_runtime()
        owner = _IpcOwner()
        runtime.ipc_owner = owner  # type: ignore[assignment]
        try:
            await runtime.update_session_archive(
                "sess_1",
                external_session_id=THREAD,
                archived=True,
            )
        finally:
            await runtime.stop()

        assert owner.announced == []

    asyncio.run(run())


def test_codex_runtime_archive_skips_when_not_running() -> None:
    async def run() -> None:
        client = _ArchiveClient()
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

        result = await runtime.update_session_archive(
            "sess_1",
            external_session_id=THREAD,
            archived=True,
        )

        assert result == _expected(
            supported=True,
            status="skipped",
            reason="runtime_not_running",
        )
        assert client.archives == []

    asyncio.run(run())


def test_codex_runtime_archive_reports_unknown_native_session() -> None:
    async def run() -> None:
        runtime, client = await _started_runtime()
        try:
            result = await runtime.update_session_archive(
                "sess_1",
                archived=True,
            )
        finally:
            await runtime.stop()

        assert result == _expected(
            thread_id=None,
            supported=False,
            status="unsupported",
            reason="native_session_unknown",
        )
        assert client.archives == []

    asyncio.run(run())


def test_codex_runtime_archive_resolves_native_id_from_state_cache() -> None:
    async def run() -> None:
        runtime, client = await _started_runtime()
        try:
            await runtime._session_states.update(
                "sess_1",
                THREAD,
                "idle",
            )
            result = await runtime.update_session_archive("sess_1", archived=True)
        finally:
            await runtime.stop()

        assert result == _expected()
        assert client.archives == [(THREAD, True)]

    asyncio.run(run())


def test_codex_runtime_archive_skips_session_with_running_turn() -> None:
    async def run() -> None:
        runtime, client = await _started_runtime()
        runtime._active_turn_ids["sess_1"] = "turn_1"
        try:
            result = await runtime.update_session_archive(
                "sess_1",
                external_session_id=THREAD,
                archived=True,
            )
        finally:
            await runtime.stop()

        assert result == _expected(
            supported=True,
            status="skipped",
            reason="session_running",
        )
        assert client.archives == []

    asyncio.run(run())


def test_codex_runtime_archive_maps_missing_method_to_unsupported() -> None:
    async def run() -> None:
        client = _ArchiveClient()
        client.archive_error = RuntimeInvalidRequestError(
            "Codex app-server does not support native archive"
        )
        runtime, _client = await _started_runtime(client)
        try:
            result = await runtime.update_session_archive(
                "sess_1",
                external_session_id=THREAD,
                archived=True,
            )
        finally:
            await runtime.stop()

        assert result == _expected(
            supported=False,
            status="unsupported",
            reason="unsupported",
        )

    asyncio.run(run())


@pytest.mark.parametrize(
    ("error", "reason"),
    (
        (JsonRpcError(-32600, "thread already has an active writer"), "session_locked"),
        (JsonRpcError(-32600, "thread not found: 01a1"), "thread_not_found"),
        (RuntimeError("transport exploded"), "native_error"),
    ),
)
def test_codex_runtime_archive_reports_failures_not_raise(
    error: Exception,
    reason: str,
) -> None:
    async def run() -> None:
        client = _ArchiveClient()
        client.archive_error = error
        runtime, _client = await _started_runtime(client)
        try:
            result = await runtime.update_session_archive(
                "sess_1",
                external_session_id=THREAD,
                archived=True,
            )
        finally:
            await runtime.stop()

        assert result == _expected(
            supported=True,
            status="failed",
            reason=reason,
        )

    asyncio.run(run())


# -- CodexIpcOwnerService.announce_thread_unarchived ---------------------------


class _BroadcastClient:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.broadcasts: list[tuple[str, Any]] = []

    async def broadcast(self, method: str, params: Any) -> None:
        if self.error is not None:
            raise self.error
        self.broadcasts.append((method, params))


def _ipc_owner(client: Any) -> CodexIpcOwnerService:
    return CodexIpcOwnerService(
        client=client,
        sdk=None,  # type: ignore[arg-type]
        session_states=RuntimeSessionStateCache("codex", FakeHost()),
        notices=CodexNoticeRegistry(),
        active_turn_ids={},
        session_id_for=lambda thread_id: f"sess_{thread_id}",
    )


def test_codex_ipc_owner_announces_thread_unarchived() -> None:
    async def run() -> None:
        client = _BroadcastClient()
        owner = _ipc_owner(client)

        announced = await owner.announce_thread_unarchived(THREAD)

        assert announced is True
        assert client.broadcasts == [
            (
                "thread-unarchived",
                {"hostId": "local", "conversationId": THREAD},
            )
        ]

    asyncio.run(run())


def test_codex_ipc_owner_swallows_announce_failures() -> None:
    async def run() -> None:
        client = _BroadcastClient(RuntimeError("ipc closed"))
        owner = _ipc_owner(client)

        announced = await owner.announce_thread_unarchived(THREAD)

        assert announced is False
        assert client.broadcasts == []

    asyncio.run(run())
