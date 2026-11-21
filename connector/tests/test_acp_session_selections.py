"""ACP session selections: catalog capabilities and composite selection ids."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from connector.runtimes.acp.domain.catalogs import selection_id
from connector.runtimes.acp.domain.configuration import ConfigurationSnapshot
from connector.runtimes.acp.runtime import AcpRuntime

MODEL = {
    "id": "model",
    "category": "model",
    "type": "select",
    "currentValue": "zai:glm-5.2",
    "options": [
        {"value": "zai:glm-5.2", "name": "GLM-5.2"},
        {"value": "zai:glm-5.3", "name": "GLM-5.3"},
    ],
}
EFFORT = {
    "id": "effort",
    "category": "effort",
    "type": "select",
    "currentValue": "medium",
    "options": [
        {"value": "low", "name": "Low"},
        {"value": "medium", "name": "Medium"},
        {"value": "high", "name": "High"},
    ],
}
PERMISSION = {
    "id": "permission",
    "category": "permission",
    "type": "select",
    "currentValue": "workspace-write",
    "options": [{"value": "workspace-write", "name": "Workspace"}],
}


def snapshot(*options):
    return ConfigurationSnapshot(tuple(options), revision=4)


def runtime_for(value, *, live=False):
    runtime = object.__new__(AcpRuntime)
    runtime.config = SimpleNamespace(runtime="acp", runtime_id="acp-hermes")
    runtime.profile = SimpleNamespace(native_inventory=False)
    runtime.agent_capabilities = SimpleNamespace(
        context=lambda session_id, external_session_id: None,
        supported=lambda session_id, capability_id: False,
    )
    sessions = (
        {"sess-1": {"closing": False, "client": SimpleNamespace(capabilities={})}}
        if live
        else {}
    )
    runtime.app = SimpleNamespace(
        configurations=SimpleNamespace(snapshot=lambda session_id: value),
        sessions=sessions,
        store=SimpleNamespace(get=lambda table, key: None),
        state=lambda session_id: {
            "status": "idle",
            "selections": {},
            "metadata": {"stateRevision": 4},
        },
    )
    return runtime


def capabilities_of(runtime):
    return {
        item.capability_id: item
        for item in runtime._session_capabilities("sess-1").capabilities
    }


def test_session_capabilities_advertise_effort_catalog_with_effort_option():
    runtime = runtime_for(snapshot(MODEL, EFFORT, PERMISSION), live=True)

    effort = capabilities_of(runtime)["catalog.effort"]

    assert effort.supported is True
    assert effort.available is True


def test_session_capabilities_hide_effort_catalog_without_effort_option():
    runtime = runtime_for(snapshot(MODEL, PERMISSION), live=True)

    assert capabilities_of(runtime)["catalog.effort"].supported is False


def update(runtime, selections):
    captured = {}

    async def update_session_configuration(session_id, values, *, planning=False):
        captured["session_id"] = session_id
        captured["values"] = dict(values["values"])
        runtime.app.configurations.snapshot(session_id).validate(values["values"])
        return {"operationId": values["operationId"], "phase": "completed"}

    runtime.update_session_configuration = update_session_configuration
    result = asyncio.run(
        runtime.update_session_selections("sess-1", "external-1", selections)
    )
    return result, captured


def test_update_session_selections_decodes_composite_model_selection():
    runtime = runtime_for(snapshot(MODEL, EFFORT, PERMISSION))

    result, captured = update(runtime, {"model": selection_id("zai:glm-5.2", "high")})

    assert result.ok is True
    assert captured["values"] == {"model": "zai:glm-5.2", "effort": "high"}


def test_update_session_selections_keeps_direct_selection_values():
    runtime = runtime_for(snapshot(MODEL, EFFORT, PERMISSION))

    result, captured = update(
        runtime,
        {"model": "zai:glm-5.3", "permission": "workspace-write"},
    )

    assert result.ok is True
    assert captured["values"] == {
        "model": "zai:glm-5.3",
        "permission": "workspace-write",
    }
