"""Codex through codex-acp: routing, message identity, steering, operations and following."""

import asyncio
import copy
from dataclasses import replace
from types import SimpleNamespace
from typing import ClassVar

import pytest
from acp import RequestError

from connector.runtimes.acp.domain.definitions import AcpError, LaunchDefinition
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.codex import CODEX, CodexDialect
from connector.runtimes.acp.profiles.codex.definition import (
    codex_runtime,
    prepare_launch,
)
from connector.runtimes.acp.profiles.codex.provider import CodexAcpProvider
from connector.runtimes.acp.profiles.codex.runtime import NATIVE_GENERATION
from connector.runtimes.acp.provider import AgentContext
from connector.runtimes.providers import default_runtime_providers

HANDSHAKE = {
    "protocolVersion": 1,
    "agentCapabilities": {
        "loadSession": True,
        "promptCapabilities": {"image": True},
        "sessionCapabilities": {"resume": {}, "list": {}, "close": {}},
    },
    "_meta": {
        "steering": {"supported": True},
        "codexIpc": {"version": 1, "automaticRouting": True, "mode": "follow", "queue": True},
    },
}


class Connection:
    def __init__(self, route="follow"):
        self.calls = []
        self.route = route
        self.history = [
            {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "earlier"}},
            {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "answer"}},
        ]

    def record(self, name, values):
        self.calls.append((name, values))

    async def resume_session(self, **values):
        self.record("resume", values)
        return {"configOptions": []}

    async def load_session(self, **values):
        self.record("load", values)
        return {"configOptions": []}

    async def prompt(self, **values):
        self.record("prompt", values)
        return {"stopReason": "end_turn"}

    async def list_sessions(self, **values):
        return {"sessions": [{"sessionId": "thread-1", "cwd": "/tmp", "title": "App thread"}]}

    async def ext_method(self, method, params):
        self.record(method, params)
        if method == "codex/session/inspect":
            return {"route": self.route}
        if method == "codex/session/read":
            return {"updates": self.history}
        if method == "codex/session/queue":
            return {"messages": [{"id": "q1", "text": "later"}]}
        if method == "session/steering":
            return {"outcome": "promptRequired", "reason": "noRunningTurn"}
        raise AssertionError(method)

    async def close_session(self, **values):
        self.record("close", values)

    async def close(self):
        pass


def client(connection=None, handshake=HANDSHAKE):
    updates = []

    async def on_update(session_id, value):
        updates.append(value)

    async def on_interaction(session_id, kind, value):
        return {"action": "accept", "optionId": "allow"}

    agent = AgentClient(on_update, on_interaction, dialect=CodexDialect())
    agent.connection = connection or Connection()
    agent.initialized(copy.deepcopy(handshake))
    return agent, updates


def test_registered_as_default_provider():
    assert "codex-acp" in {item.runtime_type for item in default_runtime_providers()}


def test_descriptor_and_configuration():
    provider = CodexAcpProvider()
    descriptor = asyncio.run(provider.discover())
    assert descriptor.implementation_type == "acp-stdio"
    assert descriptor.metadata["nativeHistory"] is True
    assert descriptor.maturity == "experimental"
    schema = asyncio.run(provider.get_config_schema())
    assert list(schema.schema["properties"]) == ["cliPath", "codexHome", "codexPath", "ipcSocket"]


def test_initialize_opts_into_owner_approvals_and_settings():
    assert CodexDialect().initialize_meta() == {"codexIpc": {"approvals": True, "settings": True}}


def test_resume_routes_automatically_and_declares_the_owner_queue():
    agent, _ = client()
    asyncio.run(agent.resume("thread-1", "/tmp", aa={"ownerGeneration": "g"}))
    name, values = agent.connection.calls[0]
    assert name == "resume"
    assert values["codexIpc"] == {"mode": "auto"} and values["aa"] == {"ownerGeneration": "g"}
    assert agent.connection.calls[1] == ("codex/session/inspect", {"sessionId": "thread-1"})
    declared = agent.capabilities["_meta"]["aa"]["capabilities"]
    assert {"session.queue.read", "session.queue.update", "session.steer"} <= set(declared)


def test_a_session_on_the_adapters_own_app_server_has_no_owner_queue():
    agent, _ = client(Connection(route="local"))
    asyncio.run(agent.resume("thread-1", "/tmp"))
    assert "session.queue.read" not in agent.capabilities["_meta"]["aa"]["capabilities"]
    with pytest.raises(AcpError, match="跟随"):
        asyncio.run(agent.extension("aa/operate", {
            "sessionId": "thread-1", "operation": "queue.get", "operationId": "op",
        }))


