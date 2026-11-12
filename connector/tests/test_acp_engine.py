"""The shared ACP engine: acceptance, the user's input, capabilities and definitions."""

import asyncio
from types import SimpleNamespace

import pytest
from acp import RequestError

from connector.runtimes.acp.domain.agents import (
    AcpAgentDefinition,
    ConfigSchema,
    Executable,
    check_definition,
)
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    PromptRejectedBeforeDispatch,
)
from connector.runtimes.acp.domain.dialect import AcpDialect
from connector.runtimes.acp.infrastructure.acp.client import AgentClient, Turn
from connector.runtimes.acp.provider import AcpAgentProvider
from connector.runtimes.providers import default_runtime_providers


def client(dialect=None, **connection):
    updates, asked = [], []

    async def on_update(session_id, value):
        updates.append(value)

    async def on_interaction(session_id, kind, value):
        asked.append(kind)
        return {"action": "accept", "optionId": "allow"}

    agent = AgentClient(on_update, on_interaction, dialect=dialect)
    agent.connection = SimpleNamespace(**connection)
    return agent, updates, asked


def kinds(updates):
    return [item["sessionUpdate"] for item in updates]


def prompting(*updates, response=None):
    """A connection whose prompt streams ``updates`` before answering."""

    async def prompt(**values):
        for session_id, update in updates:
            await agent_ref[0].callbacks.session_update(session_id, update)
        return response or {"stopReason": "end_turn"}

    agent_ref = []
    return agent_ref, prompt


def test_first_execution_update_records_the_input_once():
    ref, prompt = prompting(
        ("s", {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "a"}}),
        ("s", {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "b"}}),
    )
    agent, updates, _ = client(prompt=prompt)
    ref.append(agent)
    asyncio.run(agent.prompt("s", "hello", "message-1"))
    assert kinds(updates) == [
        "user_message_chunk",
        "aa_execution_observed",
        "agent_thought_chunk",
        "agent_message_chunk",
    ]
    assert updates[0]["_meta"]["aa"]["clientMessageId"] == "message-1"
    assert updates[0]["content"]["text"] == "hello"
    assert agent.turns == {}


def test_a_completed_prompt_without_output_is_still_accepted():
    ref, prompt = prompting()
    agent, updates, _ = client(prompt=prompt)
    ref.append(agent)
    asyncio.run(agent.prompt("s", "hello", "message-1"))
    assert kinds(updates) == ["user_message_chunk", "aa_execution_observed"]


def test_an_interaction_is_evidence_before_any_output():
    agent, updates, asked = client()
    agent.turns["s"] = Turn("message-1", "hello", [])
    asyncio.run(agent.request_interaction("s", "permission", {"options": []}))
    assert kinds(updates) == ["user_message_chunk", "aa_execution_observed"]
    assert asked == ["permission"]


def test_updates_outside_a_turn_are_not_evidence():
    agent, updates, _ = client()
    asyncio.run(agent.receive_update("s", {"sessionUpdate": "agent_message_chunk", "content": {}}))
    assert kinds(updates) == ["agent_message_chunk"]


def test_a_rejected_prompt_records_nothing():
    async def prompt(**values):
        raise RequestError(-32602, "refused")

    agent, updates, _ = client(prompt=prompt)
    with pytest.raises(RequestError):
        asyncio.run(agent.prompt("s", "hello", "message-1"))
    assert updates == [] and agent.turns == {}


def test_an_agent_that_echoes_input_is_not_echoed_again():
    class Echoing(AcpDialect):
        echoes_user_prompt = True

    ref, prompt = prompting(("s", {"sessionUpdate": "tool_call", "toolCallId": "t"}))
    agent, updates, _ = client(Echoing(), prompt=prompt)
    ref.append(agent)
    asyncio.run(agent.prompt("s", "hello", "message-1"))
    assert kinds(updates) == ["aa_execution_observed", "tool_call"]


