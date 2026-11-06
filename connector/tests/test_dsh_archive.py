"""DSH native archive adapter against a fake BridgeClient.

The adapter's contract is the ``setSessionArchived`` call and its error
mapping, not JSON-RPC framing: every expected refusal is reported in the result
object and never fails the Server's archive API.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.runtimes.dsh.bridge.client import BridgeRpcError, BridgeUnavailableError
from connector.runtimes.dsh.runtime import DshRuntime

NATIVE_RESULT: dict[str, Any] = {
    "ok": True,
    "sessionId": "session",
    "externalSessionId": "native",
    "archived": True,
    "sourceState": {"availability": "archived", "reason": "archived_in_dsh", "observedAt": "now"},
}


class FakeBridgeClient:
    """The BridgeClient surface the adapter uses: ``request`` and ``connected``."""

    def __init__(self, *, result: Any = NATIVE_RESULT, error: BaseException | None = None) -> None:
        self.connected = True
        self.result = result
        self.error = error
        self.requests: list[dict[str, Any]] = []

    async def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self.requests.append({"method": method, "params": dict(params or {})})
        if self.error is not None:
            raise self.error
        return self.result


def runtime_with(client: FakeBridgeClient) -> DshRuntime:
    runtime = DshRuntime(RuntimeConfig("dsh", 2), SimpleNamespace(connector_id="test"))
    runtime._client = client
    return runtime


def archive(runtime: DshRuntime, *, archived: bool = True, external_session_id: str | None = "native") -> dict[str, Any]:
    return asyncio.run(runtime.update_session_archive(
        "session", external_session_id=external_session_id, archived=archived,
    ))


def test_archive_mirrors_the_native_state_and_reports_archived() -> None:
    client = FakeBridgeClient()
    result = archive(runtime_with(client))
    assert client.requests == [{
        "method": "setSessionArchived",
        "params": {"sessionId": "session", "externalSessionId": "native", "archived": True},
    }]
    assert result == {
        "sessionId": "session",
        "externalSessionId": "native",
        "archived": True,
        "native": True,
        "supported": True,
        "status": "archived",
        "reason": None,
    }


def test_restore_reports_restored_and_uses_the_native_id_the_bridge_resolves() -> None:
    client = FakeBridgeClient(result={"ok": True, "externalSessionId": "native"})
    result = archive(runtime_with(client), archived=False, external_session_id=None)
    assert client.requests[0]["params"] == {"sessionId": "session", "archived": False}
    assert result["externalSessionId"] == "native"
    assert result["archived"] is False
    assert result["status"] == "restored"
    assert result["native"] is True and result["supported"] is True


@pytest.mark.parametrize("code", ["METHOD_NOT_FOUND", "UNSUPPORTED_OPERATION"])
def test_an_older_bridge_is_reported_as_unsupported(code: str) -> None:
    result = archive(runtime_with(FakeBridgeClient(error=BridgeRpcError(code, "unknown method"))))
    assert result["native"] is True
    assert result["supported"] is False
    assert result["status"] == "unsupported"
    assert result["reason"] == "bridge_upgrade_required"


@pytest.mark.parametrize("code", ["SESSION_ACTIVE", "session_active"])
def test_a_running_session_is_skipped(code: str) -> None:
    result = archive(runtime_with(FakeBridgeClient(error=BridgeRpcError(code, "session is running"))))
    assert result["supported"] is True
    assert result["status"] == "skipped"
    assert result["reason"] == "session_active"


def test_an_unavailable_bridge_is_skipped() -> None:
    result = archive(runtime_with(FakeBridgeClient(error=BridgeUnavailableError("router is gone"))))
    assert result["status"] == "skipped"
    assert result["reason"] == "bridge_unavailable"


def test_a_bridge_that_cannot_be_started_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = DshRuntime(RuntimeConfig("dsh", 2), SimpleNamespace(connector_id="test"))

    async def unavailable() -> None:
        raise RuntimeUnavailableError("DSH bridge is stopping")

    monkeypatch.setattr(runtime, "_ensure_client", unavailable)
    result = archive(runtime)
    assert result["status"] == "skipped"
    assert result["reason"] == "bridge_unavailable"


def test_a_missing_client_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = DshRuntime(RuntimeConfig("dsh", 2), SimpleNamespace(connector_id="test"))

    async def connected() -> None:
        return None

    monkeypatch.setattr(runtime, "_ensure_client", connected)
    result = archive(runtime)
    assert result["status"] == "skipped"
    assert result["reason"] == "bridge_unavailable"


def test_another_bridge_error_is_a_failure_with_the_code_as_reason() -> None:
    result = archive(runtime_with(FakeBridgeClient(error=BridgeRpcError("PERSISTENCE_ERROR", "cannot write"))))
    assert result["status"] == "failed"
    assert result["reason"] == "persistence_error"
    assert result["supported"] is True


@pytest.mark.parametrize("payload", [
    {"ok": False, "code": "session_active"},
    {"ok": False, "code": "SESSION_ACTIVE"},
])
def test_a_structured_native_refusal_follows_the_same_mapping(payload: dict[str, Any]) -> None:
    result = archive(runtime_with(FakeBridgeClient(result=payload)))
    assert result["status"] == "skipped"
    assert result["reason"] == "session_active"


@pytest.mark.parametrize("result", [
    None,
    [],
    {"ok": False},
    {"ok": "yes"},
])
def test_a_malformed_ack_is_a_failure_not_an_exception(result: Any) -> None:
    reported = archive(runtime_with(FakeBridgeClient(result=result)))
    assert reported["status"] == "failed"
    assert reported["reason"] in {"invalid_response", "request_failed"}


def test_an_unexpected_error_is_a_failure_not_an_exception() -> None:
    reported = archive(runtime_with(FakeBridgeClient(error=RuntimeError("boom"))))
    assert reported["status"] == "failed"
    assert reported["reason"] == "request_failed"


@pytest.mark.parametrize("kwargs", [
    {"external_session_id": "", "archived": True},
    {"external_session_id": "native", "archived": "true"},
    {"external_session_id": "native", "archived": 1},
])
def test_invalid_parameters_are_rejected_without_a_bridge_call(kwargs: dict[str, Any]) -> None:
    client = FakeBridgeClient()
    with pytest.raises(RuntimeInvalidRequestError):
        asyncio.run(runtime_with(client).update_session_archive("session", **kwargs))
    assert client.requests == []


def test_an_invalid_session_identity_is_rejected() -> None:
    client = FakeBridgeClient()
    with pytest.raises(RuntimeInvalidRequestError):
        asyncio.run(runtime_with(client).update_session_archive("", archived=True))
    assert client.requests == []
