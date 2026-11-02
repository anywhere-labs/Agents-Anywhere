"""Write-only runtime config fields.

A runtime config may carry secrets, such as a model gateway's API key. The
Server keeps them so it can start the runtime, but never returns them to a
client: responses drop the value and describe it in ``secretFields`` instead,
and a save that leaves a secret out keeps the stored one.

Secrets are found from the runtime's own schema, so this does not depend on
the Connector version: a property rendered with the ``modelGateway`` component
holds its key in ``apiKey``, and any property marked ``writeOnly`` is a secret
as a whole or, inside an object, per sub-property.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

GATEWAY_COMPONENT = "modelGateway"
GATEWAY_KEY = "apiKey"
GATEWAY_URL = "baseUrl"
REDACTED = "***"
_MIN_SCRUB_LENGTH = 4


@dataclass(frozen=True, slots=True)
class SecretPath:
    """A secret at ``config[field]`` or, with ``key``, ``config[field][key]``."""

    field: str
    key: str | None = None
    # The secret belongs to a gateway whose ``baseUrl`` it is sent to.
    gateway: bool = False

    @property
    def name(self) -> str:
        return f"{self.field}.{self.key}" if self.key else self.field


class SecretOriginChangedError(ValueError):
    """A saved secret was left out while its gateway moved to another origin."""

    def __init__(self, path: SecretPath) -> None:
        super().__init__(f"{path.name} must be entered again for a new address")
        self.path = path


def secret_paths(
    schema: dict[str, Any] | None,
    ui_schema: dict[str, Any] | None,
) -> list[SecretPath]:
    properties = (schema or {}).get("properties")
    properties = properties if isinstance(properties, dict) else {}
    found: dict[str, SecretPath] = {}
    for field in _gateway_fields(properties, ui_schema or {}):
        path = SecretPath(field, GATEWAY_KEY, gateway=True)
        found[path.name] = path
    for field, spec in properties.items():
        if not isinstance(spec, dict):
            continue
        if spec.get("writeOnly") is True:
            found.setdefault(field, SecretPath(field))
            continue
        nested = spec.get("properties")
        if isinstance(nested, dict):
            for key, nested_spec in nested.items():
                if isinstance(nested_spec, dict) and nested_spec.get("writeOnly") is True:
                    path = SecretPath(field, key)
                    found.setdefault(path.name, path)
    return list(found.values())


def _gateway_fields(properties: dict[str, Any], ui_schema: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    containers = [ui_schema]
    if isinstance(ui_schema.get("fields"), dict):
        containers.append(ui_schema["fields"])
    for container in containers:
        for field, spec in container.items():
            if isinstance(spec, dict) and spec.get("component") == GATEWAY_COMPONENT:
                fields.add(field)
    # Older descriptors name the field without a UI component.
    if GATEWAY_COMPONENT in properties:
        fields.add(GATEWAY_COMPONENT)
    return fields


def _get(config: dict[str, Any] | None, path: SecretPath) -> Any:
    if not isinstance(config, dict):
        return None
    value = config.get(path.field)
    if path.key is None:
        return value
    return value.get(path.key) if isinstance(value, dict) else None


def _is_set(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def secret_hint(value: str) -> str:
    """Enough to recognize a key, never enough to use it."""
    if len(value) >= 16:
        return f"{value[:7]}…{value[-4:]}"
    if len(value) >= 8:
        return f"…{value[-2:]}"
    return "…"


def redact_config(
    config: dict[str, Any] | None,
    paths: list[SecretPath],
) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]]]:
    """Return the config without secrets, and what a client may know of them."""
    if not isinstance(config, dict) or not paths:
        return config, {}
    redacted = copy.deepcopy(config)
    described: dict[str, dict[str, Any]] = {}
    for path in paths:
        value = _get(config, path)
        if path.key is None:
            if path.field in redacted:
                del redacted[path.field]
        else:
            container = redacted.get(path.field)
            if isinstance(container, dict):
                container.pop(path.key, None)
        if _is_set(value):
            described[path.name] = {"set": True, "hint": secret_hint(value)}
        elif path.field in config:
            described[path.name] = {"set": False, "hint": None}
    return redacted, described


def merge_secrets(
    incoming: dict[str, Any],
    stored: dict[str, Any] | None,
    paths: list[SecretPath],
) -> dict[str, Any]:
    """Fill secrets a save left out from the stored config.

    A gateway key is kept only while the gateway stays on the same origin;
    otherwise anyone able to edit the address could send the saved key to a
    server of their own.
    """
    merged = copy.deepcopy(incoming)
    for path in paths:
        if _is_set(_get(merged, path)):
            continue
        saved = _get(stored, path)
        if not _is_set(saved):
            continue
        if path.key is None:
            if path.field in merged:
                merged[path.field] = saved
            continue
        container = merged.get(path.field)
        if not isinstance(container, dict):
            # Leaving the whole object out clears it.
            continue
        if path.gateway and not _same_origin(
            container.get(GATEWAY_URL), (stored or {}).get(path.field, {}).get(GATEWAY_URL)
        ):
            raise SecretOriginChangedError(path)
        container[path.key] = saved
    return merged


def _same_origin(left: Any, right: Any) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    try:
        a, b = urlsplit(left.strip()), urlsplit(right.strip())
    except ValueError:
        return False
    return (
        a.scheme.lower() == b.scheme.lower()
        and a.netloc.lower() == b.netloc.lower()
        and bool(a.netloc)
    )


def secret_values(config: dict[str, Any] | None, paths: list[SecretPath]) -> list[str]:
    values = [_get(config, path) for path in paths]
    return [value for value in values if _is_set(value) and len(value) >= _MIN_SCRUB_LENGTH]


def scrub(text: str, secrets: list[str]) -> str:
    """Remove secret values from an error message before anyone sees it."""
    for value in sorted(secrets, key=len, reverse=True):
        text = text.replace(value, REDACTED)
    return text
