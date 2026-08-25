from __future__ import annotations

from collections.abc import Callable
from dataclasses import FrozenInstanceError, fields
from typing import Any, cast

import pytest

from connector.runtime_protocol import (
    MAX_CONFIG_REVISION,
    RuntimeConfigSchema,
    RuntimeInstanceSpec,
    RuntimeInstanceStatus,
    RuntimeInventoryItem,
    RuntimeResourceClaim,
    RuntimeScope,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
    legacy_runtime_scope,
)
from connector.runtime_protocol.instance_models import (
    MAX_RUNTIME_INSTANCE_ID_LENGTH,
    MAX_RUNTIME_INSTANCE_NAME_LENGTH,
    MAX_RUNTIME_TYPE_LENGTH,
)


def _set_attribute(value: object, name: str, replacement: object) -> None:
    setattr(value, name, replacement)


def test_runtime_type_descriptor_uses_provider_key_and_single_default() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="dsh",
        display_name="DeepSeek Harness",
        available=True,
    )

    assert descriptor.runtime_type == "dsh"
    assert descriptor.instance_policy == "single"
    assert descriptor.effective_max_instances == 1


@pytest.mark.parametrize(
    "runtime_type",
    ["codex", "vendor-runtime", "vendor.runtime-v2", "vendor_runtime.v2"],
)
def test_runtime_type_descriptor_accepts_canonical_provider_keys(
    runtime_type: str,
) -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type=runtime_type,
        display_name="Provider",
        available=True,
    )

    assert descriptor.runtime_type == runtime_type


@pytest.mark.parametrize(
    "runtime_type",
    [
        "Codex",
        " codex",
        "codex ",
        "co dex",
        "codex/path",
        "codex\\path",
        "../codex",
        "codex\n",
        "dsh\x00",
        "rti_extension",
        "vendor--runtime",
        "vendor..runtime",
        "\xe9xecutor",
    ],
)
def test_runtime_type_descriptor_rejects_noncanonical_provider_keys(
    runtime_type: str,
) -> None:
    with pytest.raises(ValueError):
        RuntimeTypeDescriptor(
            runtime_type=runtime_type,
            display_name="Provider",
            available=True,
        )


def test_runtime_type_descriptor_enforces_provider_key_length() -> None:
    valid_runtime_type = f"v{'x' * (MAX_RUNTIME_TYPE_LENGTH - 1)}"
    invalid_runtime_type = f"{valid_runtime_type}x"

    assert (
        RuntimeTypeDescriptor(
            runtime_type=valid_runtime_type,
            display_name="Provider",
            available=True,
        ).runtime_type
        == valid_runtime_type
    )
    with pytest.raises(ValueError, match="too long"):
        RuntimeTypeDescriptor(
            runtime_type=invalid_runtime_type,
            display_name="Provider",
            available=True,
        )


def test_runtime_type_descriptor_keeps_implementation_category_separate() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="dsh",
        implementation_type="local-service",
        display_name="DeepSeek Harness",
        available=True,
    )

    assert descriptor.runtime_type == "dsh"
    assert descriptor.implementation_type == "local-service"


def test_unavailable_runtime_type_requires_a_nonblank_reason() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="dsh",
        display_name="DeepSeek Harness",
        available=False,
        reason="bridge not installed",
    )

    assert descriptor.reason == "bridge not installed"

    for reason in (None, "", " ", "bad\nreason"):
        with pytest.raises(ValueError):
            RuntimeTypeDescriptor(
                runtime_type="dsh",
                display_name="DeepSeek Harness",
                available=False,
                reason=reason,
            )


@pytest.mark.parametrize("recommendation_rank", [0, MAX_CONFIG_REVISION])
def test_recommendation_rank_accepts_safe_integer_boundaries(
    recommendation_rank: int,
) -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="codex",
        display_name="Codex",
        available=True,
        recommendation_rank=recommendation_rank,
    )

    assert descriptor.recommendation_rank == recommendation_rank


@pytest.mark.parametrize("recommendation_rank", [-1, MAX_CONFIG_REVISION + 1])
def test_recommendation_rank_rejects_out_of_range_values(
    recommendation_rank: int,
) -> None:
    with pytest.raises(ValueError):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            recommendation_rank=recommendation_rank,
        )


@pytest.mark.parametrize("recommendation_rank", [True, 1.5, "1"])
def test_recommendation_rank_rejects_non_integer_values(
    recommendation_rank: object,
) -> None:
    with pytest.raises(TypeError):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            recommendation_rank=cast(Any, recommendation_rank),
        )


def test_runtime_type_descriptor_requires_boolean_capability_values() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="codex",
        display_name="Codex",
        available=True,
        capabilities={"modelCatalog": True, "permissionCatalog": False},
    )

    assert descriptor.capabilities["modelCatalog"] is True
    assert descriptor.capabilities["permissionCatalog"] is False


