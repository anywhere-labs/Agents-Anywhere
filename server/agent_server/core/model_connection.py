"""Model connection: capability, adapter report, and the state clients see.

A runtime adapter declares how it takes a model connection
(``RuntimeTypeDescriptor.modelConnection``) and reports what it did with the
saved one in its ``runtime.start`` reply. The Server keeps the last report with
a digest of the connection it started the runtime with, so it can tell a saved
change apart from one the runtime already uses. See
docs/model-config-management-proposal.md §2.6.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Maturity = Literal["experimental", "beta", "stable"]
ModelProtocol = Literal["openai_responses", "openai_chat", "anthropic"]
ConnectionScope = Literal["instance", "session", "native_global"]

REPORTED_STATES = {"applied", "failed", "managed_externally", "not_configured"}


class ModelConnectionMode(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=64)
    supported: bool
    reason: str | None = Field(default=None, min_length=1, max_length=1024)


class ModelConnectionCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    auto: bool
    manual: bool
    # The connection is only used with the models listed in ``modelsField``.
    required: bool = False


class ModelConnectionCapability(BaseModel):
    """What a runtime adapter declares about taking a model connection."""

    model_config = ConfigDict(extra="forbid", strict=True)

    maturity: Maturity
    configField: str = Field(min_length=1, max_length=128)
    modelsField: str | None = Field(default=None, min_length=1, max_length=128)
    protocols: list[ModelProtocol] = Field(min_length=1, max_length=8)
    modes: list[ModelConnectionMode] = Field(default_factory=list, max_length=16)
    modeField: str | None = Field(default=None, min_length=1, max_length=128)
    # Config field holding the model new sessions use, {modelId, effortId?}.
    modelField: str | None = Field(
        default=None, min_length=1, max_length=128, exclude_if=lambda value: value is None
    )
    scope: ConnectionScope
    catalog: ModelConnectionCatalog
    apply: Literal["immediate", "new_session", "restart"]


def connection_digest(config: dict[str, Any] | None, capability: dict[str, Any] | None) -> str | None:
    """A digest of the saved connection, or None when there is none.

    It covers the address, the key and the model list, so replacing any of
    them reads as a saved change the runtime has not applied yet. The key only
    enters through a one-way hash.
    """
    if not isinstance(config, dict) or not isinstance(capability, dict):
        return None
    gateway = config.get(str(capability.get("configField") or ""))
    if not isinstance(gateway, dict) or not gateway.get("baseUrl"):
        return None
    models_field = capability.get("modelsField")
    material = {
        "gateway": gateway,
        "models": config.get(models_field) if isinstance(models_field, str) else None,
    }
    encoded = json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def stored_report(
    reply: Any,
    *,
    digest: str | None,
) -> dict[str, Any] | None:
    """What to keep of a start reply's ``modelConnection``; never a key."""
    if not isinstance(reply, dict) or reply.get("state") not in REPORTED_STATES:
        return None
    kept = {
        key: reply.get(key)
        for key in ("state", "protocol", "scope", "mode", "reason", "externalOwner")
    }
    kept["digest"] = digest
    return kept


def failed_report(reason: str, *, digest: str | None) -> dict[str, Any]:
    return {
        "state": "failed",
        "protocol": None,
        "scope": None,
        "mode": None,
        "reason": reason,
        "externalOwner": None,
        "digest": digest,
    }


def connection_status(
    *,
    capability: dict[str, Any] | None,
    config: dict[str, Any] | None,
    report: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """The state a client shows: saved and applied are told apart.

    ``not_configured``, ``saved_pending``, ``applied``, ``failed`` or
    ``managed_externally``. ``applied`` means the runtime took the
    configuration; it is not a probe of the endpoint.
    """
    if not isinstance(capability, dict):
        return None
    digest = connection_digest(config, capability)
    if digest is None:
        return {"state": "not_configured"}
    details = {
        key: (report or {}).get(key)
        for key in ("protocol", "scope", "mode", "reason", "externalOwner")
    }
    if not isinstance(report, dict) or report.get("digest") != digest:
        return {"state": "saved_pending", **{key: None for key in details}}
    state = report.get("state")
    if state == "not_configured":
        # The runtime started without a connection it should have used.
        return {"state": "saved_pending", **details}
    return {"state": state, **details}
