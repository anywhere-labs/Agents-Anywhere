from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from acp import RequestError

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.commandcode import COMMAND_CODE_PROFILE
from connector.runtimes.acp.profiles.commandcode import provider as provider_module
from connector.runtimes.acp.profiles.commandcode.client import CommandCodeClient
from connector.runtimes.acp.profiles.commandcode.installation import (
    CommandCodeInstallation,
    CommandCodeUnavailableError,
    resolve_command_code,
)
from connector.runtimes.acp.profiles.commandcode.provider import (
    CommandCodeProvider,
)
from connector.runtimes.acp.runtime import AcpRuntime
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


def test_command_code_is_fifth_default_provider() -> None:
    assert [provider.runtime for provider in default_runtime_providers()] == [
        "codex",
        "claude",
        "dsh",
        "commandcode",
        "pi",
    ]


def test_profile_uses_command_code_identity() -> None:
    assert COMMAND_CODE_PROFILE.id == "commandcode"
    assert COMMAND_CODE_PROFILE.title == "Command Code"
    assert "runtime.attachment" in COMMAND_CODE_PROFILE.runtime_capabilities


def test_discover_reports_configurable_acp_descriptor(monkeypatch) -> None:
    monkeypatch.setattr(
        provider_module, "resolve_command_code", lambda *_: _installation()
    )

    descriptor = asyncio.run(CommandCodeProvider().discover())

    assert descriptor.runtime_type == "commandcode"
    assert descriptor.display_name == "Command Code"
    assert descriptor.implementation_type == "acp-stdio"
    assert descriptor.instance_policy == "single"
    assert descriptor.available is True
    assert descriptor.config_schema is not None
    assert descriptor.config_schema.runtime == "commandcode"
    assert descriptor.capabilities["modelCatalog"] is True
    assert descriptor.capabilities["steerTurn"] is False
    assert descriptor.metadata["binary"]["found"] is True


def test_discover_stays_visible_when_cli_is_missing(monkeypatch) -> None:
    def missing(*_: Any) -> CommandCodeInstallation:
        raise CommandCodeUnavailableError("missing cli")

    monkeypatch.setattr(provider_module, "resolve_command_code", missing)

    descriptor = asyncio.run(CommandCodeProvider().discover())

    assert descriptor.available is True
    assert descriptor.metadata["binary"]["found"] is False


def test_validate_config_rejects_wrong_types() -> None:
    with pytest.raises(RuntimeInvalidRequestError):
        asyncio.run(CommandCodeProvider().validate_config({"cliPath": 3}))


def test_validate_config_reports_missing_cli(monkeypatch) -> None:
    def missing(*_: Any) -> CommandCodeInstallation:
        raise CommandCodeUnavailableError("Command Code CLI was not found")

    monkeypatch.setattr(provider_module, "resolve_command_code", missing)

    with pytest.raises(RuntimeUnavailableError) as error:
        asyncio.run(CommandCodeProvider().validate_config({"cliPath": ""}))

    assert "not found" in str(error.value)


def test_validate_config_keeps_user_path_and_reports_binary(monkeypatch) -> None:
    monkeypatch.setattr(
        provider_module,
        "resolve_command_code",
        lambda *_: _installation(),
    )

    config = asyncio.run(
        CommandCodeProvider().validate_config({"cliPath": "  D:/tools/cmdc.cmd  "})
    )

    assert config.runtime == "commandcode"
    assert config.values["cliPath"] == "D:/tools/cmdc.cmd"
    assert config.metadata["binary"]["version"] == "1.2.3"


def test_create_runtime_builds_command_code_launch(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        provider_module,
        "resolve_command_code",
        lambda *_: _installation(executable="node.exe", entry="entry.mjs"),
    )
    host = SimpleNamespace(
        session_namespace="test",
        runtime_kv=SimpleNamespace(path=tmp_path / "kv.json"),
    )
    config = RuntimeConfig(
        runtime="commandcode",
        revision=1,
        values={"cliPath": ""},
        runtime_id="commandcode",
    )

    async def run() -> AcpRuntime:
        runtime = await CommandCodeProvider().create_runtime(config, host)
        await runtime.stop()
        return runtime

    runtime = asyncio.run(run())

    assert isinstance(runtime, AcpRuntime)
    assert runtime.profile is COMMAND_CODE_PROFILE
    assert runtime.launch.executable == "node.exe"
    assert runtime.launch.arguments == ("entry.mjs", "--no-auto-update", "acp")
    assert runtime.launch.release_id == "command-code-1.2.3"
    assert runtime.app.client_factory is CommandCodeClient


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