@pytest.mark.parametrize(
    ("capabilities", "error_type"),
    [
        ([], TypeError),
        ({"": True}, ValueError),
        ({" ": True}, ValueError),
        ({"bad\nkey": True}, ValueError),
        ({1: True}, TypeError),
        ({"modelCatalog": 1}, TypeError),
    ],
)
def test_runtime_type_descriptor_rejects_invalid_capability_maps(
    capabilities: object,
    error_type: type[Exception],
) -> None:
    with pytest.raises(error_type):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            capabilities=cast(Any, capabilities),
        )


def test_runtime_type_descriptor_config_schema_matches_provider_key() -> None:
    schema = RuntimeConfigSchema(
        runtime="dsh",
        revision=1,
        schema={"type": "object"},
    )

    descriptor = RuntimeTypeDescriptor(
        runtime_type="dsh",
        display_name="DeepSeek Harness",
        available=True,
        config_schema=schema,
    )

    assert descriptor.config_schema is schema

    with pytest.raises(ValueError, match="config_schema.runtime"):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            config_schema=schema,
        )


@pytest.mark.parametrize("revision", [0, MAX_CONFIG_REVISION])
def test_runtime_type_descriptor_accepts_safe_config_schema_revision(
    revision: int,
) -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="codex",
        display_name="Codex",
        available=True,
        config_schema=RuntimeConfigSchema(
            runtime="codex",
            revision=revision,
            schema={"type": "object"},
        ),
    )

    assert descriptor.config_schema is not None
    assert descriptor.config_schema.revision == revision


@pytest.mark.parametrize("revision", [True, -1, MAX_CONFIG_REVISION + 1])
def test_runtime_type_descriptor_rejects_unsafe_config_schema_revision(
    revision: object,
) -> None:
    with pytest.raises((TypeError, ValueError)):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            config_schema=RuntimeConfigSchema(
                runtime="codex",
                revision=cast(Any, revision),
                schema={"type": "object"},
            ),
        )


@pytest.mark.parametrize(
    "implementation_type",
    ["Local Service", "local/service", "local--service", "local\nservice"],
)
def test_runtime_type_descriptor_rejects_invalid_implementation_category(
    implementation_type: str,
) -> None:
    with pytest.raises(ValueError):
        RuntimeTypeDescriptor(
            runtime_type="dsh",
            implementation_type=implementation_type,
            display_name="DeepSeek Harness",
            available=True,
        )


def test_runtime_type_descriptor_supports_bounded_multiple_instances() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="codex",
        display_name="Codex",
        available=True,
        instance_policy="multiple",
        max_instances=4,
    )

    assert descriptor.effective_max_instances == 4


def test_max_instances_accepts_safe_integer_boundary() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="codex",
        display_name="Codex",
        available=True,
        instance_policy="multiple",
        max_instances=MAX_CONFIG_REVISION,
    )

    assert descriptor.effective_max_instances == MAX_CONFIG_REVISION


def test_max_instances_rejects_values_above_safe_integer() -> None:
    with pytest.raises(ValueError):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            instance_policy="multiple",
            max_instances=MAX_CONFIG_REVISION + 1,
        )


@pytest.mark.parametrize("max_instances", [True, 1.5, "2"])
def test_max_instances_rejects_non_integer_values(max_instances: object) -> None:
    with pytest.raises(TypeError):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            instance_policy="multiple",
            max_instances=cast(Any, max_instances),
        )


@pytest.mark.parametrize(
    ("instance_policy", "max_instances"),
    [
        ("single", 2),
        ("multiple", 1),
        ("multiple", 0),
        ("singleton", 1),
    ],
)
def test_runtime_type_descriptor_rejects_invalid_instance_limits(
    instance_policy: str,
    max_instances: int,
) -> None:
    with pytest.raises(ValueError):
        RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            instance_policy=cast(Any, instance_policy),
            max_instances=max_instances,
        )


def test_runtime_instance_spec_is_a_frozen_identity_and_name_value() -> None:
    spec = RuntimeInstanceSpec(
        runtime_id="rti_codex_primary",
        runtime_type="codex",
        name="Primary",
    )

    assert [item.name for item in fields(RuntimeInstanceSpec)] == [
        "runtime_id",
        "runtime_type",
        "name",
    ]
    with pytest.raises(FrozenInstanceError):
        _set_attribute(spec, "runtime_id", "rti_changed")
    with pytest.raises(FrozenInstanceError):
        _set_attribute(spec, "runtime_type", "claude")


def test_max_config_revision_remains_available_for_rpc_validation() -> None:
    assert MAX_CONFIG_REVISION == 9_007_199_254_740_991


