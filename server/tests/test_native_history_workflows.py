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


def test_recovery_status_query_keeps_authorization_and_routes_same_operation():
    async def run():
        calls = []
        session = SimpleNamespace(
            connectorId="device", runtimeId="pi-instance", runtime="pi", takeover=True
        )

        async def get_session(session_id, *, user_id):
            assert user_id == "account" and session_id == "session"
            return session

        async def get_runtime(device, runtime_id, *, user_id):
            assert (device, runtime_id, user_id) == ("device", "pi-instance", "account")

        async def request(device, method, values, **kwargs):
            calls.append((method, values))
            if method == "session.capabilities":
                return {
                    "capabilitySet": {
                        "capabilities": [
                            {
                                "capabilityId": "session.recover",
                                "supported": True,
                                "available": False,
                                "allowed": True,
                            }
                        ]
                    }
                }
            return {"phase": "running"}

        service = RuntimeWorkflowService(
            SimpleNamespace(get_session=get_session),
            SimpleNamespace(request=request),
            SimpleNamespace(get_runtime=get_runtime),
        )
        body = {
            "operationId": "stable",
            "expectedGeneration": "generation",
            "cliExited": True,
            "sourceRevision": "revision",
        }
        result = await service.session_action(
            "session", "session.recover", body, user_id="account"
        )
        assert result["phase"] == "running"
        assert calls[-1][1]["operationId"] == "stable"
        assert calls[-1][1]["cliExited"] is True
        session.takeover = False
        count = len(calls)
        with pytest.raises(WorkflowError, match="授权"):
            await service.session_action(
                "session", "session.recover", body, user_id="account"
            )
        assert len(calls) == count

    asyncio.run(run())