def test_client_maps_model_and_effort_categories() -> None:
    async def on_update(*_: Any) -> None:
        return None

    async def on_interaction(*_: Any) -> dict:
        return {}

    client = CommandCodeClient(on_update, on_interaction)
    client.connection = SimpleNamespace(set_session_mode=lambda *_: None)

    options = client.options(
        "session",
        [
            {"id": "model", "category": "model", "type": "select"},
            {"id": "effort", "category": "thought_level", "type": "select"},
        ],
    )

    assert options[0]["_meta"]["aa"]["selectionCategory"] == "model"
    assert options[1]["_meta"]["aa"]["selectionCategory"] == "effort"
    permission = next(item for item in options if item["id"] == "aa-permission")
    assert permission["category"] == "permission"
    assert permission["currentValue"] == "default"


def test_client_switches_permission_mode() -> None:
    calls: list[tuple[str, str]] = []

    async def on_update(*_: Any) -> None:
        return None

    async def on_interaction(*_: Any) -> dict:
        return {}

    async def set_session_mode(session_id: str, mode_id: str) -> None:
        calls.append((session_id, mode_id))

    client = CommandCodeClient(on_update, on_interaction)
    client.connection = SimpleNamespace(set_session_mode=set_session_mode)

    result = asyncio.run(client.configure("session", "aa-permission", "plan"))

    assert calls == [("session", "plan")]
    permission = next(
        item for item in result["configOptions"] if item["id"] == "aa-permission"
    )
    assert permission["currentValue"] == "plan"


def test_client_rejects_unknown_permission_mode() -> None:
    async def on_update(*_: Any) -> None:
        return None

    async def on_interaction(*_: Any) -> dict:
        return {}

    client = CommandCodeClient(on_update, on_interaction)
    client.connection = SimpleNamespace(set_session_mode=lambda *_: None)

    with pytest.raises(AcpError) as error:
        asyncio.run(client.configure("session", "aa-permission", "sometimes"))

    assert error.value.code == "invalid_permission"


def test_client_synthesizes_user_message_and_receipt() -> None:
    updates: list[dict] = []

    async def on_update(_session_id: str, value: dict) -> None:
        updates.append(value)

    async def on_interaction(*_: Any) -> dict:
        return {}

    client = CommandCodeClient(on_update, on_interaction)

    async def prompt(**_: Any) -> dict:
        await client.callbacks.session_update(
            "session",
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "hello"},
            },
        )
        return {"stopReason": "end_turn"}

    client.connection = SimpleNamespace(prompt=prompt)

    asyncio.run(client.prompt("session", "do work", "op_1"))

    assert updates[0]["sessionUpdate"] == "user_message_chunk"
    assert updates[0]["messageId"] == "op_1"
    assert updates[0]["_meta"]["aa"]["clientMessageId"] == "op_1"
    assert updates[0]["_meta"]["aa"]["boundary"] is True
    assert updates[1] == {
        "sessionUpdate": "aa_execution_observed",
        "clientMessageId": "op_1",
    }


def test_client_maps_authentication_error() -> None:
    async def on_update(*_: Any) -> None:
        return None

    async def on_interaction(*_: Any) -> dict:
        return {}

    client = CommandCodeClient(on_update, on_interaction)

    async def new_session(**_: Any) -> dict:
        raise RequestError(-32000, "Not authenticated. Run `cmd login` first.")

    client.connection = SimpleNamespace(new_session=new_session)

    with pytest.raises(AcpError) as error:
        asyncio.run(client.open_session("."))

    assert error.value.code == "commandcode_authentication_required"


def test_client_maps_disabled_acp_mod() -> None:
    async def on_update(*_: Any) -> None:
        return None

    async def on_interaction(*_: Any) -> dict:
        return {}

    client = CommandCodeClient(on_update, on_interaction)

    async def new_session(**_: Any) -> dict:
        raise RequestError(-32000, "the acp mod is disabled")

    client.connection = SimpleNamespace(new_session=new_session)

    with pytest.raises(AcpError) as error:
        asyncio.run(client.open_session("."))

    assert error.value.code == "commandcode_acp_disabled"


def test_client_advertises_attachment_capability(monkeypatch) -> None:
    async def on_update(*_: Any) -> None:
        return None

    async def on_interaction(*_: Any) -> dict:
        return {}

    async def fake_start(self, _launch, _cwd):
        self.capabilities = {"promptCapabilities": {"image": True}}
        return {"protocolVersion": 1}

    monkeypatch.setattr(AgentClient, "start", fake_start)
    client = CommandCodeClient(on_update, on_interaction)

    asyncio.run(client.start(None, "."))

    assert client.capabilities["_meta"]["aa"]["capabilities"] == [
        "runtime.attachment"
    ]