@pytest.mark.parametrize(
    ("runtime_type", "runtime_id"),
    [
        ("codex", "codex"),
        ("vendor-runtime", "vendor-runtime"),
        ("codex", "rti_work"),
        ("dsh", "rti_nArwhal-18_Beta"),
    ],
)
def test_runtime_instance_spec_accepts_legacy_and_opaque_ids(
    runtime_type: str,
    runtime_id: str,
) -> None:
    spec = RuntimeInstanceSpec(
        runtime_id=runtime_id,
        runtime_type=runtime_type,
        name="Primary",
    )

    assert spec.runtime_id == runtime_id
    assert spec.runtime_type == runtime_type


@pytest.mark.parametrize(
    "runtime_id",
    [
        "claude",
        "rti_",
        "rti_bad/path",
        "rti_bad\\path",
        " rti_token",
        "rti_token ",
        "rti_bad\nvalue",
        "rti_bad\x00value",
        "rti_\xe9",
    ],
)
def test_runtime_instance_spec_rejects_invalid_or_cross_type_ids(
    runtime_id: str,
) -> None:
    with pytest.raises(ValueError):
        RuntimeInstanceSpec(
            runtime_id=runtime_id,
            runtime_type="codex",
            name="Primary",
        )


def test_runtime_instance_spec_enforces_instance_id_length() -> None:
    valid_runtime_id = f"rti_{'x' * (MAX_RUNTIME_INSTANCE_ID_LENGTH - 4)}"
    invalid_runtime_id = f"{valid_runtime_id}x"

    assert (
        RuntimeInstanceSpec(
            runtime_id=valid_runtime_id,
            runtime_type="codex",
            name="Primary",
        ).runtime_id
        == valid_runtime_id
    )
    with pytest.raises(ValueError, match="too long"):
        RuntimeInstanceSpec(
            runtime_id=invalid_runtime_id,
            runtime_type="codex",
            name="Primary",
        )


@pytest.mark.parametrize(
    "name",
    [
        " Primary",
        "Primary ",
        "Primary  Codex",
        "Primary\tCodex",
        "bad\nname",
        "bad\x00name",
        "bad\u200bname",
        "\uff23\uff4f\uff44\uff45\uff58",
    ],
)
def test_runtime_instance_spec_requires_canonical_display_name(name: str) -> None:
    with pytest.raises(ValueError):
        RuntimeInstanceSpec(
            runtime_id="codex",
            runtime_type="codex",
            name=name,
        )


def test_runtime_instance_spec_enforces_display_name_length() -> None:
    valid_name = "x" * MAX_RUNTIME_INSTANCE_NAME_LENGTH
    invalid_name = f"{valid_name}x"

    assert RuntimeInstanceSpec("codex", "codex", valid_name).name == valid_name
    with pytest.raises(ValueError, match="too long"):
        RuntimeInstanceSpec("codex", "codex", invalid_name)


def test_runtime_instance_status_retains_scope_and_structured_error() -> None:
    spec = RuntimeInstanceSpec(
        runtime_id="rti_dsh_primary",
        runtime_type="dsh",
        name="Primary DSH",
    )
    status = RuntimeInstanceStatus(
        spec=spec,
        lifecycle="error",
        runtime_version="0.1.1-rc.2",
        protocol_version="1.0",
        error={"code": "bridge_unavailable", "retryable": True},
    )

    assert status.runtime_id == spec.runtime_id
    assert status.runtime_type == spec.runtime_type
    assert status.error == {"code": "bridge_unavailable", "retryable": True}


@pytest.mark.parametrize(
    "lifecycle",
    ["stopped", "validating", "starting", "running", "stopping", "error", "unknown"],
)
def test_runtime_instance_status_accepts_contract_lifecycle_states(
    lifecycle: str,
) -> None:
    status = RuntimeInstanceStatus(
        spec=RuntimeInstanceSpec("codex", "codex", "Primary"),
        lifecycle=cast(Any, lifecycle),
        error={} if lifecycle == "error" else None,
    )

    assert status.lifecycle == lifecycle


@pytest.mark.parametrize("lifecycle", ["discovering", "available", "unavailable"])
def test_runtime_instance_status_rejects_provider_discovery_states(
    lifecycle: str,
) -> None:
    with pytest.raises(ValueError, match="unsupported lifecycle"):
        RuntimeInstanceStatus(
            spec=RuntimeInstanceSpec("codex", "codex", "Primary"),
            lifecycle=cast(Any, lifecycle),
        )


def test_error_lifecycle_requires_an_error_mapping() -> None:
    spec = RuntimeInstanceSpec("codex", "codex", "Primary")

    with pytest.raises(ValueError, match="requires an error mapping"):
        RuntimeInstanceStatus(spec=spec, lifecycle="error")
    with pytest.raises(TypeError, match="must be a mapping"):
        RuntimeInstanceStatus(
            spec=spec,
            lifecycle="error",
            error=cast(Any, []),
        )


