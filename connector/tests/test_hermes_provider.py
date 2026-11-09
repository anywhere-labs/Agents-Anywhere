import asyncio
import stat
import sys

import pytest
from acp import RequestError

from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    PromptRejectedBeforeDispatch,
)
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.hermes import installation
from connector.runtimes.acp.profiles.hermes.client import HermesClient, adapt_options
from connector.runtimes.acp.profiles.hermes.provider import HermesProvider
from connector.runtimes.providers import default_runtime_providers

OPTIONS = [
    {"id": "edit_approval_policy", "name": "Edits", "category": "mode", "type": "select"},
    {"id": "model", "name": "Model", "category": "model", "type": "select"},
    {"id": "reasoning_effort", "name": "Effort", "category": "thought_level", "type": "select"},
    {"id": "service_tier", "name": "Tier", "category": "other", "type": "select"},
]


def client():
    updates = []

    async def on_update(session_id, value):
        updates.append(value)

    async def on_interaction(session_id, kind, value):
        return {"action": "accept", "optionId": "allow_once"}

    return HermesClient(on_update, on_interaction), updates


def test_registered_as_default_provider():
    assert "hermes" in {item.runtime_type for item in default_runtime_providers()}


def test_descriptor_is_connector_only_acp_runtime():
    descriptor = asyncio.run(HermesProvider().discover())
    assert descriptor.implementation_type == "acp-stdio"
    assert descriptor.metadata["nativeHistory"] is False


def test_config_rejects_unknown_fields():
    with pytest.raises(RuntimeInvalidRequestError):
        asyncio.run(HermesProvider().validate_config({"modelGateway": {}}))


def test_adapts_only_categories_and_keeps_hermes_choices():
    adapted = {item["id"]: item for item in adapt_options(OPTIONS)}
    assert adapted["edit_approval_policy"]["category"] == "permission"
    assert adapted["edit_approval_policy"]["name"] == "Edits"
    assert adapted["reasoning_effort"]["category"] == "effort"
    assert adapted["model"]["category"] == "model"
    assert adapted["service_tier"]["category"] == "other"


def test_unrelated_mode_option_is_not_a_permission():
    adapted = adapt_options([{"id": "planner", "category": "mode", "type": "select"}])
    assert adapted[0]["category"] == "mode"


def test_session_without_model_option_is_rejected():
    hermes, _ = client()
    with pytest.raises(AcpError) as error:
        hermes.adapt_session({"sessionId": "s", "configOptions": []})
    assert error.value.code == "hermes_version_unsupported"


def test_open_session_failure_names_the_local_setup(monkeypatch):
    hermes, _ = client()

    async def refused(self, cwd, **metadata):
        raise RequestError(-32603, "no provider")

    monkeypatch.setattr(AgentClient, "open_session", refused)
    with pytest.raises(AcpError) as error:
        asyncio.run(hermes.open_session("/tmp"))
    assert error.value.code == "hermes_session_failed"


def test_prompt_is_projected_once_with_its_identity(monkeypatch):
    hermes, updates = client()

    async def prompt(self, session_id, text, operation_id, blocks=None):
        await self.callbacks.on_update(
            session_id, {"sessionUpdate": "agent_message_chunk", "content": {}}
        )
        await self.callbacks.on_update(
            session_id, {"sessionUpdate": "tool_call", "toolCallId": "call"}
        )
        return {"stopReason": "end_turn"}

    monkeypatch.setattr(AgentClient, "prompt", prompt)
    asyncio.run(hermes.prompt("s", "hello", "message-1"))
    users = [item for item in updates if item["sessionUpdate"] == "user_message_chunk"]
    assert [item["messageId"] for item in users] == ["message-1"]
    assert updates[1] == {
        "sessionUpdate": "aa_execution_observed",
        "clientMessageId": "message-1",
    }


def test_prompt_rejected_by_hermes_is_not_projected(monkeypatch):
    hermes, updates = client()

    async def prompt(self, session_id, text, operation_id, blocks=None):
        raise RequestError(-32603, "refused")

    monkeypatch.setattr(AgentClient, "prompt", prompt)
    with pytest.raises(RequestError):
        asyncio.run(hermes.prompt("s", "hello", "message-1"))
    assert updates == []
    assert hermes.turns == {}


