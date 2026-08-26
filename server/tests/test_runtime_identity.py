from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from agent_server.core.runtime_identity import (
    KNOWN_RUNTIME_TYPES,
    MAX_RUNTIME_INSTANCE_ID_LENGTH,
    MAX_RUNTIME_INSTANCE_NAME_LENGTH,
    MAX_RUNTIME_TYPE_LENGTH,
    RuntimeIdentity,
    RuntimeIdentityError,
    RuntimeScope,
    generate_runtime_instance_id,
    legacy_runtime_identity,
    normalize_runtime_instance_name,
    runtime_instance_name_key,
    validate_implementation_category,
    validate_runtime_instance_id,
    validate_runtime_type,
)


@pytest.mark.parametrize("runtime_type", sorted(KNOWN_RUNTIME_TYPES))
def test_known_runtime_types_are_valid(runtime_type: str) -> None:
    assert validate_runtime_type(runtime_type) == runtime_type


@pytest.mark.parametrize(
    "runtime_type",
    ["vendor-runtime", "vendor.runtime-v2", "vendor_runtime.v2"],
)
def test_normalized_extension_runtime_types_are_valid(runtime_type: str) -> None:
    assert validate_runtime_type(runtime_type) == runtime_type


def test_runtime_type_enforces_length_boundary() -> None:
    valid_runtime_type = f"v{'x' * (MAX_RUNTIME_TYPE_LENGTH - 1)}"
    invalid_runtime_type = f"{valid_runtime_type}x"

    assert validate_runtime_type(valid_runtime_type) == valid_runtime_type
    with pytest.raises(RuntimeIdentityError, match="too long"):
        validate_runtime_type(invalid_runtime_type)


@pytest.mark.parametrize(
    "runtime_type",
    [
        "",
        " ",
        "Codex",
        "CODEX",
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
        "éxecutor",
    ],
)
def test_runtime_type_rejects_noncanonical_or_ambiguous_keys(
    runtime_type: str,
) -> None:
    with pytest.raises(RuntimeIdentityError):
        validate_runtime_type(runtime_type)


def test_implementation_category_is_separate_validated_metadata() -> None:
    assert validate_implementation_category("local-service") == "local-service"

    with pytest.raises(RuntimeIdentityError):
        validate_implementation_category("Local Service")


@pytest.mark.parametrize(
    ("runtime_type", "runtime_id"),
    [
        ("codex", "codex"),
        ("vendor-runtime", "vendor-runtime"),
        ("codex", "rti_work"),
        ("dsh", "rti_nArwhal-18_Beta"),
    ],
)
def test_runtime_instance_id_accepts_legacy_and_opaque_forms(
    runtime_type: str,
    runtime_id: str,
) -> None:
    assert (
        validate_runtime_instance_id(runtime_id, runtime_type=runtime_type)
        == runtime_id
    )


@pytest.mark.parametrize(
    "runtime_id",
    [
        "",
        "claude",
        "rti_",
        "rti_bad/path",
        "rti_bad\\path",
        " rti_token",
        "rti_token ",
        "rti_bad\nvalue",
        "rti_bad\x00value",
        "rti_é",
    ],
)
def test_runtime_instance_id_rejects_invalid_or_cross_type_values(
    runtime_id: str,
) -> None:
    with pytest.raises(RuntimeIdentityError):
        validate_runtime_instance_id(runtime_id, runtime_type="codex")


def test_runtime_instance_id_enforces_length_boundary() -> None:
    valid_runtime_id = f"rti_{'x' * (MAX_RUNTIME_INSTANCE_ID_LENGTH - 4)}"
    invalid_runtime_id = f"{valid_runtime_id}x"

    assert (
        validate_runtime_instance_id(valid_runtime_id, runtime_type="codex")
        == valid_runtime_id
    )
    with pytest.raises(RuntimeIdentityError, match="too long"):
        validate_runtime_instance_id(invalid_runtime_id, runtime_type="codex")


def test_generated_instance_ids_are_valid_opaque_and_unique() -> None:
    generated = {generate_runtime_instance_id() for _ in range(64)}

    assert len(generated) == 64
    for runtime_id in generated:
        assert runtime_id.startswith("rti_")
        assert runtime_id not in KNOWN_RUNTIME_TYPES
        assert (
            validate_runtime_instance_id(runtime_id, runtime_type="codex") == runtime_id
        )


def test_runtime_identity_and_scope_are_validated_and_immutable() -> None:
    identity = RuntimeIdentity.create(runtime_type="codex", runtime_id="rti_work")
    scope = RuntimeScope.from_identity(identity)

    assert scope == identity.scope()
    assert scope.runtime_type == "codex"
    assert scope.runtime_id == "rti_work"
    assert identity.is_legacy is False

    identity_attribute = "runtime_id"
    scope_attribute = "runtime_type"
    with pytest.raises(FrozenInstanceError):
        setattr(identity, identity_attribute, "rti_personal")
    with pytest.raises(FrozenInstanceError):
        setattr(scope, scope_attribute, "dsh")


def test_identity_value_objects_reject_mismatched_legacy_ids() -> None:
    with pytest.raises(RuntimeIdentityError):
        RuntimeIdentity.create(runtime_type="codex", runtime_id="claude")

    with pytest.raises(RuntimeIdentityError):
        RuntimeScope.create(runtime_type="dsh", runtime_id="codex")


def test_legacy_mapping_treats_sessions_runtime_as_a_runtime_type() -> None:
    identity = legacy_runtime_identity("dsh")

    assert identity.runtime_type == "dsh"
    assert identity.runtime_id == "dsh"
    assert identity.is_legacy is True

    with pytest.raises(RuntimeIdentityError):
        legacy_runtime_identity("rti_existing-instance")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Personal   Codex  ", "Personal Codex"),
        ("  开发\u3000环境  ", "开发 环境"),
        ("Ｃｏｄｅｘ  主实例", "Codex 主实例"),
    ],
)
def test_runtime_instance_name_normalizes_unicode_and_whitespace(
    raw: str,
    expected: str,
) -> None:
    assert normalize_runtime_instance_name(raw) == expected


def test_runtime_instance_name_key_is_stable_and_unicode_aware() -> None:
    assert runtime_instance_name_key("  ＣＯＤＥＸ   Straße ") == "codex strasse"
    assert runtime_instance_name_key("Codex Strasse") == "codex strasse"


@pytest.mark.parametrize(
    "name",
    ["", "   ", "bad\nname", "bad\x00name", "bad\u200bname"],
)
def test_runtime_instance_name_rejects_empty_or_control_characters(
    name: str,
) -> None:
    with pytest.raises(RuntimeIdentityError):
        normalize_runtime_instance_name(name)


def test_runtime_instance_name_enforces_normalized_length_boundary() -> None:
    valid_name = "界" * MAX_RUNTIME_INSTANCE_NAME_LENGTH
    invalid_name = f"{valid_name}界"

    assert normalize_runtime_instance_name(valid_name) == valid_name
    with pytest.raises(RuntimeIdentityError, match="too long"):
        normalize_runtime_instance_name(invalid_name)
