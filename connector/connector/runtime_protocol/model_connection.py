"""Model connection contract shared by every runtime adapter.

Agents Anywhere configures a runtime's model endpoint the same way for every
runtime: a ``{baseUrl, apiKey}`` object and an optional model list in the
runtime config. Each adapter declares what it supports, rejects unsupported
combinations while validating, converts the connection into its native
settings, and reports what actually took effect. The report never contains
the API key.

See docs/model-config-management-proposal.md §2.6 and the Runtime Control 2.0
contract (``modelConnection`` on the type descriptor and the start result).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from connector.runtime_protocol.errors import RuntimeInvalidRequestError

Maturity = Literal["experimental", "beta", "stable"]
ModelProtocol = Literal["openai_responses", "openai_chat", "anthropic"]
ConnectionScope = Literal["instance", "session", "native_global"]
ApplyMode = Literal["immediate", "new_session", "restart"]
ConnectionState = Literal["applied", "failed", "managed_externally", "not_configured"]

_MATURITIES = {"experimental", "beta", "stable"}
_PROTOCOLS = {"openai_responses", "openai_chat", "anthropic"}
_SCOPES = {"instance", "session", "native_global"}
_APPLY = {"immediate", "new_session", "restart"}
_STATES = {"applied", "failed", "managed_externally", "not_configured"}


class ModelConnectionUnsupportedError(RuntimeInvalidRequestError):
    """A saved connection the runtime cannot use; rejected instead of ignored."""

    code = "model_connection_unsupported"


@dataclass(frozen=True, slots=True)
class ModelConnectionMode:
    id: str
    supported: bool
    reason: str | None = None

    def payload(self) -> dict[str, Any]:
        return {"id": self.id, "supported": self.supported, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class ModelConnectionCapability:
    maturity: Maturity
    protocols: tuple[ModelProtocol, ...]
    scope: ConnectionScope
    apply: ApplyMode
    config_field: str = "modelGateway"
    models_field: str | None = "customModels"
    catalog_auto: bool = False
    catalog_manual: bool = True
    # The connection is only used with the models listed in ``models_field``.
    catalog_required: bool = False
    modes: tuple[ModelConnectionMode, ...] = field(default_factory=tuple)
    # Config field that selects one of ``modes``.
    mode_field: str | None = None

    def __post_init__(self) -> None:
        if self.maturity not in _MATURITIES:
            raise ValueError(f"unsupported maturity: {self.maturity!r}")
        if not self.protocols or any(p not in _PROTOCOLS for p in self.protocols):
            raise ValueError("protocols must be a non-empty list of known protocols")
        if self.scope not in _SCOPES:
            raise ValueError(f"unsupported scope: {self.scope!r}")
        if self.apply not in _APPLY:
            raise ValueError(f"unsupported apply mode: {self.apply!r}")
        if not self.config_field:
            raise ValueError("config_field must not be empty")

    def payload(self) -> dict[str, Any]:
        return {
            "maturity": self.maturity,
            "configField": self.config_field,
            "modelsField": self.models_field,
            "protocols": list(self.protocols),
            "modes": [mode.payload() for mode in self.modes],
            "modeField": self.mode_field,
            "scope": self.scope,
            "catalog": {
                "auto": self.catalog_auto,
                "manual": self.catalog_manual,
                **({"required": True} if self.catalog_required else {}),
            },
            "apply": self.apply,
        }


@dataclass(frozen=True, slots=True)
class ModelConnectionStatus:
    state: ConnectionState
    protocol: ModelProtocol | None = None
    scope: ConnectionScope | None = None
    mode: str | None = None
    reason: str | None = None
    external_owner: str | None = None

    def __post_init__(self) -> None:
        if self.state not in _STATES:
            raise ValueError(f"unsupported model connection state: {self.state!r}")

    def payload(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "protocol": self.protocol,
            "scope": self.scope,
            "mode": self.mode,
            "reason": self.reason,
            "externalOwner": self.external_owner,
        }


def connection_configured(values: Mapping[str, Any] | None, config_field: str) -> bool:
    """Whether the config carries a model connection in ``config_field``."""
    if not isinstance(values, Mapping):
        return False
    gateway = values.get(config_field)
    return isinstance(gateway, Mapping) and bool(gateway.get("baseUrl"))


def applied_status(
    capability: ModelConnectionCapability,
    values: Mapping[str, Any] | None,
    *,
    mode: str | None = None,
    external_owner: str | None = None,
) -> ModelConnectionStatus:
    """The usual report once a runtime started with its config."""
    if not connection_configured(values, capability.config_field):
        return ModelConnectionStatus("not_configured")
    return ModelConnectionStatus(
        "applied",
        protocol=capability.protocols[0],
        scope=capability.scope,
        mode=mode,
        external_owner=external_owner,
    )
