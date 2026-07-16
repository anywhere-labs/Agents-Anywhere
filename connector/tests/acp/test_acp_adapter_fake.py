from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from connector.acp.adapter import AcpAdapter
from connector.acp.manifest import AgentManifest
from connector.launch import LaunchTarget
from tests.contract.helpers import (
    assert_approval_schema,
    assert_timeline_item_schema,
    assert_turn_lifecycle,
    collect_item_upserts,
)

_CWD = str(Path(__file__).resolve().parents[2])


def _fake_manifest(**quirks) -> AgentManifest:
    return AgentManifest(
        id="fake_acp",
        display_name="Fake ACP",
        command=(sys.executable,),
        args=("-m", "tests.acp.fake_agent"),
        which=(),
        env_paths=(),
        quirks=dict(quirks) if quirks else {},
    )


def _launch() -> LaunchTarget:
    return LaunchTarget(source="test", path=sys.executable, launcher="direct")


def _fake_client_factory(cmd, env, cwd):
    from connector.acp.rpc import AcpJsonRpcClient

    # Process cwd is launch context only (None); session cwd comes from session/new.
    return AcpJsonRpcClient(
        [sys.executable, "-m", "tests.acp.fake_agent"],
        env=env,
        cwd=None,
    )


@pytest.mark.contract
def test_acp_adapter_basic_text_turn_with_fake_agent(monkeypatch) -> None:
    monkeypatch.chdir(_CWD)
    monkeypatch.setenv("FAKE_ACP_SCENARIO", "basic_text")

    notifications: list[tuple[str, dict]] = []

    async def sink(method: str, params: dict) -> None:
        notifications.append((method, params))

    adapter = AcpAdapter(
        manifest=_fake_manifest(),
        notification_sink=sink,
        launch=_launch(),
        client_factory=_fake_client_factory,
    )

    async def run() -> None:
        created = await adapter.create_session({"sessionId": "sess_1", "cwd": _CWD})
        assert created["sessionId"] == "sess_1"
        assert created["externalSessionId"] == "acp_sess_fake_1"
        started = await adapter.start_turn(
            {
                "sessionId": "sess_1",
                "content": "Reply with PONG",
                "clientMessageId": "cm_1",
                "cwd": _CWD,
            }
        )
        assert "turnId" in started
        runtime = adapter._sessions["sess_1"]
        if runtime.active_task is not None:
            await runtime.active_task
        await adapter.close()

    asyncio.run(run())

    items = collect_item_upserts(notifications)
    assert items
    for item in items:
        assert_timeline_item_schema(item, runtime="fake_acp")
    assert_turn_lifecycle(items)
    texts = [
        item["content"].get("text")
        for item in items
        if item.get("type") == "message" and item.get("role") == "assistant"
    ]
    assert any(t == "PONG" for t in texts)


@pytest.mark.contract
def test_acp_adapter_user_triggered_interactive_auth(monkeypatch) -> None:
    """User-triggered login may call interactive methods; discovery must not."""
    monkeypatch.chdir(_CWD)
    monkeypatch.setenv("FAKE_ACP_SCENARIO", "interactive_auth")

    notifications: list[tuple[str, dict]] = []

    async def sink(method: str, params: dict) -> None:
        notifications.append((method, params))

    adapter = AcpAdapter(
        manifest=_fake_manifest(),
        notification_sink=sink,
        launch=_launch(),
        client_factory=_fake_client_factory,
    )

    async def run() -> None:
        # Without auth, session creation fails.
        with pytest.raises(Exception, match="[Aa]uth"):
            await adapter.create_session({"sessionId": "sess_auth", "cwd": _CWD})

        result = await adapter.authenticate_interactive({"methodId": "external"})
        assert result["authStatus"] == "ok"
        assert result["methodId"] == "external"
        assert any(m["value"] == "live-model-a" for m in result.get("modelOptions") or [])

        created = await adapter.create_session({"sessionId": "sess_auth2", "cwd": _CWD})
        assert created["externalSessionId"]
        await adapter.close()

    asyncio.run(run())

    option_updates = [p for m, p in notifications if m == "runtime.optionsUpdated"]
    assert option_updates
    assert option_updates[-1].get("authStatus") == "ok"
    assert option_updates[-1].get("modelOptions")


@pytest.mark.contract
def test_acp_adapter_requires_cwd() -> None:
    adapter = AcpAdapter(manifest=_fake_manifest(), client_factory=_fake_client_factory)

    async def run() -> None:
        with pytest.raises(ValueError, match="missing cwd"):
            await adapter.create_session({"sessionId": "sess_1"})

    asyncio.run(run())


