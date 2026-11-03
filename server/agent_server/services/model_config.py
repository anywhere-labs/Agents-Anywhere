"""Model configuration use cases: profiles, previews, apply and restore.

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
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from loguru import logger

from agent_server.core.device_runtime import DeviceRuntimeView, public_runtime_view
from agent_server.core.model_config import (
    MANAGED_BY,
    MAX_RUNTIME_MODELS,
    ApplyRequest,
    AssignmentTarget,
    ManualProfileRequest,
    Offer,
    PreviewRequest,
    ProfilePatchRequest,
    TooManyModelsError,
    apply_patch,
    assignment_status,
    catalog_digest,
    match_offer,
    origin_host,
    plan_mode,
    revert_patch,
    written_digest,
)
from agent_server.core.secret_fields import secret_hint
from agent_server.core.utc import utc_now
from agent_server.infra.repositories.model_config import ModelProfileInUseError
from agent_server.infra.secret_box import SecretBox, SecretBoxUnavailableError
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
    LockedRuntime,
)

OPERATION_LEASE = timedelta(minutes=5)
# Finished operations are kept this long for idempotent replays.
OPERATION_RETENTION = timedelta(hours=24)
RESTARTING_STATUSES = {"starting", "running"}


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
    async def set_runtime_assignment_failed(self, connector_id: str, runtime_id: str, error: dict[str, Any]) -> None: ...
    async def delete_runtime_assignment(self, connector_id: str, runtime_id: str) -> None: ...
    async def set_device_runtime_managed_by(self, connector_id: str, runtime_id: str, managed_by: str | None) -> None: ...
    async def find_managed_runtime_id(self, connector_id: str, runtime_type: str, managed_by: str) -> str | None: ...
    async def start_model_config_operation(self, row: dict[str, Any]) -> tuple[dict[str, Any], bool]: ...
    async def get_model_config_operation(self, operation_id: str, *, user_id: str) -> dict[str, Any]: ...
    async def update_model_config_operation(
        self,
        operation_id: str,
        *,
        targets: list[dict[str, Any]] | None = None,
        result: dict[str, Any] | None = None,
        finished: bool = False,
    ) -> None: ...
    async def list_running_model_config_operations(self, *, user_id: str, now: str) -> list[dict[str, Any]]: ...
    async def prune_model_config_operations(self, *, before: str) -> None: ...
    async def list_user_device_runtimes(self, *, user_id: str) -> list[dict[str, Any]]: ...


# Fetches the Key for a Tokens Anywhere profile; set when the link exists.
TokensKeyProvider = Callable[[str, dict[str, Any]], Awaitable[str]]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


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
        running = await self._running_targets(user_id) if stored_assignments else set()
        assignments = []
        for assignment in stored_assignments:
            key = (assignment["connectorId"], assignment["runtimeId"])
            runtime = runtimes.get(key)
            profile = by_id.get(assignment["profileId"])
            if runtime is None or profile is None or not runtime.modelConnection:
                continue
            assignments.append(self._public_assignment(assignment, runtime, profile, key in running))
        return {
            "secretConfigured": self._box_available(),
            "profiles": [self._public_profile(profile) for profile in profiles],
            "assignments": assignments,
        }

    async def get_operation(self, operation_id: str, *, user_id: str) -> dict[str, Any]:
        try:
            operation = await self._store.get_model_config_operation(operation_id, user_id=user_id)
        except KeyError as exc:
            raise ModelConfigNotFoundError("operation_not_found", "operation not found") from exc
        return self._public_operation(operation)

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
        values = {
            "name": name,
            "origin_host": origin_host(offers),
            "offers_json": json.dumps([offer.model_dump(mode="json") for offer in offers]),
            "catalog_digest": catalog_digest(offers, key_ref),
            "key_ref_json": json.dumps(key_ref),
            "state": "active",
        }
        existing = await self._store.find_model_profile_by_source(user_id=user_id, source="tokens")
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
        try:
            await self._store.delete_model_profile(profile_id, user_id=user_id)
        except KeyError as exc:
            raise ModelConfigNotFoundError("profile_not_found", "profile not found") from exc
        except ModelProfileInUseError as exc:
            raise ModelConfigConflictError(
                "profile_in_use", "restore the runtimes that use this profile first"
            ) from exc
        await self._publish(user_id)

    # Preview and apply.

    async def preview(self, request: PreviewRequest, *, user_id: str) -> dict[str, Any]:
        profile = await self._get_profile(request.profileId, user_id=user_id)
        offers = [Offer.model_validate(offer) for offer in profile["offers"]]
        if request.targets is None:
            rows = await self._store.list_user_device_runtimes(user_id=user_id)
            runtimes = [DeviceRuntimeView.model_validate(row) for row in rows]
        else:
            runtimes = [await self._owned_runtime(target, user_id=user_id) for target in request.targets]
        running = await self._running_targets(user_id)
        targets = []
        for runtime in runtimes:
            if runtime.managedBy == MANAGED_BY and request.targets is None:
                # A managed instance is reached through the runtime it serves.
                continue
            targets.append(await self._preview_target(runtime, profile, offers, running))
        return {"profileId": profile["id"], "targets": targets}

    async def apply(self, request: ApplyRequest, *, user_id: str, idempotency_key: str) -> dict[str, Any]:
        box = self._box()
        profile = await self._get_profile(request.profileId, user_id=user_id)
        if profile["state"] != "active":
            raise ModelConfigConflictError("profile_detached", "this profile can no longer be applied")
        operation = await self._begin_operation(
            user_id=user_id,
            kind="apply",
            idempotency_key=idempotency_key,
            request=request.model_dump(mode="json"),
            targets=[target.model_dump() for target in request.targets],
        )
        if operation.get("finishedAt") or operation.get("reused"):
            return self._public_operation(operation)
        try:
            api_key = await self._profile_key(profile, user_id=user_id, box=box)
        except ModelConfigError as exc:
            # Finish the operation, or its lease would hold the targets as busy.
            failed = [
                {**target.model_dump(), "result": "failed", "reason": exc.code, "message": exc.message}
                for target in request.targets
            ]
            return await self._finish_operation(operation["id"], failed, user_id=user_id)
        offers = [Offer.model_validate(offer) for offer in profile["offers"]]
        results = []
        for target in request.targets:
            try:
                result = await self._apply_target(
                    target, profile, offers, api_key, request, box, user_id=user_id
                )
            except ModelConfigError as exc:
                result = {**target.model_dump(), "result": "skipped", "reason": exc.code, "message": exc.message}
            except DeviceRuntimeError as exc:
                result = {**target.model_dump(), "result": "failed", "reason": exc.code, "message": exc.message}
            results.append(result)
            await self._store.update_model_config_operation(operation["id"], result={"results": results})
            await self._publish(user_id)
        return await self._finish_operation(operation["id"], results, user_id=user_id)

    async def restore(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str,
        allow_interrupt: bool,
    ) -> dict[str, Any]:
        target = AssignmentTarget(connectorId=connector_id, runtimeId=runtime_id)
        runtime = await self._owned_runtime(target, user_id=user_id)
        assignment = await self._store.get_runtime_assignment(connector_id, runtime_id)
        if assignment is None:
            raise ModelConfigNotFoundError("assignment_not_found", "this runtime has no applied model configuration")
        capability = runtime.modelConnection or {}
        if not capability:
            raise ModelConfigConflictError("model_connection_unsupported", "this runtime no longer takes a model connection")
        async with self._runtimes.locked_runtime(connector_id, runtime_id, user_id=user_id) as handle:
            await self._check_interruption(handle, capability, allow_interrupt)
            if assignment["createdRuntime"]:
                # Keep the instance and its sessions; it only stops.
                if handle.runtime.active:
                    await handle.set_active(False)
            else:
                previous = None
                ciphertext = assignment["previousGatewayCiphertext"]
                if ciphertext:
                    opened = self._box().open(ciphertext, context=f"previous-gateway:{connector_id}:{runtime_id}")
                    previous = json.loads(opened) if opened else None
                reverted = revert_patch(
                    config=handle.runtime.config or {},
                    capability=capability,
                    previous_gateway=previous,
                    imported=assignment["importedModelIds"],
                )
                await handle.put_config(reverted)
        await self._store.delete_runtime_assignment(connector_id, runtime_id)
        await self._publish(user_id)
        return {"connectorId": connector_id, "runtimeId": runtime_id, "result": "restored"}

    async def interrupting(self, targets: list[AssignmentTarget], *, user_id: str) -> bool:
        """Whether applying to these runtimes would interrupt running tasks."""
        for target in targets:
            runtime = await self._owned_runtime(target, user_id=user_id)
            capability = runtime.modelConnection or {}
            if capability.get("apply") != "restart" or not runtime.active:
                continue
            if runtime.status in RESTARTING_STATUSES and await self._runtimes.running_session_count(
                runtime.connectorId, runtime.runtimeId
            ):
                return True
        return False

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

    async def _owned_runtime(self, target: AssignmentTarget, *, user_id: str) -> DeviceRuntimeView:
        return await self._runtimes.get_runtime(target.connectorId, target.runtimeId, user_id=user_id)

    async def _profile_key(self, profile: dict[str, Any], *, user_id: str, box: SecretBox) -> str:
        if profile["source"] == "manual":
            ciphertext = profile["secretCiphertext"]
            key = box.open(ciphertext, context=f"model-profile:{profile['id']}") if ciphertext else None
            if not key:
                raise ModelConfigConflictError("secret_unreadable", "enter this profile's API key again")
            return key
        if self._tokens_key is None:
            raise ModelConfigConflictError("tokens_not_linked", "link Tokens Anywhere first")
        return await self._tokens_key(user_id, profile)

    async def _running_targets(self, user_id: str) -> set[tuple[str, str]]:
        running: set[tuple[str, str]] = set()
        for operation in await self._store.list_running_model_config_operations(user_id=user_id, now=utc_now()):
            for target in operation["targets"]:
                if target.get("runtimeId") and target.get("state") != "done":
                    running.add((target["connectorId"], target["runtimeId"]))
        return running

    async def _preview_target(
        self,
        runtime: DeviceRuntimeView,
        profile: dict[str, Any],
        offers: list[Offer],
        running: set[tuple[str, str]],
    ) -> dict[str, Any]:
        base = {
            "connectorId": runtime.connectorId,
            "runtimeId": runtime.runtimeId,
            "runtimeType": runtime.runtimeType,
            "name": runtime.name,
            "maturity": runtime.maturity,
        }
        capability = runtime.modelConnection
        if not capability:
            return {**base, "decision": "skip", "reason": "model_connection_unsupported"}
        if not runtime.present:
            return {**base, "decision": "skip", "reason": "not_installed"}
        match = match_offer(capability, offers)
        if match.offer is None:
            return {**base, "decision": "skip", "reason": match.reason}
        mode = plan_mode(capability, runtime.config if runtime.configured else None, runtime.defaults)
        if mode.field and mode.target is None:
            return {**base, "decision": "skip", "reason": "mode_unsupported"}
        if (runtime.connectorId, runtime.runtimeId) in running:
            return {**base, "decision": "skip", "reason": "busy_operation"}
        if not await self._runtimes.is_connector_online(runtime.connectorId):
            return {**base, "decision": "skip", "reason": "device_offline"}
        sessions = await self._runtimes.running_session_count(runtime.connectorId, runtime.runtimeId)
        config = runtime.config or {}
        assignment = await self._store.get_runtime_assignment(runtime.connectorId, runtime.runtimeId)
        previous_imported = set(assignment["importedModelIds"]) if assignment else set()
        models_field = capability.get("modelsField")
        own = [
            entry
            for entry in (config.get(models_field) or [] if isinstance(models_field, str) else [])
            if isinstance(entry, dict) and entry.get("modelId") not in previous_imported
        ]
        importing = [spec for spec in match.offer.models if spec.id not in {e.get("modelId") for e in own}]
        if _requires_models(capability) and not own and not importing:
            return {**base, "decision": "skip", "reason": "models_required"}
        gateway = config.get(capability["configField"])
        replaces = None
        if isinstance(gateway, dict) and gateway.get("baseUrl"):
            replaces = {
                "kind": "profile" if assignment else "manual",
                "profileId": assignment["profileId"] if assignment else None,
                "host": _host(gateway["baseUrl"]),
            }
        return {
            **base,
            "decision": "apply",
            "offerFormat": match.offer.format,
            "effect": "new_instance" if mode.needs_new_instance else capability.get("apply"),
            "scope": capability.get("scope"),
            "requiresConfirmation": capability.get("scope") == "native_global",
            "runningSessions": sessions if runtime.status in RESTARTING_STATUSES else 0,
            "replaces": replaces,
            "models": {
                "importing": len(importing) if isinstance(models_field, str) else 0,
                "existing": len(own),
                "limit": MAX_RUNTIME_MODELS,
            },
            "tooManyModels": isinstance(models_field, str) and len(own) + len(importing) > MAX_RUNTIME_MODELS,
            "capabilityMaturity": capability.get("maturity"),
        }

    async def _check_interruption(self, handle: LockedRuntime, capability: dict[str, Any], allow: bool) -> None:
        if allow or capability.get("apply") != "restart":
            return
        restarts = handle.runtime.active and handle.runtime.status in RESTARTING_STATUSES
        if restarts and await handle.running_session_count():
            raise ModelConfigConflictError("busy", "tasks are running; allow interrupting them to apply")

    async def _apply_target(
        self,
        target: AssignmentTarget,
        profile: dict[str, Any],
        offers: list[Offer],
        api_key: str,
        request: ApplyRequest,
        box: SecretBox,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        runtime = await self._owned_runtime(target, user_id=user_id)
        capability = runtime.modelConnection
        if not capability:
            raise ModelConfigConflictError("model_connection_unsupported", "this runtime takes no model connection")
        if capability.get("scope") == "native_global" and not request.confirmNativeGlobal:
            # Changing a runtime's own global settings is a separate, explicit act.
            raise ModelConfigConflictError(
                "confirmation_required", "this changes the runtime's own global configuration"
            )
        match = match_offer(capability, offers)
        if match.offer is None:
            raise ModelConfigConflictError(match.reason or "format_unsupported", "no protocol in common")
        mode = plan_mode(capability, runtime.config if runtime.configured else None, runtime.defaults)
        if mode.field and mode.target is None:
            raise ModelConfigConflictError("mode_unsupported", "no mode of this runtime takes a connection")
        catalog = profile["catalogDigest"]
        managed = False
        if mode.needs_new_instance:
            managed_id = await self._store.find_managed_runtime_id(
                runtime.connectorId, runtime.runtimeType, MANAGED_BY
            )
            if managed_id is None:
                return await self._create_managed(
                    runtime, capability, profile, match.offer, api_key, request, mode, user_id=user_id
                )
            target = AssignmentTarget(connectorId=runtime.connectorId, runtimeId=managed_id)
            managed = True
        async with self._runtimes.locked_runtime(target.connectorId, target.runtimeId, user_id=user_id) as handle:
            await self._check_interruption(handle, capability, request.allowInterrupt)
            current = handle.runtime
            assignment = await self._store.get_runtime_assignment(target.connectorId, target.runtimeId)
            previous_imported = assignment["importedModelIds"] if assignment else []
            # The managed instance is this module's own: it has no connection to give back.
            created_runtime = managed or bool(assignment and assignment["createdRuntime"])
            if created_runtime:
                previous_ciphertext = None
            elif assignment is not None:
                previous_ciphertext = assignment["previousGatewayCiphertext"]
            else:
                gateway = (current.config or {}).get(capability["configField"])
                previous_ciphertext = (
                    box.seal(json.dumps(gateway), context=f"previous-gateway:{target.connectorId}:{target.runtimeId}")
                    if isinstance(gateway, dict)
                    else None
                )
            base = dict(current.config) if current.configured and current.config is not None else dict(current.defaults)
            plan = plan_mode(capability, base if current.configured else None, current.defaults)
            try:
                patched, imported = apply_patch(
                    config=base,
                    capability=capability,
                    offer=match.offer,
                    api_key=api_key,
                    previous_imported=previous_imported,
                    model_ids=request.modelIds,
                    mode=plan,
                )
            except TooManyModelsError as exc:
                raise ModelConfigInvalidError(
                    "too_many_models",
                    "choose which models to import",
                    importing=exc.importing,
                    existing=exc.existing,
                    limit=MAX_RUNTIME_MODELS,
                ) from exc
            _check_models(capability, patched)
            # A first configuration starts the runtime, and so does applying to
            # the managed instance a restore stopped.
            start = not current.configured or created_runtime
            try:
                updated = await handle.put_config(patched)
                if start and not updated.active:
                    updated = await handle.set_active(True)
            except DeviceRuntimeError as exc:
                if assignment is not None:
                    await self._store.set_runtime_assignment_failed(
                        target.connectorId, target.runtimeId, {"code": exc.code, "message": exc.message}
                    )
                raise
            await self._store.save_runtime_assignment(
                {
                    "connector_id": target.connectorId,
                    "runtime_id": target.runtimeId,
                    "profile_id": profile["id"],
                    "offer_format": match.offer.format,
                    "created_runtime": int(created_runtime),
                    "applied_digest": written_digest(handle.runtime.config, capability, imported),
                    "applied_catalog_digest": catalog,
                    "imported_model_ids": imported,
                    "previous_gateway_ciphertext": previous_ciphertext,
                    "status": "applied",
                    "error": None,
                    "applied_at": utc_now(),
                }
            )
            return {
                **target.model_dump(),
                "result": "applied",
                "modelConnectionStatus": public_runtime_view(handle.runtime).modelConnectionStatus,
            }

    async def _create_managed(
        self,
        runtime: DeviceRuntimeView,
        capability: dict[str, Any],
        profile: dict[str, Any],
        offer: Offer,
        api_key: str,
        request: ApplyRequest,
        mode: Any,
        *,
        user_id: str,
    ) -> dict[str, Any]:
        """Create the managed instance a runtime in an unsupported mode needs."""
        config, imported = apply_patch(
            config=dict(runtime.defaults),
            capability=capability,
            offer=offer,
            api_key=api_key,
            previous_imported=[],
            model_ids=request.modelIds,
            mode=mode,
        )
        _check_models(capability, config)
        created = await self._runtimes.create_runtime(
            runtime.connectorId,
            runtime_type=runtime.runtimeType,
            name=f"{runtime.typeDisplayName}（{profile['name']}）"[:128],
            config=config,
            active=True,
            user_id=user_id,
        )
        await self._store.set_device_runtime_managed_by(runtime.connectorId, created.runtimeId, MANAGED_BY)
        await self._store.save_runtime_assignment(
            {
                "connector_id": runtime.connectorId,
                "runtime_id": created.runtimeId,
                "profile_id": profile["id"],
                "offer_format": offer.format,
                "created_runtime": 1,
                "applied_digest": written_digest(config, capability, imported),
                "applied_catalog_digest": profile["catalogDigest"],
                "imported_model_ids": imported,
                "previous_gateway_ciphertext": None,
                "status": "applied",
                "error": None,
                "applied_at": utc_now(),
            }
        )
        return {
            "connectorId": runtime.connectorId,
            "runtimeId": created.runtimeId,
            "servesRuntimeId": runtime.runtimeId,
            "result": "applied",
            "createdRuntime": True,
            "modelConnectionStatus": public_runtime_view(created).modelConnectionStatus,
        }

    async def _begin_operation(
        self,
        *,
        user_id: str,
        kind: str,
        idempotency_key: str,
        request: dict[str, Any],
        targets: list[dict[str, Any]],
    ) -> dict[str, Any]:
        now = _now()
        await self._store.prune_model_config_operations(before=_iso(now - OPERATION_RETENTION))
        request_digest = _digest({"kind": kind, "request": request})
        operation, created = await self._store.start_model_config_operation(
            {
                "id": f"mop_{secrets.token_urlsafe(12)}",
                "user_id": user_id,
                "kind": kind,
                "idempotency_key": idempotency_key,
                "request_digest": request_digest,
                "targets": targets,
                "lease_until": _iso(now + OPERATION_LEASE),
                "created_at": _iso(now),
            }
        )
        if created:
            await self._publish(user_id)
            return operation
        if operation["requestDigest"] != request_digest:
            raise ModelConfigConflictError(
                "idempotency_key_reused", "this Idempotency-Key was used for a different request"
            )
        if operation["finishedAt"] is None and operation["leaseUntil"] > _iso(now):
            raise ModelConfigConflictError("operation_in_progress", "this request is still running", operationId=operation["id"])
        return {**operation, "reused": True}

    async def _finish_operation(self, operation_id: str, results: list[dict[str, Any]], *, user_id: str) -> dict[str, Any]:
        targets = [{**result, "state": "done"} for result in results]
        await self._store.update_model_config_operation(
            operation_id, targets=targets, result={"results": results}, finished=True
        )
        await self._publish(user_id)
        operation = await self._store.get_model_config_operation(operation_id, user_id=user_id)
        return self._public_operation(operation)

    def _public_operation(self, operation: dict[str, Any]) -> dict[str, Any]:
        return {
            "operationId": operation["id"],
            "kind": operation["kind"],
            "finished": operation["finishedAt"] is not None,
            "results": (operation.get("result") or {}).get("results", []),
        }

    def _public_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        key_ref = profile["keyRef"]
        return {
            "id": profile["id"],
            "source": profile["source"],
            "name": profile["name"],
            "originHost": profile["originHost"],
            "offers": profile["offers"],
            "keyHint": key_ref.get("hint") or key_ref.get("prefix"),
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
        applying: bool,
    ) -> dict[str, Any]:
        capability = runtime.modelConnection or {}
        status = assignment_status(
            stored=assignment["status"],
            applying=applying,
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
            "error": assignment["error"],
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


def _requires_models(capability: dict[str, Any]) -> bool:
    catalog = capability.get("catalog")
    return isinstance(catalog, dict) and bool(catalog.get("required")) and isinstance(capability.get("modelsField"), str)


def _check_models(capability: dict[str, Any], config: dict[str, Any]) -> None:
    if _requires_models(capability) and not config.get(capability["modelsField"]):
        raise ModelConfigConflictError("models_required", "this runtime needs at least one model")


def _host(url: str) -> str:
    from urllib.parse import urlsplit

    return urlsplit(url).netloc.lower()