def test_dialect_evidence_and_dropped_updates():
    class Marked(AcpDialect):
        def acceptance_evidence(self, session_id, update):
            return update.get("_meta", {}).get("started") is True

        def translate_update(self, session_id, update):
            return None if update.get("internal") else update

    ref, prompt = prompting(
        ("s", {"sessionUpdate": "tool_call_update", "toolCallId": "x", "internal": True}),
        ("s", {"sessionUpdate": "session_info_update", "_meta": {"started": True}}),
    )
    agent, updates, _ = client(Marked(), prompt=prompt)
    ref.append(agent)
    asyncio.run(agent.prompt("s", "hello", "message-1"))
    assert kinds(updates) == ["user_message_chunk", "aa_execution_observed", "session_info_update"]


def test_before_prompt_rejection_happens_before_the_turn():
    class Refusing(AcpDialect):
        async def before_prompt(self, client, session_id, text, blocks, purpose):
            raise PromptRejectedBeforeDispatch("permission_denied", "no")

    agent, updates, _ = client(Refusing())
    with pytest.raises(PromptRejectedBeforeDispatch):
        asyncio.run(agent.prompt("s", "hello", "message-1"))
    assert updates == [] and agent.turns == {}


def test_capabilities_follow_the_handshake():
    agent, _, _ = client()
    agent.initialized({"agentCapabilities": {"promptCapabilities": {"image": False}}})
    assert agent.capabilities["_meta"]["aa"]["capabilities"] == []
    asyncio.run(agent.receive_update("s", {"sessionUpdate": "available_commands_update", "availableCommands": []}))
    assert agent.capabilities["_meta"]["aa"]["capabilities"] == ["session.commands"]


def test_reasoning_effort_uses_the_aa_category():
    agent, _, _ = client()
    options = agent.adapt("s", [{"id": "x", "category": "thought_level"}, {"id": "m", "category": "model"}])
    assert [item["category"] for item in options] == ["effort", "model"]


@pytest.mark.parametrize(
    ("error", "phase", "code"),
    [
        (RequestError.auth_required({}), "open", "agent_authentication_required"),
        (RequestError(-32603, "x"), "open", "agent_session_failed"),
        (RequestError(-32603, "x"), "resume", "agent_session_unavailable"),
    ],
)
def test_common_errors(error, phase, code):
    agent, _, _ = client()
    assert agent.classify(error, phase).code == code


def test_command_keeps_raw_input_and_reports_rejection():
    sent = []

    async def prompt(**values):
        sent.append(values["prompt"][0].text)
        return {"stopReason": "end_turn"}

    class Guarded(AcpDialect):
        async def before_prompt(self, client, session_id, text, blocks, purpose):
            if "danger" in text:
                raise PromptRejectedBeforeDispatch("permission_denied", "no")

    agent, _, _ = client(Guarded(), prompt=prompt)
    agent.commands["s"] = [{"name": "say"}, {"name": "danger"}]
    ok = asyncio.run(agent.execute_command("s", {"command": "say", "raw": '/say "a  b"\nc'}))
    assert ok["ok"] and sent == ['/say "a  b"\nc']
    denied = asyncio.run(agent.execute_command("s", {"command": "danger"}))
    assert denied == {"ok": False, "executionStarted": False, "code": "permission_denied", "message": "no"}
    with pytest.raises(PromptRejectedBeforeDispatch):
        asyncio.run(agent.execute_command("s", {"command": "missing"}))


def test_steer_is_unavailable_without_a_dialect_method():
    agent, _, _ = client()
    with pytest.raises(AcpError):
        asyncio.run(agent.steer("s", {"content": "x", "clientMessageId": "m"}))


def test_definitions_cannot_take_launch_instructions_from_configuration():
    schema = ConfigSchema(
        {"type": "object", "additionalProperties": False, "properties": {"args": {"type": "array"}}}
    )
    with pytest.raises(ValueError, match="args"):
        check_definition(AcpAgentDefinition("x", "X", executable=Executable("x"), config_schema=schema))
    with pytest.raises(ValueError, match="executable"):
        check_definition(AcpAgentDefinition("x", "X"))


def test_registered_acp_definitions_are_valid():
    acp = [item for item in default_runtime_providers() if isinstance(item, AcpAgentProvider)]
    assert {item.runtime_type for item in acp} >= {"pi", "hermes"}
    for provider in acp:
        check_definition(provider.definition)