def test_resume_without_automatic_routing_sends_no_ipc_mode():
    handshake = {**HANDSHAKE, "_meta": {"codexIpc": {"version": 1}}}
    agent, _ = client(handshake=handshake)
    asyncio.run(agent.resume("thread-1", "/tmp"))
    assert "codexIpc" not in agent.connection.calls[0][1]
    assert len(agent.connection.calls) == 1


def test_prompt_carries_the_aa_message_identity_and_drops_the_owner_echo():
    agent, updates = client()
    asyncio.run(agent.prompt("thread-1", "hello", "message-1"))
    values = agent.connection.calls[0][1]
    assert values["codexIpc"] == {"clientMessageId": "message-1"}
    assert values["aa"] == {"clientMessageId": "message-1"}
    echo = {
        "sessionUpdate": "user_message_chunk", "messageId": "item-1",
        "content": {"type": "text", "text": "hello"},
        "_meta": {"codexIpc": {"messageId": "item-1", "clientMessageId": "message-1"}},
    }
    before = len(updates)
    asyncio.run(agent.receive_update("thread-1", echo))
    assert len(updates) == before


def test_input_typed_in_the_owner_window_is_one_stable_message():
    agent, updates = client()
    asyncio.run(agent.receive_update("thread-1", {
        "sessionUpdate": "user_message_chunk", "messageId": "item-2",
        "content": {"type": "text", "text": "from the app"},
        "_meta": {"codexIpc": {"messageId": "item-2", "clientMessageId": "app-local-id"}},
    }))
    update = updates[-1]
    assert update["aaProjectionVerified"] is True and update["messageId"] == "item-2"
    assert update["_meta"]["aa"]["boundary"] is True


def test_an_identity_the_adapter_would_reject_is_not_sent():
    agent, _ = client()
    asyncio.run(agent.prompt("thread-1", "hello", "message 1/with spaces"))
    assert "codexIpc" not in agent.connection.calls[0][1]


def test_commands_carry_no_message_identity():
    agent, _ = client()
    agent.commands["thread-1"] = [{"name": "compact"}]
    asyncio.run(agent.execute_command("thread-1", {"command": "/compact"}))
    assert "codexIpc" not in agent.connection.calls[0][1]


def test_steer_keeps_aa_prompt_lifecycle_when_no_turn_runs():
    agent, updates = client()
    result = asyncio.run(agent.steer("thread-1", {"content": "adjust", "clientMessageId": "steer-1"}))
    name, params = agent.connection.calls[0]
    assert name == "session/steering"
    assert params["_meta"] == {
        "codexIpc": {"clientMessageId": "steer-1"},
        "steering": {"idleBehavior": "promptRequired"},
    }
    assert result["outcome"] == "promptRequired"
    assert updates == []


def test_mode_is_the_permission_preset():
    agent, _ = client()
    adapted = {item["id"]: item for item in agent.adapt("s", [
        {"id": "mode", "category": "mode", "type": "select"},
        {"id": "reasoning_effort", "category": "thought_level", "type": "select"},
        {"id": "collaboration_mode", "category": "collaboration_mode", "type": "select"},
    ])}
    assert adapted["mode"]["category"] == "permission"
    assert adapted["reasoning_effort"]["category"] == "effort"
    assert adapted["collaboration_mode"]["category"] == "collaboration_mode"


def test_owner_queue_and_saved_history():
    agent, _ = client()
    asyncio.run(agent.resume("thread-1", "/tmp"))
    result = asyncio.run(agent.extension("aa/operate", {
        "sessionId": "thread-1", "operation": "queue.clear", "operationId": "op",
    }))
    assert agent.connection.calls[-1] == ("codex/session/queue", {"sessionId": "thread-1", "action": "clear"})
    assert result == {"operationId": "op", "phase": "completed", "result": {"messages": [{"id": "q1", "text": "later"}]}}
    history = asyncio.run(agent.extension("aa/read_history", {"sessionId": "thread-1"}))
    assert len(history["updates"]) == 2


def test_unreachable_owner_is_a_stable_error():
    dialect = CodexDialect()
    error = dialect.classify_error(RequestError(-32600, "no route", {"code": "codex_owner_unavailable"}), "resume")
    assert error.code == "codex_owner_unavailable"
    assert dialect.classify_error(RequestError(-32600, "other"), "resume") is None


