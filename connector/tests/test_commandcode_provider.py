from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from acp import RequestError

from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.errors import (
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.runtimes.acp.domain.agents import check_definition
from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.commandcode import COMMAND_CODE
from connector.runtimes.acp.profiles.commandcode import definition as definition_module
from connector.runtimes.acp.profiles.commandcode import provider as provider_module
from connector.runtimes.acp.profiles.commandcode.definition import (
    COMMAND_CODE_PERMISSION_MODES,
    CommandCodeDialect,
)
from connector.runtimes.acp.profiles.commandcode.installation import (
    CommandCodeInstallation,
    CommandCodeUnavailableError,
    resolve_command_code,
)
from connector.runtimes.acp.profiles.commandcode.provider import CommandCodeProvider
from connector.runtimes.providers import default_runtime_providers


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _installation(
    executable: str = "node",
    entry: str = "entry.mjs",
    version: str = "1.2.3",
) -> CommandCodeInstallation:
    return CommandCodeInstallation(
        executable=executable,
        arguments=(entry,),
        version=version,
        environment=(),
        source="test",
    )


def client(**connection):
    updates = []

    async def on_update(_session_id, value):
        updates.append(value)

    async def on_interaction(_session_id, _kind, _request):
        return {}

    instance = AgentClient(on_update, on_interaction, dialect=CommandCodeDialect())
    instance.connection = SimpleNamespace(**connection)
    return instance, updates


def test_command_code_is_registered_default_provider() -> None:
    assert [provider.runtime_type for provider in default_runtime_providers()] == [
        "codex",
        "claude",
        "dsh",
        "commandcode",
        "pi",
        "hermes",
    ]


def test_definition_is_valid_and_exposes_identity() -> None:
    check_definition(COMMAND_CODE)
    assert COMMAND_CODE.runtime_type == "commandcode"
    assert COMMAND_CODE.display_name == "Command Code"
    assert COMMAND_CODE.profile.permission_options == COMMAND_CODE_PERMISSION_MODES
    assert "runtime.attachment" in COMMAND_CODE.runtime_capabilities


def test_config_schema_has_only_the_cli_path() -> None:
    schema = asyncio.run(CommandCodeProvider().get_config_schema())
    assert list(schema.schema["properties"]) == ["cliPath"]
    assert schema.schema["additionalProperties"] is False
    assert schema.ui_schema["fields"]["cliPath"]["component"] == "path"
    assert schema.defaults == {"cliPath": ""}


def test_discover_reports_acp_descriptor(monkeypatch) -> None:
    monkeypatch.setattr(
        provider_module, "resolve_command_code", lambda *_: _installation()
    )

    descriptor = asyncio.run(CommandCodeProvider().discover())

    assert descriptor.runtime_type == "commandcode"
    assert descriptor.implementation_type == "acp-stdio"
    assert descriptor.available is True
    assert descriptor.instance_policy == "single"
    assert descriptor.config_schema is not None
    assert descriptor.capabilities["attachments"] is True
    assert descriptor.metadata["binary"]["found"] is True


def test_discover_stays_visible_when_cli_is_missing(monkeypatch) -> None:
    def missing(*_: Any) -> CommandCodeInstallation:
        raise CommandCodeUnavailableError("missing cli")

    monkeypatch.setattr(provider_module, "resolve_command_code", missing)

    descriptor = asyncio.run(CommandCodeProvider().discover())

    assert descriptor.available is True
    assert descriptor.metadata["binary"]["found"] is False


def test_config_rejects_unknown_fields() -> None:
    with pytest.raises(RuntimeInvalidRequestError):
        asyncio.run(CommandCodeProvider().validate_config({"modelGateway": {}}))


def test_config_reports_missing_cli(monkeypatch) -> None:
    def missing(*_: Any) -> CommandCodeInstallation:
        raise CommandCodeUnavailableError("Command Code CLI was not found")

    monkeypatch.setattr(definition_module, "resolve_command_code", missing)

    with pytest.raises(RuntimeUnavailableError) as error:
        asyncio.run(CommandCodeProvider().validate_config({}))

    assert error.value.code == "commandcode_cli_missing"


def test_config_keeps_the_configured_cli_path(monkeypatch) -> None:
    monkeypatch.setattr(
        definition_module, "resolve_command_code", lambda *_: _installation()
    )

    config = asyncio.run(
        CommandCodeProvider().validate_config({"cliPath": "D:/tools/cmdc.cmd"})
    )

    assert config.runtime == "commandcode"
    assert config.values["cliPath"] == "D:/tools/cmdc.cmd"


def test_prepare_launch_builds_node_entry(monkeypatch) -> None:
    monkeypatch.setattr(
        definition_module,
        "resolve_command_code",
        lambda *_: _installation(executable="node.exe", entry="entry.mjs"),
    )
    context = SimpleNamespace(
        config=RuntimeConfig(
            runtime="commandcode",
            revision=1,
            values={"cliPath": ""},
            runtime_id="commandcode",
        )
    )

    prepare = COMMAND_CODE.prepare_launch(context)
    launch = asyncio.run(prepare())

    assert launch.executable == "node.exe"
    assert launch.arguments == ("entry.mjs", "--no-auto-update", "acp")
    assert launch.release_id == "command-code-1.2.3"
    assert launch.environment == ()


def test_resolve_configured_script_uses_node(tmp_path: Path) -> None:
    entry = _write(tmp_path / "pkg" / "dist" / "index.mjs")
    _write(tmp_path / "pkg" / "package.json", json.dumps({"version": "9.9.9"}))
    node = _write(tmp_path / "bin" / "node.exe")

    result = resolve_command_code(
        {"cliPath": str(entry)},
        path_value=str(node.parent),
        platform="win32",
        environ={},
    )

    assert result.executable == str(node)
    assert result.arguments == (str(entry),)
    assert result.version == "9.9.9"
    assert result.source == "configured"


def test_resolve_path_shim_to_package_entry(tmp_path: Path) -> None:
    shim = _write(tmp_path / "bin" / "cmdc.cmd", "@echo off")
    entry = _write(
        tmp_path / "bin" / "node_modules" / "command-code" / "dist" / "index.mjs"
    )
    _write(
        tmp_path / "bin" / "node_modules" / "command-code" / "package.json",
        json.dumps({"version": "1.88.1"}),
    )
    node = _write(tmp_path / "bin" / "node.exe")

    result = resolve_command_code(
        {},
        path_value=str(shim.parent),
        platform="win32",
        environ={"APPDATA": str(tmp_path / "Roaming")},
    )

    assert result.executable == str(node)
    assert result.arguments == (str(entry),)
    assert result.version == "1.88.1"
    assert result.source == "path"


def test_resolve_never_selects_windows_cmd_exe(tmp_path: Path) -> None:
    _write(tmp_path / "bin" / "cmd.exe")

    with pytest.raises(CommandCodeUnavailableError):
        resolve_command_code(
            {},
            path_value=str(tmp_path / "bin"),
            platform="win32",
            environ={
                "APPDATA": str(tmp_path / "Roaming"),
                "LOCALAPPDATA": str(tmp_path / "Local"),
                "PATH": str(tmp_path / "bin"),
            },
        )


def test_resolve_desktop_bundle_falls_back_to_electron(tmp_path: Path) -> None:
    local = tmp_path / "Local"
    entry = _write(
        local
        / "Programs"
        / "Command Code"
        / "resources"
        / "app"
        / "node_modules"
        / "command-code"
        / "dist"
        / "index.mjs"
    )
    _write(
        local
        / "Programs"
        / "Command Code"
        / "resources"
        / "app"
        / "node_modules"
        / "command-code"
        / "package.json",
        json.dumps({"version": "1.88.1"}),
    )
    electron = _write(local / "Programs" / "Command Code" / "Command Code.exe")

    result = resolve_command_code(
        {},
        path_value="",
        platform="win32",
        environ={"APPDATA": str(tmp_path / "Roaming"), "LOCALAPPDATA": str(local)},
    )

    assert result.executable == str(electron)
    assert result.arguments == (str(entry),)
    assert result.environment == (("ELECTRON_RUN_AS_NODE", "1"),)
    assert result.source == "desktop-electron"


def test_resolve_npm_entry_without_node_raises(tmp_path: Path) -> None:
    _write(
        tmp_path
        / "Roaming"
        / "npm"
        / "node_modules"
        / "command-code"
        / "dist"
        / "index.mjs"
    )

    with pytest.raises(CommandCodeUnavailableError):
        resolve_command_code(
            {},
            path_value="",
            platform="win32",
            environ={
                "APPDATA": str(tmp_path / "Roaming"),
                "LOCALAPPDATA": str(tmp_path / "Local"),
            },
        )


def test_dialect_adds_permission_modes_and_engine_maps_effort() -> None:
    instance, _ = client()
    adapted = {
        item["id"]: item
        for item in instance.adapt(
            "s",
            [
                {"id": "model", "category": "model", "type": "select"},
                {"id": "effort", "category": "thought_level", "type": "select"},
            ],
        )
    }

    assert adapted["model"]["category"] == "model"
    assert adapted["effort"]["category"] == "effort"
    permission = adapted["aa-permission"]
    assert permission["category"] == "permission"
    assert permission["currentValue"] == "default"
    assert len(permission["options"]) == len(COMMAND_CODE_PERMISSION_MODES)


def test_dialect_switches_permission_mode() -> None:
    calls = []

    async def set_session_mode(session_id, mode_id):
        calls.append((session_id, mode_id))

    instance, _ = client(set_session_mode=set_session_mode)
    instance.configuration["s"] = [
        {"id": "model", "category": "model", "type": "select"}
    ]

    result = asyncio.run(instance.configure("s", "aa-permission", "plan"))

    assert calls == [("s", "plan")]
    permission = next(
        item for item in result["configOptions"] if item["id"] == "aa-permission"
    )
    assert permission["currentValue"] == "plan"


def test_dialect_rejects_unknown_permission_mode() -> None:
    async def set_session_mode(*_args):
        return None

    instance, _ = client(set_session_mode=set_session_mode)

    with pytest.raises(AcpError) as error:
        asyncio.run(instance.configure("s", "aa-permission", "sometimes"))

    assert error.value.code == "invalid_permission"


def test_dialect_seeds_mode_from_session() -> None:
    dialect = CommandCodeDialect()
    dialect.verify_session("s", {"modes": {"currentModeId": "plan"}})
    options = dialect.adapt_configuration("s", [])
    assert options[-1]["currentValue"] == "plan"


def test_dialect_classifies_authentication_error() -> None:
    dialect = CommandCodeDialect()
    error = dialect.classify_error(
        RequestError(-32000, "Not authenticated. Run `cmd login` first."), "open"
    )
    assert error is not None
    assert error.code == "commandcode_authentication_required"


def test_dialect_classifies_disabled_acp() -> None:
    dialect = CommandCodeDialect()
    error = dialect.classify_error(RequestError(-32000, "the acp mod is disabled"), "open")
    assert error is not None
    assert error.code == "commandcode_acp_disabled"


def test_engine_synthesizes_user_message() -> None:
    instance, updates = client()

    async def prompt(**_values):
        await instance.callbacks.session_update(
            "s",
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "hello"},
            },
        )
        return {"stopReason": "end_turn"}

    instance.connection = SimpleNamespace(prompt=prompt)

    asyncio.run(instance.prompt("s", "do work", "op_1"))

    assert updates[0]["sessionUpdate"] == "user_message_chunk"
    assert updates[0]["messageId"] == "op_1"
    assert updates[0]["_meta"]["aa"]["clientMessageId"] == "op_1"
    assert updates[1] == {
        "sessionUpdate": "aa_execution_observed",
        "clientMessageId": "op_1",
    }
    assert updates[2]["sessionUpdate"] == "agent_message_chunk"


def test_engine_declares_attachment_and_commands() -> None:
    instance, _ = client()
    instance.initialized(
        {"agentCapabilities": {"promptCapabilities": {"image": True}}}
    )
    asyncio.run(
        instance.receive_update(
            "s",
            {
                "sessionUpdate": "available_commands_update",
                "availableCommands": [{"name": "help"}],
            },
        )
    )
    declared = instance.capabilities["_meta"]["aa"]["capabilities"]
    assert "runtime.attachment" in declared
    assert "session.commands" in declared
    assert instance.commands["s"] == [{"name": "help"}]
