import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from agent_server.core.runtime_workflows import RecoverRuntimeSessionRequest
from agent_server.services.runtime_workflows import (
    RuntimeWorkflowService,
    WorkflowError,
)


def test_native_handoff_confirmation_is_strict_and_paths_are_not_accepted():
    with pytest.raises(ValidationError):
        RecoverRuntimeSessionRequest(
            operationId="operation", expectedGeneration="generation", cliExited="yes"
        )
    with pytest.raises(ValidationError):
        RecoverRuntimeSessionRequest(
            operationId="operation",
            expectedGeneration="generation",
            sessionFile="/arbitrary/file",
        )
    request = RecoverRuntimeSessionRequest(
        operationId="operation",
        expectedGeneration="generation",
        cliExited=True,
        sourceRevision="sha256:revision",
    )
    assert request.model_dump()["cliExited"] is True


def test_session_recovery_is_unsupported_after_authorization():
    async def run():
        seen = []

        async def get_session(session_id, *, user_id):
            seen.append((session_id, user_id))
            if user_id != "account":
                raise KeyError(session_id)
            return SimpleNamespace(connectorId="device", runtimeId="pi-instance", runtime="pi", takeover=True)

        # device-meshcall carries no session actions: nothing reaches the device.
        service = RuntimeWorkflowService(
            SimpleNamespace(get_session=get_session), SimpleNamespace(), SimpleNamespace(), SimpleNamespace()
        )
        body = {
            "operationId": "stable",
            "expectedGeneration": "generation",
            "cliExited": True,
            "sourceRevision": "revision",
        }
        with pytest.raises(WorkflowError) as unsupported:
            await service.session_action("session", "session.recover", body, user_id="account")
        assert unsupported.value.code == "workflow_unsupported"
        assert unsupported.value.status == 409
        with pytest.raises(KeyError):
            await service.session_action("session", "session.recover", body, user_id="intruder")
        assert seen == [("session", "account"), ("session", "intruder")]

    asyncio.run(run())
