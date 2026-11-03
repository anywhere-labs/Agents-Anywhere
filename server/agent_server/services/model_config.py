"""Model configuration use cases: profiles and their keys.

Which runtimes use a profile, and switching them, is services/model_channels.py.

Everything a runtime-specific step needs comes from the runtime's declared
model connection capability (see core/model_connection.py); this module never
branches on a runtime's name.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from loguru import logger

from agent_server.core.device_runtime import DeviceRuntimeView, public_runtime_view
from agent_server.core.model_config import (
    ManualProfileRequest,
    ModelPreferences,
    Offer,
    ProfilePatchRequest,
    assignment_status,
    catalog_digest,
    effective_offers,
    origin_host,
    written_digest,
)
from agent_server.core.secret_fields import secret_hint
from agent_server.core.utc import utc_now
from agent_server.infra.repositories.model_config import ModelProfileInUseError
from agent_server.infra.secret_box import SecretBox, SecretBoxUnavailableError
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.device_runtimes import (
    DeviceRuntimeService,
)


class ModelConfigError(Exception):
    status_code = 400

    def __init__(self, code: str, message: str, **detail: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = {"code": code, "message": message, **detail}


class ModelConfigNotFoundError(ModelConfigError):
    status_code = 404


class ModelConfigConflictError(ModelConfigError):
    status_code = 409


class ModelConfigInvalidError(ModelConfigError):
    status_code = 422


class ModelConfigRepository(Protocol):
    async def create_model_profile(self, row: dict[str, Any]) -> dict[str, Any]: ...
    async def get_model_profile(self, profile_id: str, *, user_id: str) -> dict[str, Any]: ...
    async def list_model_profiles(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def find_model_profile_by_source(self, *, user_id: str, source: str) -> dict[str, Any] | None: ...
    async def update_model_profile(
        self, profile_id: str, *, user_id: str, values: dict[str, Any], expected_etag: int | None = None
    ) -> dict[str, Any]: ...
    async def delete_model_profile(self, profile_id: str, *, user_id: str) -> None: ...
    async def get_runtime_assignment(self, connector_id: str, runtime_id: str) -> dict[str, Any] | None: ...
    async def list_runtime_assignments(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def save_runtime_assignment(self, row: dict[str, Any]) -> None: ...
    async def delete_runtime_assignment(self, connector_id: str, runtime_id: str) -> None: ...
    async def set_device_runtime_managed_by(self, connector_id: str, runtime_id: str, managed_by: str | None) -> None: ...
    async def find_managed_runtime_id(self, connector_id: str, runtime_type: str, managed_by: str) -> str | None: ...
    async def list_user_device_runtimes(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def get_channel_selection(self, user_id: str) -> dict[str, Any] | None: ...
    async def list_channel_overrides(self, *, user_id: str) -> list[dict[str, Any]]: ...


# Fetches the Key for a Tokens Anywhere profile; set when the link exists.
TokensKeyProvider = Callable[[str, dict[str, Any]], Awaitable[str]]


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class ModelConfigService:
    def __init__(
        self,
        store: ModelConfigRepository,
        runtimes: DeviceRuntimeService,
        *,
        broker: TimelineBroker | None = None,
        tokens_key: TokensKeyProvider | None = None,
        secret_box: Callable[[], SecretBox] = SecretBox,
    ) -> None:
        self._store = store
        self._runtimes = runtimes
        self._broker = broker
        self._tokens_key = tokens_key
        self._secret_box = secret_box

    def set_tokens_key_provider(self, provider: TokensKeyProvider) -> None:
        self._tokens_key = provider

    # Reading.

    async def overview(
        self,
        *,
        user_id: str,
        runtime_rows: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Profiles and assignments as every client renders them; no secrets.

        ``runtime_rows`` saves a query when the caller already listed them.
        """
        profiles, stored_assignments = await asyncio.gather(
            self._store.list_model_profiles(user_id=user_id),
            self._store.list_runtime_assignments(user_id=user_id),
        )
        by_id = {profile["id"]: profile for profile in profiles}
        if stored_assignments and runtime_rows is None:
            runtime_rows = await self._store.list_user_device_runtimes(user_id=user_id)
        runtimes = {
            (row["connectorId"], row["runtimeId"]): DeviceRuntimeView.model_validate(row)
            for row in runtime_rows or []
        }
        assignments = []
        for assignment in stored_assignments:
            key = (assignment["connectorId"], assignment["runtimeId"])
            runtime = runtimes.get(key)
            profile = by_id.get(assignment["profileId"])
            if runtime is None or profile is None or not runtime.modelConnection:
                continue
            assignments.append(self._public_assignment(assignment, runtime, profile))
        return {
            "secretConfigured": self._box_available(),
            "profiles": [self._public_profile(profile) for profile in profiles],
            "assignments": assignments,
        }

    # Profiles.

    async def create_manual_profile(self, request: ManualProfileRequest, *, user_id: str) -> dict[str, Any]:
        box = self._box()
        profile_id = f"mpr_{secrets.token_urlsafe(12)}"
        key_ref = {"hint": secret_hint(request.apiKey)}
        now = utc_now()
        row = await self._store.create_model_profile(
            {
                "id": profile_id,
                "user_id": user_id,
                "source": "manual",
                "name": request.name,
                "origin_host": origin_host(request.offers),
                "offers_json": json.dumps([offer.model_dump(mode="json") for offer in request.offers]),
                "catalog_digest": catalog_digest(request.offers, {"hint": key_ref["hint"], "id": _digest(request.apiKey)}),
                "key_ref_json": json.dumps(key_ref),
                "secret_ciphertext": box.seal(request.apiKey, context=f"model-profile:{profile_id}"),
                "state": "active",
                "etag": 1,
                "created_at": now,
                "updated_at": now,
            }
        )
        await self._publish(user_id)
        return self._public_profile(row)

    async def save_tokens_profile(
        self,
        *,
        user_id: str,
        name: str,
        offers: list[Offer],
        key_ref: dict[str, Any],
    ) -> dict[str, Any]:
        """Create or refresh the profile a Tokens Anywhere link provides."""
        existing = await self._store.find_model_profile_by_source(user_id=user_id, source="tokens")
        preferences = _preferences(existing) if existing else None
        values = {
            "name": name,
            "origin_host": origin_host(offers),
            "offers_json": json.dumps([offer.model_dump(mode="json") for offer in offers]),
            # What runtimes get changes with the user's model choices too.
            "catalog_digest": catalog_digest(effective_offers(offers, preferences), key_ref),
            "key_ref_json": json.dumps(key_ref),
            "state": "active",
        }
        if existing is None:
            now = utc_now()
            row = await self._store.create_model_profile(
                {
                    "id": f"mpr_{secrets.token_urlsafe(12)}",
                    "user_id": user_id,
                    "source": "tokens",
                    **values,
                    "secret_ciphertext": None,
                    "etag": 1,
                    "created_at": now,
                    "updated_at": now,
                }
            )
        elif existing["catalogDigest"] == values["catalog_digest"] and existing["state"] == "active":
            row = existing
        else:
            row = await self._store.update_model_profile(existing["id"], user_id=user_id, values=values)
        await self._publish(user_id)
        return self._public_profile(row)

    async def set_tokens_preferences(self, preferences: ModelPreferences, *, user_id: str) -> dict[str, Any]:
        """Choose which Tokens models runtimes get and rename them; applied by the caller."""
        profile = await self._store.find_model_profile_by_source(user_id=user_id, source="tokens")
        if profile is None or profile["state"] != "active":
            raise ModelConfigNotFoundError("tokens_not_synced", "sync Tokens Anywhere first")
        offers = [Offer.model_validate(offer) for offer in profile["offers"]]
        row = await self._store.update_model_profile(
            profile["id"],
            user_id=user_id,
            values={
                "preferences_json": json.dumps(preferences.model_dump(mode="json")),
                "catalog_digest": catalog_digest(effective_offers(offers, preferences), profile["keyRef"]),
            },
        )
        await self._publish(user_id)
        return self._public_profile(row)

    async def detach_tokens_profile(self, *, user_id: str) -> None:
        """After unlinking: drop the Tokens profile, or keep it until no runtime uses it."""
        existing = await self._store.find_model_profile_by_source(user_id=user_id, source="tokens")
        if existing is None:
            return
        try:
            await self._store.delete_model_profile(existing["id"], user_id=user_id)
        except ModelProfileInUseError:
            # Still in use: keep it as detached until the last runtime is restored.
            await self._store.update_model_profile(existing["id"], user_id=user_id, values={"state": "detached"})
        await self._publish(user_id)

    async def update_profile(
        self,
        profile_id: str,
        request: ProfilePatchRequest,
        *,
        user_id: str,
        expected_etag: int | None,
    ) -> dict[str, Any]:
        profile = await self._get_profile(profile_id, user_id=user_id)
        if profile["source"] != "manual":
            raise ModelConfigConflictError("profile_read_only", "this profile is managed by its source")
        values: dict[str, Any] = {}
        offers = [Offer.model_validate(offer) for offer in profile["offers"]]
        key_ref = dict(profile["keyRef"])
        key_identity = key_ref.get("id")
        if request.name is not None:
            values["name"] = request.name
        if request.offers is not None:
            offers = request.offers
            values["offers_json"] = json.dumps([offer.model_dump(mode="json") for offer in offers])
            values["origin_host"] = origin_host(offers)
        if request.apiKey is not None:
            box = self._box()
            values["secret_ciphertext"] = box.seal(request.apiKey, context=f"model-profile:{profile_id}")
            key_ref = {"hint": secret_hint(request.apiKey)}
            key_identity = _digest(request.apiKey)
            values["key_ref_json"] = json.dumps(key_ref)
        elif request.offers is not None and origin_host(offers) != profile["originHost"]:
            # Same rule as runtime configs: a new origin needs the key again.
            raise ModelConfigInvalidError("secret_required", "apiKey must be entered again for a new address")
        values["catalog_digest"] = catalog_digest(offers, {**key_ref, "id": key_identity})
        try:
            row = await self._store.update_model_profile(
                profile_id, user_id=user_id, values=values, expected_etag=expected_etag
            )
        except ValueError as exc:
            raise ModelConfigConflictError("profile_changed", "the profile was changed elsewhere") from exc
        await self._publish(user_id)
        return self._public_profile(row)

    async def delete_profile(self, profile_id: str, *, user_id: str) -> None:
        profile = await self._get_profile(profile_id, user_id=user_id)
        if profile["source"] == "tokens" and profile["state"] == "active":
            raise ModelConfigConflictError("profile_read_only", "unlink Tokens Anywhere to remove this profile")
        selection = await self._store.get_channel_selection(user_id)
        overrides = await self._store.list_channel_overrides(user_id=user_id)
        if (selection or {}).get("channel") == profile_id or any(o["channel"] == profile_id for o in overrides):
            raise ModelConfigConflictError("profile_in_use", "choose another channel for the runtimes that use this one")
        try:
            await self._store.delete_model_profile(profile_id, user_id=user_id)
        except KeyError as exc:
            raise ModelConfigNotFoundError("profile_not_found", "profile not found") from exc
        except ModelProfileInUseError as exc:
            raise ModelConfigConflictError(
                "profile_in_use", "switch the runtimes that use this profile to another channel first"
            ) from exc
        await self._publish(user_id)

    # Internals.

    def _box_available(self) -> bool:
        try:
            self._secret_box()
        except SecretBoxUnavailableError:
            return False
        return True

    def _box(self) -> SecretBox:
        try:
            return self._secret_box()
        except SecretBoxUnavailableError as exc:
            raise ModelConfigConflictError(exc.code, str(exc)) from exc

    async def _get_profile(self, profile_id: str, *, user_id: str) -> dict[str, Any]:
        try:
            return await self._store.get_model_profile(profile_id, user_id=user_id)
        except KeyError as exc:
            raise ModelConfigNotFoundError("profile_not_found", "profile not found") from exc

    async def profile_key(self, profile: dict[str, Any], *, user_id: str) -> str:
        """The API key runtimes are given for this profile."""
        box = self._box()
        if profile["source"] == "manual":
            ciphertext = profile["secretCiphertext"]
            key = box.open(ciphertext, context=f"model-profile:{profile['id']}") if ciphertext else None
            if not key:
                raise ModelConfigConflictError("secret_unreadable", "enter this profile's API key again")
            return key
        if self._tokens_key is None:
            raise ModelConfigConflictError("tokens_not_linked", "link Tokens Anywhere first")
        return await self._tokens_key(user_id, profile)

    def _public_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        key_ref = profile["keyRef"]
        return {
            "id": profile["id"],
            "source": profile["source"],
            "name": profile["name"],
            "originHost": profile["originHost"],
            "offers": profile["offers"],
            # A Tokens key is known by its prefix; the ellipsis says the rest is hidden.
            "preferences": profile.get("preferences") or {"disabled": [], "names": {}},
            "keyHint": key_ref.get("hint") or (f"{key_ref['prefix']}…" if key_ref.get("prefix") else None),
            "strategyName": key_ref.get("strategy"),
            "state": profile["state"],
            "etag": str(profile["etag"]),
            "updatedAt": profile["updatedAt"],
        }

    def _public_assignment(
        self,
        assignment: dict[str, Any],
        runtime: DeviceRuntimeView,
        profile: dict[str, Any],
    ) -> dict[str, Any]:
        capability = runtime.modelConnection or {}
        status = assignment_status(
            current_written_digest=written_digest(runtime.config, capability, assignment["importedModelIds"]),
            applied_digest=assignment["appliedDigest"],
            profile_catalog_digest=profile["catalogDigest"],
            applied_catalog_digest=assignment["appliedCatalogDigest"],
        )
        return {
            "connectorId": assignment["connectorId"],
            "runtimeId": assignment["runtimeId"],
            "profileId": assignment["profileId"],
            "offerFormat": assignment["offerFormat"],
            "createdRuntime": assignment["createdRuntime"],
            "status": status,
            "appliedAt": assignment["appliedAt"],
            "modelConnectionStatus": public_runtime_view(runtime).modelConnectionStatus,
        }

    async def _publish(self, user_id: str) -> None:
        if self._broker is None:
            return
        try:
            await self._broker.publish_dashboard(
                user_id, {"type": "dashboard.changed", "serverTime": utc_now()}
            )
        except Exception:  # noqa: BLE001 - a missed push is recovered by the next one
            logger.exception("model config dashboard publish failed user_id={}", user_id)


def _preferences(profile: dict[str, Any]) -> ModelPreferences | None:
    raw = profile.get("preferences")
    return ModelPreferences.model_validate(raw) if isinstance(raw, dict) else None


def _profile_offers(profile: dict[str, Any]) -> list[Offer]:
    """The offers runtimes get from a profile, after the user's model choices."""
    return effective_offers([Offer.model_validate(offer) for offer in profile["offers"]], _preferences(profile))
