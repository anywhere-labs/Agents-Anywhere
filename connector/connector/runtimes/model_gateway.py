from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from connector.runtime_protocol import RuntimeInvalidRequestError

MAX_MODEL_GATEWAY_URL_LENGTH = 2048
MAX_MODEL_GATEWAY_API_KEY_LENGTH = 8192


@dataclass(frozen=True, slots=True)
class ModelGateway:
    base_url: str
    api_key: str

    def to_config_values(self) -> dict[str, str]:
        return {
            "baseUrl": self.base_url,
            "apiKey": self.api_key,
        }


def model_gateway_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "title": "Model gateway",
        "description": (
            "Route model requests through a compatible gateway instead of the "
            "runtime's default model endpoint."
        ),
        "metadata": {
            "i18n": {
                "labelKey": (
                    "dashboard.device.runtimeConfigComponents.modelGateway.label"
                ),
                "descriptionKey": (
                    "dashboard.device.runtimeConfigComponents."
                    "modelGateway.description"
                ),
            }
        },
        "required": ["baseUrl", "apiKey"],
        "properties": {
            "baseUrl": {
                "type": "string",
                "title": "Gateway URL",
                "description": "The HTTP or HTTPS base URL of the model gateway.",
                "metadata": {
                    "i18n": {
                        "labelKey": (
                            "dashboard.device.runtimeConfigFields."
                            "modelGatewayBaseUrl.label"
                        ),
                        "descriptionKey": (
                            "dashboard.device.runtimeConfigFields."
                            "modelGatewayBaseUrl.description"
                        ),
                    }
                },
                "minLength": 1,
                "maxLength": MAX_MODEL_GATEWAY_URL_LENGTH,
                "pattern": "^https?://",
            },
            "apiKey": {
                "type": "string",
                "title": "Gateway API key",
                "description": "The API key sent to the model gateway.",
                "metadata": {
                    "i18n": {
                        "labelKey": (
                            "dashboard.device.runtimeConfigFields."
                            "modelGatewayApiKey.label"
                        ),
                        "descriptionKey": (
                            "dashboard.device.runtimeConfigFields."
                            "modelGatewayApiKey.description"
                        ),
                    }
                },
                "minLength": 1,
                "maxLength": MAX_MODEL_GATEWAY_API_KEY_LENGTH,
                "pattern": "^[^\\u0000\\r\\n]+$",
            },
        },
        "additionalProperties": False,
    }


def model_gateway_from_config(raw: Any) -> ModelGateway | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise RuntimeInvalidRequestError("modelGateway must be an object")
    unexpected_fields = set(raw) - {"baseUrl", "apiKey"}
    if unexpected_fields:
        raise RuntimeInvalidRequestError(
            "modelGateway contains unsupported fields: "
            + ", ".join(sorted(str(field) for field in unexpected_fields))
        )

    base_url = normalized_gateway_url(raw.get("baseUrl"))
    api_key = normalized_gateway_api_key(raw.get("apiKey"))
    return ModelGateway(base_url=base_url, api_key=api_key)


def normalized_gateway_url(raw: Any) -> str:
    if not isinstance(raw, str):
        raise RuntimeInvalidRequestError("modelGateway.baseUrl must be a string")
    base_url = raw.strip()
    if not base_url:
        raise RuntimeInvalidRequestError("modelGateway.baseUrl must not be empty")
    if len(base_url) > MAX_MODEL_GATEWAY_URL_LENGTH:
        raise RuntimeInvalidRequestError("modelGateway.baseUrl is too long")
    if "\x00" in base_url or "\r" in base_url or "\n" in base_url:
        raise RuntimeInvalidRequestError(
            "modelGateway.baseUrl contains unsupported characters"
        )
    try:
        parsed = urlsplit(base_url)
    except ValueError as exc:
        raise RuntimeInvalidRequestError(
            "modelGateway.baseUrl must be a valid URL"
        ) from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeInvalidRequestError(
            "modelGateway.baseUrl must be an absolute HTTP or HTTPS URL"
        )
    return base_url.rstrip("/")


def normalized_gateway_api_key(raw: Any) -> str:
    if not isinstance(raw, str):
        raise RuntimeInvalidRequestError("modelGateway.apiKey must be a string")
    api_key = raw
    if not api_key.strip():
        raise RuntimeInvalidRequestError("modelGateway.apiKey must not be empty")
    if len(api_key) > MAX_MODEL_GATEWAY_API_KEY_LENGTH:
        raise RuntimeInvalidRequestError("modelGateway.apiKey is too long")
    if "\x00" in api_key or "\r" in api_key or "\n" in api_key:
        raise RuntimeInvalidRequestError(
            "modelGateway.apiKey contains unsupported characters"
        )
    return api_key
