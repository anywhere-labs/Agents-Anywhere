from __future__ import annotations

from collections.abc import Callable
from dataclasses import FrozenInstanceError
from typing import Any, cast

import pytest
from connector.runtime_protocol import (
    MAX_CONFIG_REVISION,
    RuntimeInstanceSpec,
    RuntimeInstanceStatus,
    RuntimeInventoryItem,
    RuntimeResourceClaim,
    RuntimeScope,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
    legacy_runtime_scope,
)


def _set_attribute(value: object, name: str, replacement: object) -> None:
    setattr(value, name, replacement)


def test_runtime_type_descriptor_uses_provider_key_and_singleton_default() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="dsh",
        display_name="DeepSeek Harness",
        available=True,
    )

    assert descriptor.runtime_type == "dsh"
    assert descriptor.instance_policy == "singleton"
    assert descriptor.effective_max_instances == 1


def test_runtime_type_descriptor_supports_bounded_multiple_instances() -> None:
    descriptor = RuntimeTypeDescriptor(
        runtime_type="codex",
        display_name="Codex",
        available=True,
        instance_policy="multiple",
        max_instances=4,
    )

    assert descriptor.effective_max_instances == 4


@pytest.mark.parametrize(
    ("instance_policy", "max_instances"),
    [
        ("singleton", 2),
        ("multiple", 1),
        ("multiple", 0),
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


def test_runtime_instance_spec_is_frozen_and_accepts_safe_integer_boundary() -> None:
    spec = RuntimeInstanceSpec(
        runtime_id="rti_codex_primary",
        runtime_type="codex",
        name="Primary",
        config={"codexHome": "/tmp/codex-primary"},
        active=True,
        config_revision=MAX_CONFIG_REVISION,
    )

    assert spec.config_revision == MAX_CONFIG_REVISION
    with pytest.raises(FrozenInstanceError):
        _set_attribute(spec, "runtime_id", "rti_changed")
    with pytest.raises(FrozenInstanceError):
        _set_attribute(spec, "runtime_type", "claude")


@pytest.mark.parametrize("revision", [-1, MAX_CONFIG_REVISION + 1])
def test_runtime_instance_spec_rejects_unsafe_revision(revision: int) -> None:
    with pytest.raises(ValueError):
        RuntimeInstanceSpec(
            runtime_id="rti_codex_primary",
            runtime_type="codex",
            name="Primary",
            config_revision=revision,
        )


@pytest.mark.parametrize("revision", [True, 1.5, "1"])
def test_runtime_instance_spec_rejects_non_integer_revision(revision: object) -> None:
    with pytest.raises(TypeError):
        RuntimeInstanceSpec(
            runtime_id="rti_codex_primary",
            runtime_type="codex",
            name="Primary",
            config_revision=cast(Any, revision),
        )


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


def test_runtime_scope_carries_instance_and_provider_identity() -> None:
    scope = RuntimeScope(runtime_id="rti_codex_primary", runtime_type="codex")

    assert scope.runtime_id == "rti_codex_primary"
    assert scope.runtime_type == "codex"
    assert scope.is_legacy is False


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