@pytest.mark.contract
def test_acp_adapter_rejects_concurrent_turns(monkeypatch) -> None:
    monkeypatch.chdir(_CWD)
    monkeypatch.setenv("FAKE_ACP_SCENARIO", "cancel")

    adapter = AcpAdapter(
        manifest=_fake_manifest(maxTurnSeconds=30),
        client_factory=_fake_client_factory,
    )

    async def run() -> None:
        await adapter.create_session({"sessionId": "sess_1", "cwd": _CWD})
        await adapter.start_turn({"sessionId": "sess_1", "content": "long", "cwd": _CWD})
        with pytest.raises(Exception, match="already running"):
            await adapter.start_turn({"sessionId": "sess_1", "content": "again", "cwd": _CWD})
        await adapter.interrupt_turn({"sessionId": "sess_1"})
        runtime = adapter._sessions["sess_1"]
        if runtime.active_task is not None:
            await runtime.active_task
        await adapter.close()

    asyncio.run(run())


@pytest.mark.contract
def test_acp_adapter_interrupt_with_fake_agent(monkeypatch) -> None:
    monkeypatch.chdir(_CWD)
    monkeypatch.setenv("FAKE_ACP_SCENARIO", "cancel")

    notifications: list[tuple[str, dict]] = []

    async def sink(method: str, params: dict) -> None:
        notifications.append((method, params))

    adapter = AcpAdapter(
        manifest=_fake_manifest(),
        notification_sink=sink,
        client_factory=_fake_client_factory,
    )

    async def run() -> None:
        await adapter.create_session({"sessionId": "sess_1", "cwd": _CWD})
        await adapter.start_turn({"sessionId": "sess_1", "content": "long", "cwd": _CWD})
        await asyncio.sleep(0.1)
        result = await adapter.interrupt_turn({"sessionId": "sess_1"})
        assert result.get("interrupted") is True
        runtime = adapter._sessions["sess_1"]
        if runtime.active_task is not None:
            await runtime.active_task
        await adapter.close()

    asyncio.run(run())
    items = collect_item_upserts(notifications)
    ends = [i for i in items if i.get("type") == "turn.end"]
    assert ends
    assert ends[-1]["status"] in {"interrupted", "done", "cancelled"}


@pytest.mark.contract
def test_acp_adapter_permission_bridge_waits_for_resolve(monkeypatch) -> None:
    monkeypatch.chdir(_CWD)
    monkeypatch.setenv("FAKE_ACP_SCENARIO", "tool_permission")

    notifications: list[tuple[str, dict]] = []

    async def sink(method: str, params: dict) -> None:
        notifications.append((method, params))

    adapter = AcpAdapter(
        manifest=_fake_manifest(),
        notification_sink=sink,
        client_factory=_fake_client_factory,
    )

    async def run() -> None:
        await adapter.create_session({"sessionId": "sess_1", "cwd": _CWD})
        started = await adapter.start_turn(
            {"sessionId": "sess_1", "content": "run tool", "cwd": _CWD}
        )
        # Wait until approval is requested (server request handled on background task).
        approval_id = None
        for _ in range(50):
            for method, params in notifications:
                if method == "approval.requested":
                    approval_id = params.get("id")
                    break
            if approval_id:
                break
            await asyncio.sleep(0.05)
        assert approval_id, "expected approval.requested notification"
        assert_approval_schema(
            next(p for m, p in notifications if m == "approval.requested"),
            runtime="fake_acp",
        )
        resolved = await adapter.resolve_approval(
            {
                "sessionId": "sess_1",
                "approvalId": approval_id,
                "status": "approved",
            }
        )
        assert resolved.get("resolved") is True
        runtime = adapter._sessions["sess_1"]
        if runtime.active_task is not None:
            await asyncio.wait_for(runtime.active_task, timeout=10)
        await adapter.close()
        return started

    asyncio.run(run())
    items = collect_item_upserts(notifications)
    assert_turn_lifecycle(items)
    assert any(i.get("type") == "tool" for i in items)


@pytest.mark.contract
def test_acp_adapter_rewire_closes_previous_client(monkeypatch) -> None:
    monkeypatch.chdir(_CWD)
    monkeypatch.setenv("FAKE_ACP_SCENARIO", "basic_text")

    closed: list[bool] = []

    def factory(cmd, env, cwd):
        from connector.acp.rpc import AcpJsonRpcClient

        client = AcpJsonRpcClient(
            [sys.executable, "-m", "tests.acp.fake_agent"],
            env=env,
            cwd=None,
        )
        original_close = client.close

        async def close_and_track() -> None:
            closed.append(True)
            await original_close()

        client.close = close_and_track  # type: ignore[method-assign]
        return client

    adapter = AcpAdapter(manifest=_fake_manifest(), client_factory=factory)

    async def run() -> None:
        await adapter.create_session({"sessionId": "sess_1", "cwd": _CWD})
        first = adapter._client
        assert first is not None
        adapter.rewire(LaunchTarget(source="test", path=sys.executable))
        # Next ensure should shut down previous process
        await adapter.create_session({"sessionId": "sess_2", "cwd": _CWD})
        assert closed, "expected previous ACP client to be closed on rewire"
        await adapter.close()

    asyncio.run(run())


@pytest.mark.contract
def test_manifest_builtins_load() -> None:
    from connector.acp.manifest import load_builtin_manifests

    manifests = load_builtin_manifests()
    ids = {m.id for m in manifests}
    assert {"gemini", "cursor", "codebuddy", "grok_build"} <= ids
