from __future__ import annotations

import asyncio
import json

import pytest
from test_runtime_control_v2 import (
    FIXTURE_DIR,
    _contract_validator,
    _handler,
    _load_json,
    _Provider,
)

from connector.runtime_protocol import RuntimeConfig, RuntimeTypeDescriptor
from connector.runtime_protocol.model_connection import (
    ModelConnectionCapability,
    ModelConnectionStatus,
    ModelConnectionUnsupportedError,
    applied_status,
)
from connector.runtimes.acp.profiles.pi.provider import (
    MODEL_CONNECTION as PI_MODEL_CONNECTION,
)
from connector.runtimes.acp.profiles.pi.provider import PiProvider
from connector.runtimes.claude.provider import MODEL_CONNECTION as CLAUDE_MODEL_CONNECTION
from connector.runtimes.codex.provider import MODEL_CONNECTION as CODEX_MODEL_CONNECTION
from connector.server.runtime_rpc_payloads import runtime_type_descriptor_payload

API_KEY = "sk-model-connection-secret"
GATEWAY = {"baseUrl": "https://gateway.example/v1", "apiKey": API_KEY}


@pytest.mark.parametrize(
    "capability",
    [CODEX_MODEL_CONNECTION, CLAUDE_MODEL_CONNECTION, PI_MODEL_CONNECTION],
)
def test_runtime_capabilities_match_the_contract(capability):
    descriptor = RuntimeTypeDescriptor(
        runtime_type="example-runtime",
        display_name="Example",
        available=True,
        maturity="beta",
        model_connection=capability,
    )

    payload = runtime_type_descriptor_payload(descriptor)

    _contract_validator("runtime-type-descriptor").validate(payload)
    assert payload["modelConnection"]["configField"] == "modelGateway"


def test_descriptor_rejects_unknown_maturity():
    with pytest.raises(ValueError, match="maturity"):
        RuntimeTypeDescriptor(
            runtime_type="example-runtime",
            display_name="Example",
            available=True,
            maturity="alpha",
        )


class _ConnectionProvider(_Provider):
    capability = ModelConnectionCapability(
        maturity="stable",
        protocols=("openai_responses",),
        scope="instance",
        apply="restart",
    )

    def model_connection_status(self, config: RuntimeConfig) -> ModelConnectionStatus:
        return applied_status(self.capability, config.values)


def test_start_reply_reports_the_connection_without_the_key():
    async def run():
        handler, supervisor = _handler()
        supervisor._providers["codex"] = _ConnectionProvider("codex")
        params = _load_json(
            FIXTURE_DIR / "valid" / "runtime-start-params" / "max-safe-revision.json"
        )
        params["config"] = {"modelGateway": GATEWAY}

        result = await handler.dispatch("runtime.start", params)

        _contract_validator("runtime-start-result").validate(result)
        assert result["modelConnection"]["state"] == "applied"
        assert result["modelConnection"]["protocol"] == "openai_responses"
        assert API_KEY not in json.dumps(result)

    asyncio.run(run())


def test_start_reply_reports_not_configured_without_a_gateway():
    async def run():
        handler, supervisor = _handler()
        supervisor._providers["codex"] = _ConnectionProvider("codex")
        params = _load_json(
            FIXTURE_DIR / "valid" / "runtime-start-params" / "max-safe-revision.json"
        )

        result = await handler.dispatch("runtime.start", params)

        assert result["modelConnection"] == {
            "state": "not_configured",
            "protocol": None,
            "scope": None,
            "mode": None,
            "reason": None,
            "externalOwner": None,
        }

    asyncio.run(run())


@pytest.mark.parametrize("mode", ["local", "auto"])
def test_pi_rejects_a_gateway_its_mode_would_ignore(mode):
    with pytest.raises(ModelConnectionUnsupportedError) as error:
        asyncio.run(
            PiProvider().validate_config({"executionMode": mode, "modelGateway": GATEWAY})
        )

    assert error.value.code == "model_connection_unsupported"
    assert API_KEY not in str(error.value)


def test_pi_reports_the_managed_connection():
    config = asyncio.run(
        PiProvider().validate_config({"executionMode": "managed", "modelGateway": GATEWAY})
    )

    status = PiProvider().model_connection_status(config)

    assert status.payload()["state"] == "applied"
    assert status.payload()["mode"] == "managed"
    assert status.payload()["protocol"] == "openai_chat"


def test_pi_schema_errors_never_quote_the_key():
    with pytest.raises(Exception) as error:
        asyncio.run(
            PiProvider().validate_config(
                {"executionMode": "managed", "modelGateway": {"baseUrl": "ftp://x", "apiKey": API_KEY + "\n"}}
            )
        )

    assert API_KEY not in str(error.value)
