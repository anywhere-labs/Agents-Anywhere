from __future__ import annotations

from agent_server.core.runtime_config import (
    DEFAULT_RUNTIME_CONFIG_SCHEMAS,
    RuntimeConfigField,
    RuntimeConfigOption,
    RuntimeConfigSchema,
    apply_settings_patch,
    merge_schema_with_agent_options,
    schema_with_user_agent_defaults,
)


def test_merge_schema_prefers_live_model_options() -> None:
    base = RuntimeConfigSchema(
        runtime="gemini",
        schemaVersion=1,
        fields=[
            RuntimeConfigField(
                key="model",
                label="Model",
                type="enum",
                allowSessionOverride=True,
                options=[RuntimeConfigOption(value="auto", label="Auto")],
            )
        ],
    )
    merged = merge_schema_with_agent_options(
        base,
        model_options=[
            {"value": "live-a", "label": "Live A"},
            {"value": "live-b", "label": "Live B"},
        ],
    )
    model_field = next(field for field in merged.fields if field.key == "model")
    assert [opt.value for opt in (model_field.options or [])] == ["live-a", "live-b"]


def test_merge_schema_from_acp_config_options() -> None:
    base = RuntimeConfigSchema(runtime="cursor", schemaVersion=1, fields=[])
    merged = merge_schema_with_agent_options(
        base,
        config_options=[
            {
                "id": "model",
                "category": "model",
                "options": [{"value": "x", "name": "X"}],
            },
            {
                "id": "mode",
                "category": "mode",
                "options": [{"value": "agent", "name": "Agent"}],
            },
        ],
    )
    keys = {field.key for field in merged.fields}
    assert "model" in keys
    assert "permissionMode" in keys


def test_merge_codex_live_models_preserves_constraints_and_model_default_effort() -> None:
    # A Codex device may only report the model names.  Static constraints must
    # survive that overlay so a prior Sol/Ultra choice is normalized safely
    # when the user switches to Luna.
    base = schema_with_user_agent_defaults(DEFAULT_RUNTIME_CONFIG_SCHEMAS["codex"], None)
    merged = merge_schema_with_agent_options(
        base,
        model_options=[
            {
                "model": "gpt-5.6-sol",
                "displayName": "Sol from device",
                "supportedReasoningEfforts": ["low", "medium", "ultra"],
                "defaultReasoningEffort": "medium",
                "isDefault": True,
            },
            {
                "model": "gpt-5.6-luna",
                "displayName": "Luna from device",
                # Legacy device output omits effort metadata entirely.
            },
        ],
    )

    model_field = next(field for field in merged.fields if field.key == "model")
    options = {str(option.value): option for option in model_field.options or []}
    assert options["gpt-5.6-sol"].isDefault is True
    assert options["gpt-5.6-sol"].label == "Sol from device"
    assert [str(option.value) for option in options["gpt-5.6-sol"].efforts or []] == [
        "low",
        "medium",
        "ultra",
    ]
    # Luna retains its static, more restrictive contract rather than treating
    # missing live metadata as a no-effort declaration.
    assert [str(option.value) for option in options["gpt-5.6-luna"].efforts or []] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]

    switched = apply_settings_patch(
        {"model": "gpt-5.6-sol", "effort": "ultra"},
        {"model": "gpt-5.6-luna"},
        runtime="codex",
        explicit_keys={"model"},
        schema=merged,
    )
    assert switched == {"model": "gpt-5.6-luna", "effort": "medium"}
