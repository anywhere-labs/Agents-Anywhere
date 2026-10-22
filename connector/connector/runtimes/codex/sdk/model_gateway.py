from __future__ import annotations

from typing import Any

from connector.runtimes.model_gateway import ModelGateway

CODEX_MODEL_GATEWAY_PROVIDER_ID = "agents_anywhere_gateway"
CODEX_MODEL_GATEWAY_PROVIDER_NAME = "Agents Anywhere Model Gateway"


def codex_model_gateway_provider(gateway: ModelGateway) -> dict[str, Any]:
    return {
        "name": CODEX_MODEL_GATEWAY_PROVIDER_NAME,
        "base_url": gateway.base_url,
        "experimental_bearer_token": gateway.api_key,
        "wire_api": "responses",
        "requires_openai_auth": False,
    }


def codex_model_gateway_config(gateway: ModelGateway) -> dict[str, Any]:
    return {
        "model_providers": {
            CODEX_MODEL_GATEWAY_PROVIDER_ID: codex_model_gateway_provider(gateway),
        }
    }
