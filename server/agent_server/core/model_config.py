"""Model configuration: profiles applied to runtimes through the unified
model connection contract.

A profile is a model service the user owns (Tokens Anywhere or entered by
hand). Applying it writes the service into the runtime's model connection
fields, which the runtime adapter turns into native settings. Nothing here
knows a runtime by name: the runtime's declared capability says which fields
to write, which protocols it speaks and which modes it supports.
"""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from agent_server.core.model_connection import ModelProtocol

MAX_RUNTIME_MODELS = 64
MAX_OFFER_MODELS = 256
GATEWAY_KEY = "apiKey"
GATEWAY_URL = "baseUrl"
GATEWAY_PROTOCOL = "protocol"
MANAGED_BY = "model-config"

ProfileSource = Literal["tokens", "manual"]
AssignmentStatus = Literal["modified", "outdated", "applied"]


class ModelSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=256, pattern=r"^[^\u0000\r\n]+$")
    name: str | None = Field(default=None, min_length=1, max_length=128)
    efforts: list[str] = Field(default_factory=list, max_length=16)
    input: list[Literal["text", "image"]] = Field(default_factory=list, max_length=2)
    # Who makes the model (openai, anthropic, deepseek, gemini…), for grouping.
    vendor: str | None = Field(default=None, min_length=1, max_length=32)
    contextWindow: int | None = Field(default=None, ge=1)
    maxOutputTokens: int | None = Field(default=None, ge=1)


class Offer(BaseModel):
    """One protocol a model service speaks, at one address, with its models."""

    model_config = ConfigDict(extra="forbid")

    format: ModelProtocol
    baseUrl: str = Field(min_length=1, max_length=2048)
    models: list[ModelSpec] = Field(default_factory=list, max_length=MAX_OFFER_MODELS)

    @field_validator("baseUrl")
    @classmethod
    def _http_url(cls, value: str) -> str:
        return gateway_url(value)


