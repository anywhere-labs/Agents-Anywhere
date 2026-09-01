from __future__ import annotations

import asyncio
import inspect
from dataclasses import fields

import pytest

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    AgentCallToolContent,
    AgentRuntime,
    CommandToolContent,
    FileChangeToolContent,
    McpToolContent,
    RuntimeAgentCall,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInventoryItem,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimeProvider,
    RuntimeReasoningItem,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionState,
    ToolCallContent,
    ToolTimelineContent,
    WebSearchToolContent,
    complete_agent_call_content,
    complete_tool_content,
)


class MinimalRuntime(AgentRuntime):
    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(runtime="test", runtime_version="0")


class MinimalProvider(RuntimeProvider):
    @property
    def runtime(self) -> str:
        return "test"

    @property
    def runtime_type(self) -> str:
        return "test"

    @property
    def display_name(self) -> str:
        return "Test Runtime"


def _public_async_methods(cls: type) -> list[tuple[str, inspect.Signature]]:
    methods: list[tuple[str, inspect.Signature]] = []
    for name, value in cls.__dict__.items():
        if name.startswith("_"):
            continue
        if inspect.iscoroutinefunction(value):
            methods.append((name, inspect.signature(value)))
    return methods


def test_runtime_protocol_methods_do_not_use_keyword_only_parameters() -> None:
    offenders = []
    for cls in (AgentRuntime, RuntimeHostClient, RuntimeProvider):
        for method_name, signature in _public_async_methods(cls):
            for parameter in signature.parameters.values():
                if parameter.kind is inspect.Parameter.KEYWORD_ONLY:
                    offenders.append(f"{cls.__name__}.{method_name}.{parameter.name}")

    assert offenders == []


def test_runtime_protocol_default_unsupported_behavior() -> None:
    runtime = MinimalRuntime()

    with pytest.raises(RuntimeUnsupportedError) as exc_info:
        asyncio.run(runtime.start_turn("sess_1", None, "hello"))

    assert exc_info.value.method == "start_turn"
    assert exc_info.value.code == "runtime_unsupported"

    with pytest.raises(RuntimeUnsupportedError) as config_exc_info:
        asyncio.run(runtime.get_config())

    assert config_exc_info.value.method == "get_config"


def test_runtime_provider_default_unsupported_behavior() -> None:
    provider = MinimalProvider()

    with pytest.raises(RuntimeUnsupportedError) as discover_exc_info:
        asyncio.run(provider.discover())
    with pytest.raises(RuntimeUnsupportedError) as schema_exc_info:
        asyncio.run(provider.get_config_schema())
    with pytest.raises(RuntimeUnsupportedError) as validate_exc_info:
        asyncio.run(provider.validate_config({}))

    assert discover_exc_info.value.method == "discover"
    assert schema_exc_info.value.method == "get_config_schema"
    assert validate_exc_info.value.method == "validate_config"


def test_runtime_protocol_default_optional_reads_are_empty() -> None:
    runtime = MinimalRuntime()

    assert asyncio.run(runtime.get_session_state("sess_1")) is None
    assert asyncio.run(runtime.get_session_notices("sess_1")) == ()
    assert asyncio.run(runtime.list_commands("sess_1")) == ()
    assert asyncio.run(runtime.list_runtime_commands()) == ()
    runtime_capabilities = asyncio.run(runtime.get_runtime_capabilities())
    session_capabilities = asyncio.run(runtime.get_session_capabilities("sess_1"))

    assert runtime_capabilities.runtime == "test"
    assert runtime_capabilities.revision == 0
    assert runtime_capabilities.capabilities == ()
    assert session_capabilities.runtime == "test"
    assert session_capabilities.session_id == "sess_1"
    assert session_capabilities.capabilities == ()


def test_runtime_protocol_operation_results_include_code() -> None:
    operation = RuntimeOperationResult(ok=False, code="conflict", message="busy")
    command = RuntimeCommandResult(command="resume", ok=False, code="disabled")

    assert operation.code == "conflict"
    assert operation.message == "busy"
    assert command.code == "disabled"


@pytest.mark.parametrize(
    "call",
    [
        AgentCallToolContent(description="Inspect repository"),
        CommandToolContent(command="pwd"),
        FileChangeToolContent(metadata={"changes": [{"path": "app.py"}]}),
        McpToolContent(metadata={"server": "github", "tool": "search"}),
        WebSearchToolContent(metadata={"query": "Claude SDK"}),
        ToolCallContent(title="Read"),
    ],
)
def test_complete_tool_content_preserves_concrete_kind(
    call: ToolTimelineContent,
) -> None:
    completed = complete_tool_content(
        call,
        output="done",
        result={"content": "done"},
        is_error=False,
        metadata={"outputText": "done"},
    )

    assert type(completed) is type(call)
    assert completed.kind == call.kind
    assert completed.output == "done"
    assert completed.metadata["result"] == {"content": "done"}
    assert completed.metadata["outputText"] == "done"


