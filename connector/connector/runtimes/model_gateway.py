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
    # Set only for runtimes that speak more than one protocol.
    protocol: str | None = None
    model_ids: tuple[str, ...] | None = None
    routes: tuple[dict[str, Any], ...] | None = None

    def to_config_values(self) -> dict[str, Any]:
        values: dict[str, Any] = {
            "baseUrl": self.base_url,
            "apiKey": self.api_key,
        }
        if self.protocol is not None:
            values["protocol"] = self.protocol
        if self.model_ids is not None:
            values["modelIds"] = list(self.model_ids)
        if self.routes is not None:
            values["routes"] = list(self.routes)
        return values


def model_gateway_schema(
    protocols: tuple[str, ...] = (), *, multi_protocol: bool = False
) -> dict[str, Any]:
    """The connection object; with ``protocols`` it also names the protocol."""
    schema = _base_model_gateway_schema()
    if protocols:
        schema["required"] = [*schema["required"], "protocol"]
        schema["properties"]["protocol"] = {
            "type": "string",
            "title": "Protocol",
            "description": "The API the gateway address speaks.",
            "enum": list(protocols),
        }
    if multi_protocol:
        ids = {
            "type": "array",
            "maxItems": 64,
            "uniqueItems": True,
            "items": {"type": "string", "minLength": 1, "maxLength": 256},
        }
        schema["properties"]["modelIds"] = ids
        schema["properties"]["routes"] = {
            "type": "array",
            "maxItems": len(protocols) - 1,
            "items": {
                "type": "object",
                "required": ["protocol", "baseUrl", "modelIds"],
                "properties": {
                    "protocol": schema["properties"]["protocol"],
                    "baseUrl": schema["properties"]["baseUrl"],
                    "modelIds": {**ids, "minItems": 1},
                },
                "additionalProperties": False,
            },
        }
    return schema


def _base_model_gateway_schema() -> dict[str, Any]:
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
                    "dashboard.device.runtimeConfigComponents.modelGateway.description"
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


def model_gateway_from_config(
    raw: Any,
    *,
    protocols: tuple[str, ...] = (),
    multi_protocol: bool = False,
) -> ModelGateway | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise RuntimeInvalidRequestError("modelGateway must be an object")
    allowed = {"baseUrl", "apiKey", "protocol"} if protocols else {"baseUrl", "apiKey"}
    if multi_protocol:
        allowed |= {"modelIds", "routes"}
    unexpected_fields = set(raw) - allowed
    if unexpected_fields:
        raise RuntimeInvalidRequestError(
            "modelGateway contains unsupported fields: "
            + ", ".join(sorted(str(field) for field in unexpected_fields))
        )

    base_url = normalized_gateway_url(raw.get("baseUrl"))
    api_key = normalized_gateway_api_key(raw.get("apiKey"))
    protocol = None
    if protocols:
        protocol = raw.get("protocol")
        if protocol not in protocols:
            raise RuntimeInvalidRequestError(
                "modelGateway.protocol must be one of: " + ", ".join(protocols)
            )
    model_ids = None
    routes = None
    if multi_protocol:

        def ids(value: Any) -> tuple[str, ...]:
            if (
                not isinstance(value, list)
                or len(value) > 64
                or any(
                    not isinstance(item, str)
                    or not 1 <= len(item) <= 256
                    or any(c in item for c in "\0\r\n")
                    for item in value
                )
            ):
                raise RuntimeInvalidRequestError(
                    "modelGateway route modelIds must be model IDs"
                )
            if len(set(value)) != len(value):
                raise RuntimeInvalidRequestError(
                    "modelGateway route modelIds must be unique"
                )
            return tuple(value)

        if "modelIds" in raw:
            model_ids = ids(raw["modelIds"])
        if "routes" in raw:
            entries = raw["routes"]
            if not isinstance(entries, list) or len(entries) >= len(protocols):
                raise RuntimeInvalidRequestError("modelGateway has too many routes")
            seen = {protocol}
            normalized = []
            for item in entries:
                if not isinstance(item, Mapping) or set(item) != {
                    "protocol",
                    "baseUrl",
                    "modelIds",
                }:
                    raise RuntimeInvalidRequestError(
                        "modelGateway route must identify protocol, baseUrl and modelIds"
                    )
                kind = item["protocol"]
                if not isinstance(kind, str) or kind not in protocols or kind in seen:
                    raise RuntimeInvalidRequestError(
                        "modelGateway route protocol must be supported and unique"
                    )
                seen.add(kind)
                route_ids = ids(item["modelIds"])
                if not route_ids:
                    raise RuntimeInvalidRequestError(
                        "modelGateway routes need at least one model"
                    )
                normalized.append(
                    {
                        "protocol": kind,
                        "baseUrl": normalized_gateway_url(item["baseUrl"]),
                        "modelIds": list(route_ids),
                    }
                )
            routes = tuple(normalized)
        if model_ids == () and not routes:
            raise RuntimeInvalidRequestError(
                "modelGateway needs at least one routed model"
            )
    return ModelGateway(
        base_url=base_url,
        api_key=api_key,
        protocol=protocol,
        model_ids=model_ids,
        routes=routes,
    )


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