def test_steer_uses_hermes_command_and_records_user_message(monkeypatch):
    hermes, updates = client()
    sent = []

    async def prompt(self, session_id, text, operation_id, blocks=None):
        sent.append(text)
        return {"stopReason": "end_turn"}

    monkeypatch.setattr(AgentClient, "prompt", prompt)
    result = asyncio.run(
        hermes.extension(
            "aa/steer", {"sessionId": "s", "content": "turn left", "clientMessageId": "steer-1"}
        )
    )
    assert result["outcome"] == "injected"
    assert sent == ["/steer turn left"]
    assert updates[0]["content"]["text"] == "turn left"


def test_steer_with_attachments_is_rejected_before_dispatch():
    hermes, _ = client()
    with pytest.raises(PromptRejectedBeforeDispatch):
        asyncio.run(
            hermes.extension(
                "aa/steer",
                {
                    "sessionId": "s",
                    "content": "see",
                    "clientMessageId": "m",
                    "blocks": [{"type": "image"}],
                },
            )
        )


def test_unknown_command_is_rejected_before_dispatch():
    hermes, _ = client()
    hermes.commands["s"] = [{"name": "status"}]
    with pytest.raises(PromptRejectedBeforeDispatch):
        asyncio.run(
            hermes.extension("aa/execute_command", {"sessionId": "s", "command": "nope"})
        )


def test_commands_come_from_hermes():
    hermes, updates = client()
    catalog = [{"name": "status", "description": "Show status"}]
    asyncio.run(
        hermes.callbacks.on_update(
            "s", {"sessionUpdate": "available_commands_update", "availableCommands": catalog}
        )
    )
    assert asyncio.run(
        hermes.extension("aa/list_commands", {"sessionId": "s"})
    ) == {"commands": catalog}
    assert updates


def test_config_updates_are_adapted():
    hermes, updates = client()
    asyncio.run(
        hermes.callbacks.on_update(
            "s", {"sessionUpdate": "config_option_update", "configOptions": OPTIONS}
        )
    )
    assert updates[0]["configOptions"][0]["category"] == "permission"


def test_missing_explicit_cli_is_a_definite_failure(tmp_path):
    with pytest.raises(AcpError) as error:
        installation.resolve_executable({"cliPath": str(tmp_path / "hermes")})
    assert error.value.code == "hermes_cli_missing"


def test_no_local_install_is_a_definite_failure(monkeypatch):
    monkeypatch.setattr(installation, "candidates", list)
    with pytest.raises(AcpError) as error:
        installation.resolve_executable({})
    assert error.value.code == "hermes_cli_missing"


def test_hermes_home_is_passed_to_the_agent(tmp_path):
    assert installation.launch_environment({"hermesHome": str(tmp_path)}) == (
        ("HERMES_HOME", str(tmp_path)),
    )
    assert installation.launch_environment({}) == ()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
def test_prepare_launch_reports_version_and_keeps_aa_secrets_out(tmp_path, monkeypatch):
    log = tmp_path / "env.txt"
    script = tmp_path / "hermes"
    script.write_text(
        f'#!/bin/sh\nenv > "{log}"\n[ "$2" = "--version" ] && echo git.abc\nexit 0\n',
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("AGENT_SERVER_TOKEN", "secret")
    launch = installation.prepare_launch({"cliPath": str(script)})
    assert launch.executable == str(script)
    assert launch.arguments == ("acp",)
    assert launch.release_id == "hermes-git.abc"
    assert "AGENT_SERVER_TOKEN" not in log.read_text(encoding="utf-8")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
def test_failing_acp_check_is_a_definite_failure(tmp_path):
    script = tmp_path / "hermes"
    script.write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(AcpError) as error:
        installation.prepare_launch({"cliPath": str(script)})
    assert error.value.code == "hermes_acp_unavailable"