def gateway_url(value: str) -> str:
    """A gateway address without its trailing slash, or ValueError."""
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("baseUrl must be an absolute HTTP or HTTPS URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("baseUrl must not carry credentials, a query or a fragment")
    return value


class ModelPreferences(BaseModel):
    """Which of a profile's models runtimes get, and under which names."""

    model_config = ConfigDict(extra="forbid")

    disabled: list[str] = Field(default_factory=list, max_length=1024)
    names: dict[str, str] = Field(default_factory=dict, max_length=1024)

    @field_validator("names")
    @classmethod
    def _names(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned = {}
        for model_id, name in value.items():
            name = name.strip()
            if not model_id or len(model_id) > 256 or not 1 <= len(name) <= 128 or "\n" in name:
                raise ValueError("a model name must be 1 to 128 characters on one line")
            cleaned[model_id] = name
        return cleaned


def effective_offers(offers: list[Offer], preferences: ModelPreferences | None) -> list[Offer]:
    """The offers runtimes get: disabled models left out, renamed ones renamed.

    An offer whose models were all turned off is left out, so runtimes that
    only speak its protocol are not set up with it.
    """
    if preferences is None or (not preferences.disabled and not preferences.names):
        return offers
    disabled = set(preferences.disabled)
    result = []
    for offer in offers:
        models = [
            spec.model_copy(update={"name": preferences.names.get(spec.id, spec.name)})
            for spec in offer.models
            if spec.id not in disabled
        ]
        if offer.models and not models:
            continue
        result.append(offer.model_copy(update={"models": models}))
    return result


class ManualProfileRequest(BaseModel):
    """A model service entered by hand.

    Either ``baseUrl``, and the server asks the gateway which protocols and
    models it has, or ``offers`` spelled out for gateways it cannot reach.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    apiKey: str = Field(min_length=1, max_length=8192, pattern=r"^[^\u0000\r\n]+$")
    baseUrl: str | None = Field(default=None, min_length=1, max_length=2048)
    offers: list[Offer] | None = Field(default=None, min_length=1, max_length=3)

    @field_validator("baseUrl")
    @classmethod
    def _http_url(cls, value: str | None) -> str | None:
        return None if value is None else gateway_url(value)

    @field_validator("offers")
    @classmethod
    def _one_offer_per_format(cls, value: list[Offer] | None) -> list[Offer] | None:
        formats = [offer.format for offer in value or []]
        if len(formats) != len(set(formats)):
            raise ValueError("each protocol may appear only once")
        return value

    @model_validator(mode="after")
    def _address_or_offers(self) -> ManualProfileRequest:
        if (self.baseUrl is None) == (self.offers is None):
            raise ValueError("give either baseUrl or offers")
        return self


class ProfilePatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=64)
    # Left out to keep the stored key.
    apiKey: str | None = Field(default=None, min_length=1, max_length=8192, pattern=r"^[^\u0000\r\n]+$")
    offers: list[Offer] | None = Field(default=None, min_length=1, max_length=3)


class RuntimeModelChoice(BaseModel):
    """The model a runtime gives new sessions, written to its ``modelField``."""

    model_config = ConfigDict(extra="forbid")

    modelId: str = Field(min_length=1, max_length=256, pattern=r"^[^\u0000\r\n]+$")
    effortId: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[^\u0000\r\n]+$")

    def config_value(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


def origin_host(offers: list[Offer]) -> str:
    return urlsplit(offers[0].baseUrl).netloc.lower() if offers else ""


def catalog_digest(offers: list[Offer], key_ref: dict[str, Any]) -> str:
    """Changes when the models, the addresses or the key in use change."""
    material = {
        "offers": [offer.model_dump(mode="json") for offer in offers],
        "key": {name: key_ref.get(name) for name in ("id", "prefix", "strategy")},
    }
    return _digest(material)


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class Match:
    offer: Offer | None
    reason: str | None = None


def match_offer(capability: dict[str, Any] | None, offers: list[Offer]) -> Match:
    """The first protocol the runtime speaks that the profile offers."""
    if not isinstance(capability, dict):
        return Match(None, "model_connection_unsupported")
    by_format = {offer.format: offer for offer in offers}
    for protocol in capability.get("protocols") or []:
        if protocol in by_format:
            return Match(by_format[protocol])
    return Match(None, "format_unsupported")


@dataclass(frozen=True, slots=True)
class ModePlan:
    """How to reach a supported mode for the runtime."""

    field: str | None
    target: str | None
    # The current instance runs in a mode that cannot take a connection.
    needs_new_instance: bool


def plan_mode(capability: dict[str, Any], config: dict[str, Any] | None, defaults: dict[str, Any]) -> ModePlan:
    field = capability.get("modeField")
    modes = capability.get("modes") or []
    supported = [mode["id"] for mode in modes if mode.get("supported")]
    if not field or not modes:
        return ModePlan(None, None, False)
    if not supported:
        return ModePlan(field, None, False)
    current = (config or {}).get(field, defaults.get(field))
    if current in supported:
        return ModePlan(field, current, False)
    # Even an unconfigured instance stays as it is: it is how the runtime's own
    # mode is reached, so the connection gets a managed instance of its own.
    return ModePlan(field, supported[0], True)


def _custom_model(spec: ModelSpec) -> dict[str, Any]:
    entry: dict[str, Any] = {"modelId": spec.id, "displayName": spec.name or spec.id}
    if spec.efforts:
        entry["efforts"] = [{"effortId": effort, "displayName": effort} for effort in spec.efforts]
    return entry


class ModelUnavailableError(ValueError):
    """The chosen model is not among the models the runtime ends up with."""


def offers_model(offer: Offer, model: RuntimeModelChoice) -> bool:
    """Whether the offer has the model, with the effort when one is named."""
    for spec in offer.models:
        if spec.id == model.modelId:
            return model.effortId is None or not spec.efforts or model.effortId in spec.efforts
    return False


class TooManyModelsError(ValueError):
    def __init__(self, importing: int, existing: int) -> None:
        super().__init__("too many models for this runtime")
        self.importing = importing
        self.existing = existing


def apply_patch(
    *,
    config: dict[str, Any],
    capability: dict[str, Any],
    offer: Offer,
    api_key: str,
    previous_imported: list[str],
    model_ids: list[str] | None,
    mode: ModePlan,
    trim: bool = False,
    model: RuntimeModelChoice | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Write the offer into the runtime's connection fields.

    Only the fields this module owns change: the connection object, the
    models it imported before, and the mode field when a mode had to be
    chosen. Models the user added stay, and win on an ID clash.

    For a runtime with a ``modelField``, a chosen model is written there; it
    must be one of the models the runtime ends up with. Without a choice, the
    runtime's current model stays only while it is still one of them.
    """
    patched = copy.deepcopy(config)
    gateway = {GATEWAY_URL: offer.baseUrl, GATEWAY_KEY: api_key}
    if len(capability.get("protocols") or []) > 1:
        # A runtime that speaks several protocols needs to know which one this is.
        gateway[GATEWAY_PROTOCOL] = offer.format
    patched[capability["configField"]] = gateway
    if mode.field and mode.target:
        patched[mode.field] = mode.target
    imported: list[str] = []
    models_field = capability.get("modelsField")
    if isinstance(models_field, str):
        current = [
            entry
            for entry in patched.get(models_field) or []
            if isinstance(entry, dict) and entry.get("modelId") not in set(previous_imported)
        ]
        own_ids = {entry.get("modelId") for entry in current}
        chosen = [
            spec
            for spec in offer.models
            if spec.id not in own_ids and (model_ids is None or spec.id in model_ids)
        ]
        if len(current) + len(chosen) > MAX_RUNTIME_MODELS:
            if not trim:
                raise TooManyModelsError(len(chosen), len(current))
            chosen = chosen[: max(MAX_RUNTIME_MODELS - len(current), 0)]
        patched[models_field] = current + [_custom_model(spec) for spec in chosen]
        imported = [spec.id for spec in chosen]
    model_field = capability.get("modelField")
    if isinstance(model_field, str):
        available = _available_models(patched, models_field, offer)
        if model is not None:
            if not _has_model(available, model):
                raise ModelUnavailableError(model.modelId)
            patched[model_field] = model.config_value()
        else:
            existing = patched.get(model_field)
            if isinstance(existing, dict) and existing.get("modelId") not in available:
                # Back to the runtime's own choice rather than a model it no longer has.
                patched.pop(model_field, None)
    return patched, imported


def _available_models(patched: dict[str, Any], models_field: Any, offer: Offer) -> dict[str, list[str]]:
    """Model IDs the runtime can use after the patch, with their efforts."""
    if isinstance(models_field, str):
        return {
            entry["modelId"]: [effort.get("effortId") for effort in entry.get("efforts") or [] if isinstance(effort, dict)]
            for entry in patched.get(models_field) or []
            if isinstance(entry, dict) and isinstance(entry.get("modelId"), str)
        }
    return {spec.id: list(spec.efforts) for spec in offer.models}


def _has_model(available: dict[str, list[str]], model: RuntimeModelChoice) -> bool:
    if model.modelId not in available:
        return False
    efforts = available[model.modelId]
    return model.effortId is None or not efforts or model.effortId in efforts


def revert_patch(
    *,
    config: dict[str, Any],
    capability: dict[str, Any],
    previous_gateway: dict[str, Any] | None,
    imported: list[str],
) -> dict[str, Any]:
    """Undo what this module wrote, keeping later changes to other fields."""
    reverted = copy.deepcopy(config)
    field = capability["configField"]
    if previous_gateway:
        reverted[field] = previous_gateway
    else:
        reverted.pop(field, None)
    models_field = capability.get("modelsField")
    if isinstance(models_field, str) and isinstance(reverted.get(models_field), list):
        reverted[models_field] = [
            entry
            for entry in reverted[models_field]
            if not (isinstance(entry, dict) and entry.get("modelId") in set(imported))
        ]
    model_field = capability.get("modelField")
    if isinstance(model_field, str):
        model = reverted.get(model_field)
        if isinstance(model, dict) and model.get("modelId") in set(imported):
            # The model left with the connection; a runtime-own model stays.
            reverted.pop(model_field, None)
    return reverted


def written_digest(config: dict[str, Any] | None, capability: dict[str, Any], imported: list[str]) -> str:
    """A digest of only the fields this module wrote."""
    config = config or {}
    models_field = capability.get("modelsField")
    models = [
        entry
        for entry in (config.get(models_field) or [] if isinstance(models_field, str) else [])
        if isinstance(entry, dict) and entry.get("modelId") in set(imported)
    ]
    return _digest({"gateway": config.get(capability["configField"]), "models": models})


def assignment_status(
    *,
    current_written_digest: str,
    applied_digest: str,
    profile_catalog_digest: str,
    applied_catalog_digest: str,
) -> AssignmentStatus:
    """Whether a runtime still has what was written: edited by hand, or the channel moved on."""
    if current_written_digest != applied_digest:
        return "modified"
    if profile_catalog_digest != applied_catalog_digest:
        return "outdated"
    return "applied"
