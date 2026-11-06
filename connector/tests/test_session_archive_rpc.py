from __future__ import annotations

import asyncio
from typing import Any

import pytest

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeUnsupportedError,
)
from connector.server.runtime_rpc import RuntimeRpcHandler


class _Host(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"


class _Supervisor:
    """Only the lookup the handler needs; the RPC layer owns the rest."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self.runtime = runtime
        self.resolved: list[tuple[str, str]] = []

    def resolve_runtime(self, runtime_id: str, runtime_type: str) -> AgentRuntime:
        self.resolved.append((runtime_id, runtime_type))
        return self.runtime


class _ArchiveRuntime(AgentRuntime):
    def __init__(
        self,
        *,
        result: dict[str, Any] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result
        self.error = error
        self.calls: list[dict[str, Any]] = []

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="codex",
            runtime_id="rti_test",
            runtime_version="test",
        )

    async def update_session_archive(
        self,
        session_id: str,
        *,
        external_session_id: str | None = None,
        archived: bool,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "sessionId": session_id,
                "externalSessionId": external_session_id,
                "archived": archived,
            }
        )
        if self.error is not None:
            raise self.error
        return dict(self.result or {})


class _PlainRuntime(AgentRuntime):
    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="pi",
            runtime_id="rti_pi",
            runtime_version="test",
        )


def _handler(runtime: AgentRuntime) -> RuntimeRpcHandler:
    return RuntimeRpcHandler(_Supervisor(runtime), _Host())  # type: ignore[arg-type]


def _request(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "runtime": "codex",
        "runtimeId": "rti_test",
        "sessionId": "sess_1",
        "externalSessionId": "thread_1",
        "archived": True,
    }
    params.update(overrides)
    return params


def test_runtime_rpc_supports_session_archive() -> None:
    assert _handler(_PlainRuntime()).supports("session.archive")


def test_session_archive_dispatch_returns_runtime_result() -> None:
    async def run() -> None:
        runtime = _ArchiveRuntime(
            result={
                "sessionId": "sess_1",
                "externalSessionId": "thread_1",
                "archived": True,
                "native": True,
                "supported": True,
                "status": "archived",
                "reason": None,
            }
        )
        supervisor = _Supervisor(runtime)
        result = await RuntimeRpcHandler(supervisor, _Host()).dispatch(  # type: ignore[arg-type]
            "session.archive",
            _request(),
        )

        assert supervisor.resolved == [("rti_test", "codex")]
        assert runtime.calls == [
            {
                "sessionId": "sess_1",
                "externalSessionId": "thread_1",
                "archived": True,
            }
        ]
        assert result == {
            "sessionId": "sess_1",
            "externalSessionId": "thread_1",
            "archived": True,
            "native": True,
            "supported": True,
            "status": "archived",
            "reason": None,
            "runtime": "codex",
            "runtimeId": "rti_test",
        }

    asyncio.run(run())


def test_session_archive_dispatch_accepts_missing_external_session_id() -> None:
    async def run() -> None:
        runtime = _ArchiveRuntime(
            result={
                "sessionId": "sess_1",
                "externalSessionId": None,
                "archived": False,
                "native": True,
                "supported": False,
                "status": "unsupported",
                "reason": "native_session_unknown",
            }
        )
        params = _request(archived=False)
        params.pop("externalSessionId")
        result = await _handler(runtime).dispatch("session.archive", params)

        assert runtime.calls == [
            {"sessionId": "sess_1", "externalSessionId": None, "archived": False}
        ]
        assert result["externalSessionId"] is None
        assert result["status"] == "unsupported"

    asyncio.run(run())


def test_session_archive_dispatch_defaults_to_unsupported_result() -> None:
    async def run() -> None:
        result = await _handler(_PlainRuntime()).dispatch(
            "session.archive",
            _request(),
        )

        assert result == {
            "sessionId": "sess_1",
            "externalSessionId": "thread_1",
            "archived": True,
            "native": False,
            "supported": False,
            "status": "unsupported",
            "reason": "unsupported",
            "runtime": "pi",
            "runtimeId": "rti_pi",
        }

    asyncio.run(run())


def test_agent_runtime_default_update_session_archive_is_unsupported() -> None:
    with pytest.raises(RuntimeUnsupportedError):
        asyncio.run(
            _PlainRuntime().update_session_archive(
                "sess_1",
                external_session_id="thread_1",
                archived=True,
            )
        )


@pytest.mark.parametrize(
    ("params", "message"),
    (
        ({k: v for k, v in _request().items() if k != "sessionId"}, "sessionId is required"),
        ({**_request(), "sessionId": ""}, "sessionId is required"),
        ({k: v for k, v in _request().items() if k != "archived"}, "archived is required"),
        ({**_request(), "archived": "true"}, "archived is required"),
        ({**_request(), "archived": 1}, "archived is required"),
    ),
)
def test_session_archive_rejects_invalid_params(
    params: dict[str, Any],
    message: str,
) -> None:
    async def run() -> None:
        with pytest.raises(RuntimeInvalidRequestError) as exc_info:
            await _handler(_ArchiveRuntime()).dispatch("session.archive", params)
        assert message in str(exc_info.value)

    asyncio.run(run())


def test_session_archive_propagates_unexpected_runtime_errors() -> None:
    async def run() -> None:
        with pytest.raises(RuntimeError, match="boom"):
            await _handler(_ArchiveRuntime(error=RuntimeError("boom"))).dispatch(
                "session.archive",
                _request(),
            )

    asyncio.run(run())