def test_launch_points_the_adapter_at_the_owner_socket(monkeypatch, tmp_path):
    from connector.runtimes.acp.profiles.codex import definition

    launched = LaunchDefinition("codex-acp", (), "codex-acp-1", environment=(("CODEX_HOME", str(tmp_path)),))
    monkeypatch.setattr(definition, "local_launch", lambda _definition, _values: launched)
    monkeypatch.setattr(definition.sys, "platform", "darwin")

    def environment(values):
        context = SimpleNamespace(definition=CODEX, config=SimpleNamespace(values=values))
        return dict(asyncio.run(prepare_launch(context)()).environment)

    assert environment({"codexHome": str(tmp_path)})["CODEX_ACP_IPC_SOCKET"] == str(tmp_path / "ipc/ipc.sock")
    pipe = r"\\.\pipe\codex-ipc"
    assert environment({"ipcSocket": pipe})["CODEX_ACP_IPC_SOCKET"] == pipe


class FakeAgent(AgentClient):
    connections: ClassVar[list] = []

    async def start(self, launch, cwd):
        self.connection = Connection()
        FakeAgent.connections.append(self.connection)
        self.exited = asyncio.Event()
        self.process = SimpleNamespace(
            process=SimpleNamespace(wait=self.exited.wait),
            close=self._closed,
        )
        handshake = copy.deepcopy(HANDSHAKE)
        self.initialized(handshake)
        return handshake

    async def _closed(self):
        self.exited.set()


def test_a_native_codex_session_can_be_continued_and_keeps_its_history(tmp_path):
    async def run():
        FakeAgent.connections = []
        published = []

        async def publish(_runtime, notifications, **kwargs):
            published.extend(notifications)

        host = SimpleNamespace(
            session_namespace="fixture", runtime_id="codex-acp",
            runtime_kv=SimpleNamespace(path=tmp_path / "state/runtime.json"),
            publish_runtime_notifications=publish,
        )
        provider = CodexAcpProvider()
        config = replace(await provider.validate_config({}), runtime_id="codex-acp")
        context = AgentContext(CODEX, config, host, tmp_path / "root")

        def factory(on_update, on_interaction):
            return FakeAgent(on_update, on_interaction, dialect=CodexDialect())

        runtime = codex_runtime(context, factory)
        launch = LaunchDefinition("codex-acp", (), "codex-acp-test")

        async def session_launch(_session_id):
            return launch

        runtime.app.launch_for_session = session_launch
        await runtime.start()
        try:
            [row] = await runtime.list_sessions()
            caps = {cap.capability_id: cap for cap in (await runtime.get_session_capabilities(row.session_id)).capabilities}
            assert caps["session.recover"].available
            assert caps["session.recover"].metadata["handoff"] == "follow"
            assert not caps["session.send_message"].available
            state = await runtime.get_session_state(row.session_id)
            assert state.metadata["nativeHistory"] is True
            values = {
                "sessionId": row.session_id, "operationId": "follow-1",
                "expectedGeneration": state.metadata["ownerGeneration"],
                "sourceRevision": state.metadata["sourceRevision"], "cliExited": True,
            }
            assert values["expectedGeneration"] == NATIVE_GENERATION
            from connector.runtime_protocol.workflows import RuntimeWorkflowRequest

            request = RuntimeWorkflowRequest(operation="recover_session", values=values)
            started = await runtime.execute_workflow(request)
            assert started.values["phase"] == "running"
            for _ in range(200):
                result = (await runtime.execute_workflow(request)).values
                if result["phase"] != "running":
                    break
                await asyncio.sleep(0.01)
            assert result["phase"] == "completed", result
            assert runtime.app.store.get("native_inventory", row.session_id) is None
            resumed = [call for connection in FakeAgent.connections for call in connection.calls if call[0] == "resume"]
            assert resumed[0][1]["codexIpc"] == {"mode": "auto"}
            assert resumed[0][1]["session_id"] == "thread-1"
            snapshot = await runtime.get_session_snapshot(row.session_id)
            assert [item.content["text"] for item in snapshot.items] == ["earlier", "answer"]
            caps = {cap.capability_id: cap for cap in (await runtime.get_session_capabilities(row.session_id)).capabilities}
            assert caps["session.send_message"].available
            assert caps["session.queue.read"].supported
            # The session is now an ordinary binding, not a second native row.
            assert [item.session_id for item in await runtime.list_sessions()] == [row.session_id]
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_continuing_needs_the_native_generation(tmp_path):
    runtime = SimpleNamespace()
    from connector.runtimes.acp.profiles.codex.runtime import CodexAcpRuntime

    store = {"native_inventory": {"k": {"sessionId": "thread-1", "cwd": "/tmp"}}}
    runtime.app = SimpleNamespace(
        store=SimpleNamespace(get=lambda kind, key: store.get(kind, {}).get(key)), sessions={},
    )
    with pytest.raises(AcpError) as raised:
        CodexAcpRuntime._begin_follow(runtime, {"sessionId": "k", "operationId": "o", "expectedGeneration": "other"})
    assert raised.value.code == "owner_changed"
