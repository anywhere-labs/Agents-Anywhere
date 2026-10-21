"""DSH command adapter against a fake BridgeClient.

The adapter's contract is method calls and error mapping, not JSON-RPC
framing, so a recorder replaces the removed TCP transport. Native DSH
semantics themselves are tested in the plugin.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeConfig, RuntimeUnsupportedError
from connector.runtimes.dsh.bridge.client import BridgeRpcError, BridgeUnavailableError
from connector.runtimes.dsh.provider_config import dsh_capabilities
from connector.runtimes.dsh.runtime import DshRuntime

MALFORMED_ACKS: dict[str, Any] = {
    "empty": {},
    "no-command": {"ok": True, "result": {"kind": "success", "commandId": "one"}},
    "null-command": {"command": None, "ok": True, "result": {"kind": "success", "commandId": "one"}},
    "numeric-command": {"command": 7, "ok": True, "result": {"kind": "success", "commandId": "one"}},
    "empty-command": {"command": "", "ok": True, "result": {"kind": "success", "commandId": "one"}},
    "no-ok": {"command": "compact", "result": {"kind": "success", "commandId": "one"}},
    "null-ok": {"command": "compact", "ok": None, "result": {"kind": "success", "commandId": "one"}},
    "numeric-ok": {"command": "compact", "ok": 1, "result": {"kind": "success", "commandId": "one"}},
    "no-result": {"command": "compact", "ok": True},
    "empty-result": {"command": "compact", "ok": True, "result": {}},
    "wrong-result-type": {"command": "compact", "ok": True, "result": []},
    "wrong-kind": {"command": "compact", "ok": True, "result": {"kind": "error", "commandId": "one"}},
    "array-kind": {"command": "compact", "ok": True, "result": {"kind": [], "commandId": "one"}},
    "no-kind": {"command": "compact", "ok": True, "result": {"commandId": "one"}},
    "no-id": {"command": "compact", "ok": True, "result": {"kind": "success"}},
    "no-success-state": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": "one"}},
    "numeric-id": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": 7}},
    "empty-id": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": ""}},
    "negative-seq": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": "one", "sourceEventSeq": -1}},
    "boolean-seq": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": "one", "sourceEventSeq": True}},
    "invalid-text": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": "one", "text": 8}},
    "invalid-state": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": "one", "executionState": "unknown"}},
    "array-state": {"command": "compact", "ok": True, "result": {"kind": "success", "commandId": "one", "executionState": []}},
    "error-source-seq": {"command": "compact", "ok": False, "code": "command_error", "result": {"kind": "error", "commandId": "one", "sourceEventSeq": 1}},
    "false-success": {"command": "compact", "ok": False, "code": "command_error", "result": {"kind": "success", "commandId": "one"}},
    "error-without-id": {"command": "compact", "ok": False, "code": "command_error", "result": {"kind": "error"}},
    "no-error-state": {"command": "compact", "ok": False, "code": "command_error", "result": {"kind": "error", "commandId": "one"}},
    "failed-without-code": {"command": "compact", "ok": False, "result": {}},
    "invalid-retryability": {"command": "compact", "ok": False, "code": "command_outcome_unknown", "result": {"executionState": "unknown", "retryable": True}},
    "missing-unknown-state": {"command": "compact", "ok": False, "code": "command_outcome_unknown", "result": {}},
    "missing-no-retry": {"command": "compact", "ok": False, "code": "command_failed", "result": {"executionState": "unknown"}},
    "validation-with-unknown-state": {"command": "compact", "ok": False, "code": "invalid_command", "result": {"executionState": "unknown", "retryable": False}},
    "native-error-wrong-code": {"command": "compact", "ok": False, "code": "invalid_command", "result": {"kind": "error", "commandId": "one", "executionState": "completed"}},
    "missing-native-error-kind": {"command": "compact", "ok": False, "code": "command_error", "result": {}},
    "unrecognized-validation-code": {"command": "compact", "ok": False, "code": "unexpected_code", "result": {}},
}


class FakeBridgeClient:
    """The BridgeClient surface the adapter uses: ``request`` and ``connected``."""

    def __init__(self, *, supported: bool = True, mode: str = "success") -> None:
        self.supported = supported
        self.mode = mode
        self.connected = True
        self.requests: list[dict[str, Any]] = []
        self.executed = asyncio.Event()
        # Never set: a call that stays in flight until its task is cancelled.
        self.in_flight = asyncio.Event()

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = dict(params or {})
        self.requests.append({"method": method, "params": params})
        if method == "getSessionCapabilities":
            return self._capabilities()
        if method == "listCommands":
            assert params == {"sessionId": "session", "externalSessionId": "native", "query": "compact", "limit": 1}
            return self._commands()
        if method == "executeCommand":
            self.executed.set()
            return await self._execute(params)
        raise AssertionError(f"unexpected request {method}")

    def _capabilities(self) -> dict[str, Any]:
        capabilities = [{
            "capabilityId": "session.commands",
            "supported": self.supported,
            "available": self.supported,
            "allowed": self.supported,
            "unavailableReason": None if self.supported else "This DSH capability is not available.",
            "metadata": {"catalogRevision": "host:2"} if self.supported else {},
        }]
        if self.mode == "old-empty":
            capabilities = []
        elif self.mode == "partial-capability":
            capabilities = [{"capabilityId": "session.commands"}]
        elif self.mode == "unavailable":
            capabilities[0].update({
                "available": False,
                "allowed": False,
                "unavailableReason": "DSH session is archived.",
            })
        return {"runtime": "dsh", "sessionId": "session", "revision": 7, "capabilities": capabilities}

    def _commands(self) -> dict[str, Any]:
        commands = [{
            "id": "compact",
            "title": "compact",
            "description": "native compact",
            "acceptsArgs": True,
            "metadata": {
                "definitionId": "compact-plugin",
                "input": {"hint": "text", "attachments": True},
                "attachmentsAvailable": False,
                "ui": {"kind": "execute", "acceptsMultiline": True, "allowedStatuses": ["idle", "running"]},
            },
        }]
        if self.mode == "wide-catalog":
            commands.extend({"id": name, "title": name} for name in ["export", "goal", "permission"])
        return {"commands": commands}

    async def _execute(self, params: dict[str, Any]) -> dict[str, Any]:
        if self.mode == "pending":
            await self.in_flight.wait()
        if self.mode == "timeout":
            # The transport's own deadline surfaces as TimeoutError from request().
            raise TimeoutError("deadline exceeded")
        if self.mode == "rpc-timeout":
            raise BridgeRpcError("REQUEST_TIMEOUT", "cancelled", retryable=True)
        if self.mode == "disconnect":
            raise BridgeUnavailableError("DSH bridge left the local router")
        command = params["command"]
        result: dict[str, Any] = {
            "command": command,
            "ok": self.mode != "error",
            "message": "native acknowledgement",
            "result": {
                "commandId": "native-command-7",
                "kind": "error" if self.mode == "error" else "success",
                "text": "native acknowledgement",
                "executionState": "completed" if self.mode == "error" else "accepted",
            },
        }
        if self.mode == "error":
            result["code"] = "command_error"
        else:
            result["result"]["sourceEventSeq"] = 12
        if self.mode == "wrong-command":
            result["command"] = "another"
        elif self.mode == "error-kind":
            result["result"]["kind"] = "error"
        elif self.mode in MALFORMED_ACKS:
            result = MALFORMED_ACKS[self.mode]
        elif self.mode == "validation-failed":
            result = {"command": command, "ok": False, "code": "invalid_command", "message": "raw mismatch", "result": {}}
        return result

    async def close(self) -> None:
        self.connected = False


@asynccontextmanager
async def bridge(
    *, supported: bool = True, mode: str = "success",
) -> AsyncIterator[tuple[DshRuntime, list[dict[str, Any]], asyncio.Event]]:
    client = FakeBridgeClient(supported=supported, mode=mode)
    runtime = DshRuntime(RuntimeConfig("dsh", 2), SimpleNamespace(connector_id="test"))
    runtime._client = client
    try:
        yield runtime, client.requests, client.executed
    finally:
        await client.close()


def test_public_catalog_execution_preserves_native_descriptor_and_raw_correlations() -> None:
    async def run() -> None:
        async with bridge() as (runtime, requests, _):
            catalog = await runtime.list_commands("session", "native", query="compact", limit=1)
            assert len(catalog) == 1
            assert catalog[0].id == "compact" and catalog[0].accepts_args
            assert catalog[0].metadata["input"] == {"hint": "text", "attachments": True}
            assert catalog[0].metadata["attachmentsAvailable"] is False
            assert catalog[0].metadata["ui"]["acceptsMultiline"] is True
            raw = "/compact  first\nsecond  "
            result = await runtime.execute_command("session", "compact", "native", raw=raw, args=("ignored",))
            assert result.ok and result.message == "native acknowledgement"
            assert result.result == {"commandId": "native-command-7", "kind": "success", "text": "native acknowledgement", "sourceEventSeq": 12, "executionState": "accepted"}
            execution = [request for request in requests if request["method"] == "executeCommand"]
            assert len(execution) == 1
            assert execution[0]["params"] == {"sessionId": "session", "externalSessionId": "native", "command": "compact", "raw": raw, "args": ["ignored"]}
    asyncio.run(run())


@pytest.mark.parametrize("command", ["goal", "plan", "export", "feedback", "permission", "model", "file", "compact-thread"])
def test_non_compact_commands_never_reach_the_bridge(command: str) -> None:
    async def run() -> None:
        async with bridge() as (runtime, requests, _):
            result = await runtime.execute_command("session", command, "native", raw=f"/{command}")
            assert not result.ok and result.code == "unknown_command"
            assert not any(request["method"] == "executeCommand" for request in requests)
    asyncio.run(run())


def test_catalog_filters_non_compact_commands_from_an_older_bridge() -> None:
    async def run() -> None:
        async with bridge(mode="wide-catalog") as (runtime, _, _):
            catalog = await runtime.list_commands("session", "native", query="compact", limit=1)
            assert [command.id for command in catalog] == ["compact"]
    asyncio.run(run())


def test_old_bridge_remains_unavailable_with_upgrade_reason_and_no_command_rpc() -> None:
    async def run() -> None:
        async with bridge(supported=False) as (runtime, requests, _):
            capability = (await runtime.get_session_capabilities("session", "native")).capabilities[0]
            assert not capability.available
            assert "upgrade" in (capability.unavailable_reason or "").lower()
            result = await runtime.execute_command("session", "compact", "native", raw="/compact hi")
            assert not result.ok and result.code == "bridge_upgrade_required"
            assert not any(request["method"] == "executeCommand" for request in requests)
    asyncio.run(run())
    assert not dsh_capabilities({"capabilities": []})["commands"]
    assert dsh_capabilities({"capabilities": [{"capabilityId": "session.commands", "supported": True, "available": True, "allowed": True}]})["commands"]
    assert dsh_capabilities({"capabilities": []})["sessionNotices"] is True
    assert not dsh_capabilities({"capabilities": []})["interactions"]
    assert dsh_capabilities({"capabilities": [{"capabilityId": "session.interaction.approval", "supported": True, "available": True, "allowed": True}]})["interactions"]


def test_public_native_error_is_not_success() -> None:
    async def run() -> None:
        async with bridge(mode="error") as (runtime, _, _):
            result = await runtime.execute_command("session", "compact", "native", raw="/compact invalid")
            assert not result.ok
            assert result.result["kind"] == "error"
            assert result.result["commandId"] == "native-command-7"
            assert result.result["executionState"] == "completed"
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["timeout", "rpc-timeout", "disconnect"])
def test_ambiguous_execution_never_retries_and_exposes_unknown_state(mode: str) -> None:
    async def run() -> None:
        async with bridge(mode=mode) as (runtime, requests, _):
            result = await runtime.execute_command("session", "compact", "native", raw="/compact once")
            assert not result.ok and result.code == "command_outcome_unknown"
            assert result.result == {"executionState": "unknown", "retryable": False}
            assert len([request for request in requests if request["method"] == "executeCommand"]) == 1
    asyncio.run(run())


def test_python_cancellation_propagates_to_the_bridge_call() -> None:
    async def run() -> None:
        async with bridge(mode="pending") as (runtime, requests, entered):
            task = asyncio.create_task(runtime.execute_command("session", "compact", "native", raw="/compact once"))
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert len([request for request in requests if request["method"] == "executeCommand"]) == 1
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["old-empty", "partial-capability", "unavailable"])
def test_missing_partial_or_session_unavailable_capability_never_dispatches(mode: str) -> None:
    async def run() -> None:
        async with bridge(mode=mode) as (runtime, requests, _):
            with pytest.raises(RuntimeUnsupportedError):
                await runtime.list_commands("session", "native", query="compact", limit=1)
            result = await runtime.execute_command("session", "compact", "native", raw="/compact hi")
            assert not result.ok
            assert result.code == ("commands_unavailable" if mode == "unavailable" else "bridge_upgrade_required")
            assert not any(request["method"] in {"executeCommand", "listCommands"} for request in requests)
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["wrong-command", "error-kind"])
def test_result_identity_or_error_kind_cannot_be_reported_as_success(mode: str) -> None:
    async def run() -> None:
        async with bridge(mode=mode) as (runtime, _, _):
            result = await runtime.execute_command("session", "compact", "native", raw="/compact hi")
            assert not result.ok
            assert result.command == "compact"
            assert result.result == {"executionState": "unknown", "retryable": False}
    asyncio.run(run())


@pytest.mark.parametrize("mode", MALFORMED_ACKS)
def test_authenticated_public_execution_rejects_incomplete_or_malformed_ack_without_retry(mode: str) -> None:
    async def run() -> None:
        async with bridge(mode=mode) as (runtime, requests, _):
            result = await runtime.execute_command("session", "compact", "native", raw="/compact once")
            assert result.command == "compact"
            assert result.ok is False and result.code == "command_outcome_unknown"
            assert result.result == {"executionState": "unknown", "retryable": False}
            assert len([request for request in requests if request["method"] == "executeCommand"]) == 1
    asyncio.run(run())


def test_authenticated_public_execution_preserves_known_validation_without_correlation() -> None:
    async def run() -> None:
        async with bridge(mode="validation-failed") as (runtime, requests, _):
            result = await runtime.execute_command("session", "compact", "native", raw="/permission")
            assert not result.ok and result.code == "invalid_command"
            assert result.result == {} and result.message == "raw mismatch"
            assert len([request for request in requests if request["method"] == "executeCommand"]) == 1
    asyncio.run(run())
