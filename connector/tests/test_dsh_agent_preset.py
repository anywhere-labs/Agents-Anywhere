from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from connector.runtime_protocol import RuntimeConfig, RuntimeUnsupportedError
from connector.runtimes.dsh.runtime import DshRuntime


class _Bridge(DshRuntime):
    """Records bridge calls; ``presets`` is the listAgentPresets reply or an exception."""

    def __init__(self, values: dict[str, object], presets: object) -> None:
        super().__init__(RuntimeConfig("dsh", 3, values), SimpleNamespace(connector_id="test"))
        self.presets = presets
        self.calls: list[tuple[str, dict[str, object] | None]] = []

    async def _request(self, method, params=None):
        self.calls.append((method, params))
        if method == "listAgentPresets":
            if isinstance(self.presets, Exception):
                raise self.presets
            return self.presets
        return {"ok": True}

    def created_preset(self) -> object:
        params = next(params for method, params in self.calls if method == "createAndStartSession")
        assert params is not None
        return params["agentPreset"]

    def asked_catalog(self) -> bool:
        return any(method == "listAgentPresets" for method, _ in self.calls)


def _catalog(default: str | None) -> dict[str, object]:
    field: dict[str, object] = {"type": "string", "enum": ["standard", "minimal"]}
    if default is not None:
        field["default"] = default
    return {"runtime": "dsh", "presets": [{"id": "standard", "enabled": True}], "configField": field}


def _create(runtime: _Bridge, options: dict[str, object] | None = None) -> None:
    asyncio.run(runtime.create_and_start_session(
        "session", "hello", cwd="/work", client_message_id="message", runtime_options=options,
    ))


@pytest.mark.parametrize(
    ("values", "options", "expected"),
    [
        ({"defaultAgentPreset": "ptc"}, {"agentPreset": "cordis"}, "cordis"),
        ({"defaultAgentPreset": "ptc"}, None, "ptc"),
    ],
    ids=["explicit-request", "saved-runtime-config"],
)
def test_chosen_preset_is_sent_without_reading_the_catalog(values, options, expected) -> None:
    runtime = _Bridge(values, _catalog("standard"))
    _create(runtime, options)
    assert runtime.created_preset() == expected
    assert not runtime.asked_catalog()


def test_unsaved_runtime_config_uses_the_plugin_initial_mode() -> None:
    # Config validated while DSH was offline never received defaultAgentPreset;
    # the plugin declares DSH's own default mode, whatever its ID.
    runtime = _Bridge({}, _catalog("minimal"))
    _create(runtime)
    assert runtime.created_preset() == "minimal"


@pytest.mark.parametrize(
    "presets",
    [_catalog(None), RuntimeUnsupportedError("listAgentPresets")],
    ids=["dsh-default-unavailable", "plugin-without-preset-catalog"],
)
def test_without_an_initial_mode_the_plugin_asks_for_one(presets) -> None:
    # No other mode is picked on the user's behalf; DSH returns "choose a mode".
    runtime = _Bridge({}, presets)
    _create(runtime)
    assert runtime.created_preset() is None
