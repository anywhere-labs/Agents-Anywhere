from __future__ import annotations

from agent_server.core.runtime_config import (
    RuntimeConfigField,
    RuntimeConfigOption,
    RuntimeConfigSchema,
    merge_schema_with_agent_options,
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
