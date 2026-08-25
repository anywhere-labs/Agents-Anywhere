from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from connector.runtime_protocol import (
    MAX_CONFIG_REVISION,
    AgentRuntime,
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInstance,
    RuntimeInstancePolicy,
    RuntimeInstancesUnsupportedError,
    RuntimeInvalidRequestError,
    RuntimeOperationResult,
    RuntimeProvider,
    RuntimeSupervisor,
    RuntimeTypeDescriptor,
)
from connector.server.runtime_rpc import RuntimeRpcHandler
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPOSITORY_ROOT / "contracts" / "runtime-control" / "2.0"
SCHEMA_DIR = CONTRACT_DIR / "schemas"
FIXTURE_DIR = CONTRACT_DIR / "fixtures"


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _contract_validator(slug: str) -> Draft202012Validator:
    registry: Registry[Any] = Registry()
    schemas = {
        path.name: _load_json(path) for path in sorted(SCHEMA_DIR.glob("*.schema.json"))
    }
    for schema in schemas.values():
        registry = registry.with_resource(
            str(schema["$id"]),
            Resource.from_contents(schema),
        )
    return Draft202012Validator(
        schemas[f"{slug}.schema.json"],
        registry=registry,
        format_checker=FormatChecker(),
    )


FIXTURE_CASES = [
    *((path, True) for path in sorted((FIXTURE_DIR / "valid").glob("*/*.json"))),
    *((path, False) for path in sorted((FIXTURE_DIR / "invalid").glob("*/*.json"))),
]


@pytest.mark.parametrize(
    ("fixture_path", "expected_valid"),
    FIXTURE_CASES,
    ids=[
        f"{path.parents[1].name}/{path.parent.name}/{path.stem}"
        for path, _expected in FIXTURE_CASES
    ],
)
def test_connector_uses_runtime_control_v2_contract_fixtures(
    fixture_path: Path,
    expected_valid: bool,
) -> None:
    validator = _contract_validator(fixture_path.parent.name)

    assert validator.is_valid(_load_json(fixture_path)) is expected_valid


class _Host(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_contract"


class _Runtime(AgentRuntime):
    def __init__(self, config: RuntimeConfig) -> None:
        self.config = config
        self.started = False
        self.stopped = False

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime=self.config.runtime,
            runtime_version="test",
        )

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ = session_id, content, title, cwd, selections, attachments, client_message_id
        return RuntimeOperationResult(
            result={"runtime": "wrong", "runtimeId": "rti_wrong"}
        )