def test_runtime_agent_call_serializes_and_completes_platform_content() -> None:
    call = RuntimeAgentCall(
        action="spawn",
        title="Inspect repository",
        description="Inspect repository",
        agent_type="explorer",
        prompt="Inspect the repository",
        run_in_background=True,
        parent_item_id="parent_1",
        caller_id="thread_parent",
        target_ids=("thread_child",),
        model="gpt-test",
        reasoning_effort="high",
        input={"prompt": "Inspect the repository"},
    ).to_timeline_content()

    completed = complete_agent_call_content(
        call,
        output="done",
        result={"status": "completed"},
        is_error=False,
        agent_id="agent_1",
        agents={"agent_1": {"status": "completed"}},
        usage={"durationMs": 1200, "tokens": 42, "toolCalls": 3},
    )

    assert completed.to_mapping() == {
        "kind": "agent_call",
        "title": "Inspect repository",
        "input": {"prompt": "Inspect the repository"},
        "output": "done",
        "result": {"status": "completed"},
        "isError": False,
        "action": "spawn",
        "description": "Inspect repository",
        "agentType": "explorer",
        "prompt": "Inspect the repository",
        "runInBackground": True,
        "parentItemId": "parent_1",
        "agentId": "agent_1",
        "callerId": "thread_parent",
        "targetIds": ["thread_child"],
        "model": "gpt-test",
        "reasoningEffort": "high",
        "agents": {"agent_1": {"status": "completed"}},
        "usage": {"durationMs": 1200, "tokens": 42, "toolCalls": 3},
    }


def test_runtime_protocol_ordering_time_belongs_only_to_session_meta() -> None:
    assert "ordering_time" in {field.name for field in fields(SessionMeta)}
    assert "ordering_time" not in {field.name for field in fields(SessionState)}


def test_runtime_capability_set_represents_runtime_scope() -> None:
    capability_set = RuntimeCapabilitySet(
        runtime="codex",
        revision=12,
        connector_id="conn_1",
        capabilities=(
            RuntimeCapability(
                capability_id=CAPABILITY_CATALOG_MODEL,
                scope="runtime",
                runtime="codex",
                connector_id="conn_1",
                metadata={"source": "codex.catalog"},
            ),
        ),
    )

    capability = capability_set.capabilities[0]

    assert capability_set.runtime == "codex"
    assert capability_set.session_id is None
    assert capability.capability_id == CAPABILITY_CATALOG_MODEL
    assert capability.scope == "runtime"
    assert capability.supported is True
    assert capability.available is True
    assert capability.allowed is True
    assert capability.metadata["source"] == "codex.catalog"


def test_runtime_capability_set_represents_session_scope() -> None:
    capability_set = RuntimeCapabilitySet(
        runtime="codex",
        revision=13,
        session_id="sess_1",
        capabilities=(
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                scope="session",
                runtime="codex",
                session_id="sess_1",
                available=False,
                unavailable_reason="session_running",
            ),
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_INTERRUPT,
                scope="session",
                runtime="codex",
                session_id="sess_1",
                available=True,
            ),
        ),
    )

    send_message = capability_set.capabilities[0]
    interrupt = capability_set.capabilities[1]

    assert capability_set.session_id == "sess_1"
    assert send_message.available is False
    assert send_message.unavailable_reason == "session_running"
    assert interrupt.available is True


def test_runtime_config_is_representable_without_connector_config() -> None:
    schema = RuntimeConfigSchema(
        runtime="fake",
        revision=7,
        schema={
            "type": "object",
            "properties": {
                "enabled": {"type": "boolean"},
                "mode": {"type": "string"},
            },
        },
        defaults={"mode": "auto"},
    )
    config = RuntimeConfig(
        runtime="fake",
        revision=7,
        values={
            "enabled": True,
            "mode": "auto",
        },
        schema=schema.schema,
    )
    inventory = RuntimeInventoryItem(
        runtime="fake",
        runtime_type="fake",
        display_name="Fake",
        available=True,
        configured=True,
        capabilities={"commands": True},
        config_schema=schema,
    )

    assert config.runtime == "fake"
    assert config.revision == 7
    assert config.values["enabled"] is True
    assert config.schema is not None
    assert inventory.configured is True
    assert inventory.capabilities["commands"] is True
    assert inventory.config_schema == schema


def test_runtime_model_selection_id_rules_are_representable() -> None:
    model_with_reasoning = RuntimeModelItem(
        id="gpt-example",
        title="GPT Example",
        reasoning_items=(
            RuntimeReasoningItem(
                id="high",
                title="High",
                selection_id="sel_model_high",
            ),
        ),
    )
    plain_model = RuntimeModelItem(
        id="gpt-plain",
        title="GPT Plain",
        selection_id="sel_model_plain",
    )

    assert model_with_reasoning.selection_id is None
    assert model_with_reasoning.reasoning_items[0].selection_id == "sel_model_high"
    assert plain_model.selection_id == "sel_model_plain"
