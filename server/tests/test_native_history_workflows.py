import pytest
from pydantic import ValidationError

from agent_server.core.runtime_workflows import RecoverRuntimeSessionRequest


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