class _Provider(RuntimeProvider):
    def __init__(self, runtime_type: str) -> None:
        self._runtime_type = runtime_type

    @property
    def runtime_type(self) -> str:
        return self._runtime_type

    @property
    def display_name(self) -> str:
        return self._runtime_type.title()

    @property
    def implementation_type(self) -> str:
        return "sdk"

    @property
    def instance_policy(self) -> RuntimeInstancePolicy:
        return "multiple" if self.runtime_type == "codex" else "single"

    async def discover(self) -> RuntimeTypeDescriptor:
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=f"{self.display_name} runtime",
            implementation_type=self.implementation_type,
            available=True,
            recommended=self.runtime_type == "codex",
            recommendation_rank=0 if self.runtime_type == "codex" else None,
            capabilities={"runtime.config": True},
            config_schema=await self.get_config_schema(),
            instance_policy=self.instance_policy,
            max_instances=None,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime_type,
            revision=MAX_CONFIG_REVISION,
            schema={"type": "object"},
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        return RuntimeConfig(
            runtime=self.runtime_type,
            revision=1,
            values=dict(values),
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        assert host.connector_id == "conn_contract"
        return _Runtime(config)


def _handler() -> tuple[RuntimeRpcHandler, RuntimeSupervisor]:
    host = _Host()
    supervisor = RuntimeSupervisor(
        providers=(_Provider("codex"), _Provider("claude")),
        host=host,
    )
    return RuntimeRpcHandler(supervisor, host), supervisor


def test_runtime_discover_negotiates_v2_and_preserves_exact_legacy_shape() -> None:
    asyncio.run(_test_runtime_discover_negotiates_v2_and_preserves_exact_legacy_shape())


async def _test_runtime_discover_negotiates_v2_and_preserves_exact_legacy_shape() -> (
    None
):
    handler, _supervisor = _handler()

    legacy = await handler.dispatch("runtime.discover", {})
    assert set(legacy) == {"runtimes"}
    assert handler.control_version == "1.0"

    offered = _load_json(
        FIXTURE_DIR
        / "valid"
        / "runtime-discover-request"
        / "prefer-v2-with-v1-fallback.json"
    )
    negotiated = await handler.dispatch("runtime.discover", offered)

    _contract_validator("runtime-discover-response").validate(negotiated)
    assert handler.control_version == "2.0"
    assert negotiated["selectedControlVersion"] == "2.0"
    assert negotiated["runtimeTypes"][0]["runtimeType"] == "codex"
    assert negotiated["runtimeTypes"][1]["maxInstances"] == 1

    v1_only = await handler.dispatch(
        "runtime.discover",
        {"supportedControlVersions": ["1.0"]},
    )
    assert set(v1_only) == {"runtimes"}
    assert handler.control_version == "1.0"


def test_runtime_control_v2_lifecycle_and_scoped_rpc_use_type_and_instance() -> None:
    asyncio.run(
        _test_runtime_control_v2_lifecycle_and_scoped_rpc_use_type_and_instance()
    )


async def _test_runtime_control_v2_lifecycle_and_scoped_rpc_use_type_and_instance() -> (
    None
):
    handler, supervisor = _handler()
    await handler.dispatch(
        "runtime.discover",
        {"supportedControlVersions": ["2.0", "1.0"]},
    )
    validate_params = _load_json(
        FIXTURE_DIR / "valid" / "runtime-validate-config-params" / "named-codex.json"
    )
    start_params = _load_json(
        FIXTURE_DIR / "valid" / "runtime-start-params" / "max-safe-revision.json"
    )

    validated = await handler.dispatch("runtime.validateConfig", validate_params)
    started = await handler.dispatch("runtime.start", start_params)

    assert validated == {
        "runtime": "codex",
        "runtimeId": "rti_codex_work_01",
        "valid": True,
    }
    assert started == {
        "runtime": "codex",
        "runtimeId": "rti_codex_work_01",
        "status": "running",
    }
    entry = supervisor.entry("rti_codex_work_01")
    assert entry.config is not None
    assert entry.config.revision == MAX_CONFIG_REVISION
    assert entry.runtime is not None
    assert entry.runtime.identity.runtime == "codex"
    assert entry.runtime.identity.runtime_id == "rti_codex_work_01"

    named_capabilities = await handler.dispatch(
        "runtime.capabilities",
        {"runtime": "codex", "runtimeId": "rti_codex_work_01"},
    )
    assert named_capabilities["runtime"] == "codex"
    assert named_capabilities["runtimeId"] == "rti_codex_work_01"
    assert named_capabilities["capabilitySet"]["runtime"] == "codex"
    assert named_capabilities["capabilitySet"]["runtimeId"] == ("rti_codex_work_01")
    created = await handler.dispatch(
        "session.create",
        {
            "runtime": "codex",
            "runtimeId": "rti_codex_work_01",
            "sessionId": "sess_contract",
            "content": "hello",
        },
    )
    assert created["runtime"] == "codex"
    assert created["runtimeId"] == "rti_codex_work_01"

    await handler.dispatch(
        "runtime.start",
        {
            "runtime": "codex",
            "runtimeId": "codex",
            "name": "Default Codex",
            "config": {},
            "configRevision": 0,
        },
    )
    native_legacy_runtime = supervisor.entry("codex").runtime
    assert isinstance(native_legacy_runtime, RuntimeInstance)
    await handler.dispatch(
        "runtime.start",
        {
            "runtime": "codex",
            "runtimeId": "codex",
            "name": "Renamed Codex",
            "config": {},
            "configRevision": 1,
        },
    )
    renamed_legacy_runtime = supervisor.entry("codex").runtime
    assert isinstance(renamed_legacy_runtime, RuntimeInstance)
    assert renamed_legacy_runtime is not native_legacy_runtime
    assert renamed_legacy_runtime.native_runtime is native_legacy_runtime.native_runtime
    effective_config = await handler.dispatch(
        "runtime.config",
        {"runtime": "codex", "runtimeId": "codex"},
    )
    assert effective_config["config"]["revision"] == 1
    assert effective_config["config"]["runtime"] == "codex"
    assert effective_config["config"]["runtimeId"] == "codex"
    legacy_scope = await handler.dispatch(
        "runtime.capabilities",
        {"runtime": "codex"},
    )
    assert legacy_scope["runtime"] == "codex"
    assert legacy_scope["runtimeId"] == "codex"

    with pytest.raises(RuntimeInvalidRequestError, match="belongs to type"):
        await handler.dispatch(
            "runtime.capabilities",
            {"runtime": "claude", "runtimeId": "rti_codex_work_01"},
        )

    stopped = await handler.dispatch(
        "runtime.stop",
        _load_json(FIXTURE_DIR / "valid" / "runtime-stop-params" / "named-codex.json"),
    )
    assert stopped == {
        "runtime": "codex",
        "runtimeId": "rti_codex_work_01",
        "status": "stopped",
    }


def test_runtime_control_v2_rejects_invalid_lifecycle_contracts() -> None:
    asyncio.run(_test_runtime_control_v2_rejects_invalid_lifecycle_contracts())


async def _test_runtime_control_v2_rejects_invalid_lifecycle_contracts() -> None:
    handler, _supervisor = _handler()
    await handler.dispatch(
        "runtime.discover",
        {"supportedControlVersions": ["2.0", "1.0"]},
    )

    missing_name = _load_json(
        FIXTURE_DIR / "invalid" / "runtime-start-params" / "missing-name.json"
    )
    unsafe_revision = _load_json(
        FIXTURE_DIR
        / "invalid"
        / "runtime-validate-config-params"
        / "unsafe-revision.json"
    )
    missing_runtime = _load_json(
        FIXTURE_DIR / "invalid" / "runtime-stop-params" / "missing-runtime-type.json"
    )

    with pytest.raises(ValueError, match="name is required"):
        await handler.dispatch("runtime.start", missing_name)
    with pytest.raises(ValueError, match="configRevision must be between"):
        await handler.dispatch("runtime.validateConfig", unsafe_revision)
    with pytest.raises(TypeError, match="configRevision must be an integer"):
        await handler.dispatch(
            "runtime.start",
            {
                **missing_name,
                "name": "Work Codex",
                "configRevision": True,
            },
        )
    with pytest.raises(RuntimeInvalidRequestError, match="unsupported request field"):
        await handler.dispatch(
            "runtime.start",
            {
                **missing_name,
                "name": "Work Codex",
                "extra": True,
            },
        )
    with pytest.raises(ValueError, match="runtime is required"):
        await handler.dispatch("runtime.stop", missing_runtime)

    valid_start = _load_json(
        FIXTURE_DIR / "valid" / "runtime-start-params" / "max-safe-revision.json"
    )
    await handler.dispatch("runtime.start", valid_start)
    with pytest.raises(RuntimeInvalidRequestError, match="belongs to type"):
        await handler.dispatch(
            "runtime.stop",
            {"runtime": "claude", "runtimeId": "rti_codex_work_01"},
        )


def test_runtime_control_v1_accepts_only_type_equal_legacy_instances() -> None:
    asyncio.run(_test_runtime_control_v1_accepts_only_type_equal_legacy_instances())


async def _test_runtime_control_v1_accepts_only_type_equal_legacy_instances() -> None:
    handler, _supervisor = _handler()
    assert set(await handler.dispatch("runtime.discover", {})) == {"runtimes"}

    started = await handler.dispatch(
        "runtime.start",
        {"runtimeId": "codex", "config": {}, "configRevision": 1},
    )
    assert started == {"runtimeId": "codex", "status": "running"}

    capabilities = await handler.dispatch(
        "runtime.capabilities",
        {"runtime": "codex"},
    )
    assert set(capabilities) == {"capabilitySet"}
    assert capabilities["capabilitySet"]["runtime"] == "codex"
    assert capabilities["capabilitySet"]["runtimeId"] == "codex"

    with pytest.raises(RuntimeInstancesUnsupportedError) as unsupported:
        await handler.dispatch(
            "runtime.start",
            {"runtimeId": "rti_codex_work_01", "config": {}},
        )
    assert unsupported.value.code == "runtime_instances_unsupported"

    with pytest.raises(RuntimeInvalidRequestError, match="same provider type"):
        await handler.dispatch(
            "runtime.start",
            {"runtime": "claude", "runtimeId": "codex", "config": {}},
        )