@pytest.mark.parametrize(
    "lifecycle",
    ["stopped", "validating", "starting", "running", "stopping", "unknown"],
)
def test_non_error_lifecycle_rejects_error_mapping(lifecycle: str) -> None:
    with pytest.raises(ValueError, match="non-error lifecycle"):
        RuntimeInstanceStatus(
            spec=RuntimeInstanceSpec("codex", "codex", "Primary"),
            lifecycle=cast(Any, lifecycle),
            error={"code": "unexpected"},
        )


def test_runtime_scope_carries_instance_and_provider_identity() -> None:
    scope = RuntimeScope(runtime_id="rti_codex_primary", runtime_type="codex")

    assert scope.runtime_id == "rti_codex_primary"
    assert scope.runtime_type == "codex"
    assert scope.is_legacy is False


@pytest.mark.parametrize(
    "factory",
    [
        lambda: RuntimeInstanceSpec("claude", "codex", "Primary"),
        lambda: RuntimeScope("claude", "codex"),
        lambda: RuntimeInstanceSpec("rti_primary", "Codex", "Primary"),
        lambda: RuntimeScope("rti_primary", "Codex"),
    ],
)
def test_spec_and_scope_share_runtime_identity_validation(
    factory: Callable[[], object],
) -> None:
    with pytest.raises(ValueError):
        factory()


def test_legacy_runtime_scope_maps_provider_key_to_same_id_instance() -> None:
    scope = legacy_runtime_scope("claude")

    assert scope == RuntimeScope(runtime_id="claude", runtime_type="claude")
    assert scope.is_legacy is True


def test_source_keys_and_resource_claims_are_frozen_domain_values() -> None:
    source = RuntimeSourceKey(kind="codex_home", key="sha256:stable-home-key")
    claim = RuntimeResourceClaim(
        kind=source.kind,
        key=source.key,
        label="Codex Home",
    )

    assert claim.mode == "exclusive"
    with pytest.raises(FrozenInstanceError):
        _set_attribute(source, "key", "changed")
    with pytest.raises(FrozenInstanceError):
        _set_attribute(claim, "mode", "shared")


@pytest.mark.parametrize(
    "factory",
    [
        lambda: RuntimeSourceKey("codex\n_home", "stable-key"),
        lambda: RuntimeSourceKey("codex_home", "stable\x00key"),
        lambda: RuntimeSourceKey("codex_home", "stable\u200bkey"),
        lambda: RuntimeResourceClaim("codex\n_home", "stable-key", "Codex Home"),
        lambda: RuntimeResourceClaim("codex_home", "stable\x00key", "Codex Home"),
        lambda: RuntimeResourceClaim("codex_home", "stable-key", "Codex\nHome"),
    ],
)
def test_source_keys_and_claims_reject_control_characters(
    factory: Callable[[], object],
) -> None:
    with pytest.raises(ValueError, match="control characters"):
        factory()


@pytest.mark.parametrize(
    "factory",
    [
        lambda: RuntimeTypeDescriptor("", "Codex", True),
        lambda: RuntimeTypeDescriptor("codex", " ", True),
        lambda: RuntimeInstanceSpec("", "codex", "Primary"),
        lambda: RuntimeInstanceSpec("rti_primary", " ", "Primary"),
        lambda: RuntimeInstanceSpec("rti_primary", "codex", ""),
        lambda: RuntimeScope("", "codex"),
        lambda: RuntimeScope("rti_primary", ""),
        lambda: RuntimeSourceKey("", "stable-key"),
        lambda: RuntimeSourceKey("codex_home", " "),
        lambda: RuntimeResourceClaim("", "stable-key", "Codex Home"),
        lambda: RuntimeResourceClaim("codex_home", "", "Codex Home"),
        lambda: RuntimeResourceClaim("codex_home", "stable-key", " "),
    ],
)
def test_runtime_instance_models_reject_blank_identity_values(
    factory: Callable[[], object],
) -> None:
    with pytest.raises(ValueError):
        factory()


def test_runtime_resource_claim_rejects_unknown_mode() -> None:
    with pytest.raises(ValueError):
        RuntimeResourceClaim(
            kind="codex_home",
            key="sha256:stable-home-key",
            label="Codex Home",
            mode=cast(Any, "shared"),
        )


def test_legacy_runtime_inventory_item_remains_compatible() -> None:
    item = RuntimeInventoryItem(
        runtime="dsh",
        runtime_type="local-service",
        display_name="DeepSeek Harness",
        available=True,
    )

    assert item.runtime == "dsh"
    assert item.runtime_type == "local-service"
