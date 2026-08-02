from __future__ import annotations

import asyncio
import inspect
from dataclasses import fields

import pytest

from connector.runtime_protocol import (
    AgentRuntime,
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


def test_runtime_protocol_operation_results_include_code() -> None:
    operation = RuntimeOperationResult(ok=False, code="conflict", message="busy")
    command = RuntimeCommandResult(command="resume", ok=False, code="disabled")

    assert operation.code == "conflict"
    assert operation.message == "busy"
    assert command.code == "disabled"


def test_runtime_protocol_ordering_time_belongs_only_to_session_meta() -> None:
    assert "ordering_time" in {field.name for field in fields(SessionMeta)}
    assert "ordering_time" not in {field.name for field in fields(SessionState)}


def test_runtime_config_is_representable_without_connector_config() -> None:
    schema = RuntimeConfigSchema(
        runtime="codex",
        revision=7,
        schema={
            "type": "object",
            "properties": {
                "ipcEnabled": {"type": "boolean"},
                "sdkMode": {"type": "string"},
            },
        },
        defaults={"sdkMode": "auto"},
    )
    config = RuntimeConfig(
        runtime="codex",
        revision=7,
        values={
            "ipcEnabled": True,
            "sdkMode": "auto",
        },
        schema=schema.schema,
    )
    inventory = RuntimeInventoryItem(
        runtime="codex",
        runtime_type="codex",
        display_name="Codex",
        available=True,
        configured=True,
        config_schema=schema,
    )

    assert config.runtime == "codex"
    assert config.revision == 7
    assert config.values["ipcEnabled"] is True
    assert config.schema is not None
    assert inventory.configured is True
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
