from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeHostClient,
    RuntimeUnsupportedError,
)
from connector.runtimes.claude.runtime import ClaudeRuntime


def test_claude_runtime_lifecycle_and_config() -> None:
    asyncio.run(_test_claude_runtime_lifecycle_and_config())


async def _test_claude_runtime_lifecycle_and_config() -> None:
    runtime = _runtime()

    assert runtime.identity.runtime == "claude"
    assert runtime.identity.display_name == "Claude"
    assert await runtime.get_config() == _config()

    await runtime.start()
    await runtime.stop()


def test_claude_runtime_reports_conservative_capabilities() -> None:
    asyncio.run(_test_claude_runtime_reports_conservative_capabilities())


async def _test_claude_runtime_reports_conservative_capabilities() -> None:
    runtime = _runtime()

    capability_set = await runtime.get_runtime_capabilities()

    assert capability_set.runtime == "claude"
    assert capability_set.connector_id == "conn_test"
    assert capability_set.capabilities
    assert {cap.capability_id for cap in capability_set.capabilities} >= {
        "session.send_message",
        "session.interrupt",
        "session.interaction.approval",
    }
    assert all(cap.supported is False for cap in capability_set.capabilities)


def test_claude_runtime_empty_reads_are_stable() -> None:
    asyncio.run(_test_claude_runtime_empty_reads_are_stable())


async def _test_claude_runtime_empty_reads_are_stable() -> None:
    runtime = _runtime()

    assert await runtime.list_sessions() == ()
    assert (await runtime.list_model_catalog()).models == ()
    assert (await runtime.list_permission_catalog()).permissions == ()


def test_claude_runtime_turns_remain_unsupported_until_sdk_driver_exists() -> None:
    asyncio.run(_test_claude_runtime_turns_remain_unsupported_until_sdk_driver_exists())


async def _test_claude_runtime_turns_remain_unsupported_until_sdk_driver_exists() -> None:
    runtime = _runtime()

    with pytest.raises(RuntimeUnsupportedError) as exc_info:
        await runtime.start_turn("sess_1", None, "hello")

    assert exc_info.value.method == "start_turn"


def _runtime() -> ClaudeRuntime:
    return ClaudeRuntime(
        config=_config(),
        host=_NoHost(),
        sdk_loader=lambda: SimpleNamespace(__version__="1.0"),
    )


def _config() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="claude",
        revision=1,
        values={"environment": {}},
    )


class _NoHost(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"
