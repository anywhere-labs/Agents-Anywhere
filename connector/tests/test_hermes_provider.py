import asyncio
import stat
import sys
from types import SimpleNamespace

import pytest
from acp import RequestError

from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    PromptRejectedBeforeDispatch,
)
from connector.runtimes.acp.infrastructure import launch
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.hermes import HERMES, HermesDialect
from connector.runtimes.acp.profiles.hermes.provider import HermesProvider
from connector.runtimes.providers import default_runtime_providers

OPTIONS = [
    {"id": "edit_approval_policy", "name": "Edits", "category": "mode", "type": "select"},
    {"id": "model", "name": "Model", "category": "model", "type": "select"},
    {"id": "reasoning_effort", "name": "Effort", "category": "thought_level", "type": "select"},
    {"id": "service_tier", "name": "Tier", "category": "other", "type": "select"},
]


def client(**connection):
    updates = []

    async def on_update(session_id, value):
        updates.append(value)

    async def on_interaction(session_id, kind, value):
        return {"action": "accept", "optionId": "allow_once"}

    hermes = AgentClient(on_update, on_interaction, dialect=HermesDialect())
    hermes.connection = SimpleNamespace(**connection)
    return hermes, updates


def test_registered_as_default_provider():
    assert "hermes" in {item.runtime_type for item in default_runtime_providers()}


def test_descriptor_is_connector_only_acp_runtime():
    descriptor = asyncio.run(HermesProvider().discover())
    assert descriptor.implementation_type == "acp-stdio"
    assert descriptor.metadata["nativeHistory"] is False


def test_config_rejects_unknown_fields():
    with pytest.raises(RuntimeInvalidRequestError):
        asyncio.run(HermesProvider().validate_config({"modelGateway": {}}))


def test_config_keeps_the_previous_fields():
    schema = asyncio.run(HermesProvider().get_config_schema())
    assert list(schema.schema["properties"]) == ["cliPath", "hermesHome"]


def test_adapts_only_categories_and_keeps_hermes_choices():
    hermes, _ = client()
    adapted = {item["id"]: item for item in hermes.adapt("s", OPTIONS)}
    assert adapted["edit_approval_policy"]["category"] == "permission"
    assert adapted["edit_approval_policy"]["name"] == "Edits"
    assert adapted["reasoning_effort"]["category"] == "effort"
    assert adapted["model"]["category"] == "model"
    assert adapted["service_tier"]["category"] == "other"


def test_unrelated_mode_option_is_not_a_permission():
    hermes, _ = client()
    assert hermes.adapt("s", [{"id": "planner", "category": "mode", "type": "select"}])[0]["category"] == "mode"


def test_session_without_model_option_is_rejected():
    async def new_session(**_values):
        return {"sessionId": "s", "configOptions": []}

    hermes, _ = client(new_session=new_session)
    with pytest.raises(AcpError) as error:
        asyncio.run(hermes.open_session("/tmp"))
    assert error.value.code == "agent_version_unsupported"


def test_open_session_failure_is_a_common_error():
    async def refused(**_values):
        raise RequestError(-32603, "no provider")

    hermes, _ = client(new_session=refused)
    with pytest.raises(AcpError) as error:
        asyncio.run(hermes.open_session("/tmp"))
    assert error.value.code == "agent_session_failed"


def test_answered_approval_card_is_not_a_timeline_tool():
    hermes, updates = client()

    async def scenario():
        await hermes.request_interaction(
            "s", "permission", {"toolCall": {"toolCallId": "edit-approval-1"}, "options": []}
        )
        await hermes.receive_update(
            "s",
            {"sessionUpdate": "tool_call_update", "toolCallId": "edit-approval-1", "status": "completed"},
        )
        await hermes.receive_update(
            "s", {"sessionUpdate": "tool_call_update", "toolCallId": "call_real", "status": "completed"}
        )

    asyncio.run(scenario())
    assert [item["toolCallId"] for item in updates] == ["call_real"]
    assert hermes.dialect.approval_cards == set()


def test_steer_uses_hermes_command_and_records_user_message():
    sent = []

    async def prompt(**values):
        sent.append(values["prompt"][0].text)
        return {"stopReason": "end_turn"}

    hermes, updates = client(prompt=prompt)
    result = asyncio.run(
        hermes.extension(
            "aa/steer", {"sessionId": "s", "content": "turn left", "clientMessageId": "steer-1"}
        )
    )
    assert result["outcome"] == "injected"
    assert sent == ["/steer turn left"]
    assert updates[0]["content"]["text"] == "turn left"
    assert updates[0]["_meta"]["aa"]["clientMessageId"] == "steer-1"


def test_steer_with_attachments_is_rejected_before_dispatch():
    hermes, _ = client()
    with pytest.raises(PromptRejectedBeforeDispatch) as error:
        asyncio.run(
            hermes.extension(
                "aa/steer",
                {"sessionId": "s", "content": "see", "clientMessageId": "m", "blocks": [{"type": "image"}]},
            )
        )
    assert error.value.code == "agent_steer_attachments_unsupported"


def test_steer_capability_follows_the_dialect():
    hermes, _ = client()
    hermes.initialized({"agentCapabilities": {"promptCapabilities": {"image": True}}})
    declared = hermes.capabilities["_meta"]["aa"]["capabilities"]
    assert {"session.steer", "runtime.attachment"} <= set(declared)
    assert "session.commands" not in declared


def test_hermes_home_is_passed_to_the_agent(tmp_path):
    assert launch.launch_environment(HERMES, {"hermesHome": str(tmp_path)}) == (
        ("HERMES_HOME", str(tmp_path)),
    )
    assert launch.launch_environment(HERMES, {}) == ()


def test_missing_explicit_cli_is_a_definite_failure(tmp_path):
    with pytest.raises(AcpError) as error:
        launch.resolve_executable(HERMES, {"cliPath": str(tmp_path / "hermes")})
    assert error.value.code == "agent_cli_missing"


def test_no_local_install_is_a_definite_failure(monkeypatch):
    monkeypatch.setattr(launch, "candidates", lambda _definition: [])
    with pytest.raises(AcpError) as error:
        launch.resolve_executable(HERMES, {})
    assert error.value.code == "agent_cli_missing"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
def test_launch_reports_version_and_keeps_aa_secrets_out(tmp_path, monkeypatch):
    log = tmp_path / "env.txt"
    script = tmp_path / "hermes"
    script.write_text(
        f'#!/bin/sh\nenv > "{log}"\n[ "$2" = "--version" ] && echo git.abc\nexit 0\n',
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("AGENT_SERVER_TOKEN", "secret")
    definition = launch.local_launch(HERMES, {"cliPath": str(script)})
    assert definition.executable == str(script)
    assert definition.arguments == ("acp",)
    assert definition.release_id == "hermes-git.abc"
    assert "AGENT_SERVER_TOKEN" not in log.read_text(encoding="utf-8")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
def test_failing_acp_check_is_a_definite_failure(tmp_path):
    script = tmp_path / "hermes"
    script.write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(AcpError) as error:
        launch.local_launch(HERMES, {"cliPath": str(script)})
    assert error.value.code == "agent_acp_unavailable"
