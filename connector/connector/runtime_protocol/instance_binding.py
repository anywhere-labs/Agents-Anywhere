from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.instance_models import (
    RuntimeInstanceSpec,
    RuntimeSourceKey,
)
from connector.runtime_protocol.models import (
    PreparedSessionTimelineSync,
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeStatus,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionSourceObservation,
    SessionState,
)
from connector.runtime_protocol.protocol import AgentRuntime


def _instance_metadata(
    instance: RuntimeInstanceSpec,
    metadata: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        **dict(metadata or {}),
        "runtimeType": instance.runtime_type,
        "runtimeId": instance.runtime_id,
    }


def _capability_for_instance(
    capability: RuntimeCapability,
    instance: RuntimeInstanceSpec,
) -> RuntimeCapability:
    return replace(
        capability,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        metadata=_instance_metadata(instance, capability.metadata),
    )


def runtime_capabilities_for_instance(
    value: RuntimeCapabilitySet,
    instance: RuntimeInstanceSpec,
) -> RuntimeCapabilitySet:
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        capabilities=tuple(
            _capability_for_instance(capability, instance)
            for capability in value.capabilities
        ),
        metadata=_instance_metadata(instance, value.metadata),
    )


def runtime_config_for_instance(
    value: RuntimeConfig,
    instance: RuntimeInstanceSpec,
) -> RuntimeConfig:
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        metadata=_instance_metadata(instance, value.metadata),
    )


def timeline_item_for_instance(
    item: RuntimeTimelineItem,
    instance: RuntimeInstanceSpec,
) -> RuntimeTimelineItem:
    source = {
        **dict(item.source),
        "runtime": instance.runtime_type,
        "runtimeType": instance.runtime_type,
        "runtimeId": instance.runtime_id,
    }
    return replace(
        item,
        source=source,
        metadata=_instance_metadata(instance, item.metadata),
    )


def session_meta_for_instance(
    value: SessionMeta,
    instance: RuntimeInstanceSpec,
) -> SessionMeta:
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        metadata=_instance_metadata(instance, value.metadata),
    )


def session_state_for_instance(
    value: SessionState,
    instance: RuntimeInstanceSpec,
) -> SessionState:
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        metadata=_instance_metadata(instance, value.metadata),
    )


def session_notice_for_instance(
    value: SessionNotice,
    instance: RuntimeInstanceSpec,
) -> SessionNotice:
    source = {
        **dict(value.source),
        "runtime": instance.runtime_type,
        "runtimeType": instance.runtime_type,
        "runtimeId": instance.runtime_id,
    }
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        source=source,
        metadata=_instance_metadata(instance, value.metadata),
    )


def timeline_snapshot_for_instance(
    value: RuntimeTimelineSnapshot,
    instance: RuntimeInstanceSpec,
) -> RuntimeTimelineSnapshot:
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
        items=tuple(timeline_item_for_instance(item, instance) for item in value.items),
        metadata=_instance_metadata(instance, value.metadata),
    )


def session_source_observation_for_instance(
    value: SessionSourceObservation,
    instance: RuntimeInstanceSpec,
) -> SessionSourceObservation:
    return replace(
        value,
        runtime=instance.runtime_type,
        runtime_id=instance.runtime_id,
    )


@dataclass(frozen=True, slots=True)
class RuntimeInstanceHost(RuntimeHostClient):
    """Bind runtime-to-Connector effects to one immutable instance identity."""

    base: RuntimeHostClient
    instance: RuntimeInstanceSpec
    source_key: RuntimeSourceKey | None = None

    @property
    def connector_id(self) -> str:
        return self.base.connector_id

    @property
    def session_namespace(self) -> str:
        if self.instance.runtime_id == self.instance.runtime_type:
            return self.connector_id
        namespace = self.instance.runtime_id
        if self.source_key is not None:
            namespace = f"{namespace}:{_source_key_digest(self.source_key)}"
        return f"{self.connector_id}:{self.instance.runtime_type}:{namespace}"

    async def session_meta_upsert(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        ordering_time: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self._validate_native_runtime(runtime)
        await self.base.session_meta_upsert(
            session_id=session_id,
            runtime=self.instance.runtime_type,
            external_session_id=external_session_id,
            title=title,
            cwd=cwd,
            ordering_time=ordering_time,
            metadata=self.instance_metadata(metadata),
        )

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: RuntimeStatus | None = None,
        selections: Mapping[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self._validate_native_runtime(runtime)
        await self.base.session_state_update(
            session_id=session_id,
            runtime=self.instance.runtime_type,
            status=status,
            selections=selections,
            external_session_id=external_session_id,
            status_reason=status_reason,
            error=error,
            metadata=self.instance_metadata(metadata),
        )

    async def session_source_update(
        self,
        observation: SessionSourceObservation,
    ) -> None:
        self._validate_native_runtime(observation.runtime)
        await self.base.session_source_update(
            session_source_observation_for_instance(observation, self.instance)
        )

    async def session_turn_ended(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        turn_id: str | None = None,
        outcome: str = "completed",
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self._validate_native_runtime(runtime)
        await self.base.session_turn_ended(
            session_id=session_id,
            runtime=self.instance.runtime_type,
            external_session_id=external_session_id,
            turn_id=turn_id,
            outcome=outcome,
            metadata=self.instance_metadata(metadata),
        )

    async def runtime_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        await self.base.runtime_capabilities_update(
            runtime_capabilities_for_instance(capabilities, self.instance)
        )

    async def session_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        await self.base.session_capabilities_update(
            runtime_capabilities_for_instance(capabilities, self.instance)
        )

    async def model_catalog_update(self, catalog: RuntimeModelCatalog) -> None:
        await self.base.model_catalog_update(
            replace(
                catalog,
                runtime=self.instance.runtime_type,
                runtime_id=self.instance.runtime_id,
            )
        )

    async def permission_catalog_update(
        self,
        catalog: RuntimePermissionCatalog,
    ) -> None:
        await self.base.permission_catalog_update(
            replace(
                catalog,
                runtime=self.instance.runtime_type,
                runtime_id=self.instance.runtime_id,
            )
        )

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[RuntimeTimelineItem, ...],
        external_session_id: str | None = None,
        complete: bool = False,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self._validate_native_runtime(runtime)
        await self.base.timeline_sync(
            session_id=session_id,
            runtime=self.instance.runtime_type,
            items=tuple(
                timeline_item_for_instance(item, self.instance) for item in items
            ),
            external_session_id=external_session_id,
            complete=complete,
            metadata=self.instance_metadata(metadata),
        )

    async def timeline_item_upsert(self, item: RuntimeTimelineItem) -> None:
        await self.base.timeline_item_upsert(
            timeline_item_for_instance(item, self.instance)
        )

    async def notice_upsert(self, notice: SessionNotice) -> None:
        await self.base.notice_upsert(
            session_notice_for_instance(notice, self.instance)
        )

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        session_id: str | None = None,
        external_session_id: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        self._validate_native_runtime(runtime)
        await self.base.runtime_error(
            runtime=self.instance.runtime_type,
            code=code,
            message=message,
            session_id=session_id,
            external_session_id=external_session_id,
            details=self.instance_metadata(details),
        )

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        return await self.base.attachment_download(session_id, file_id)

    async def sync_state_read(self, key: str) -> Mapping[str, Any] | None:
        return await self.base.sync_state_read(self.instance_sync_key(key))

    async def sync_state_write(
        self,
        key: str,
        value: Mapping[str, Any],
    ) -> None:
        await self.base.sync_state_write(self.instance_sync_key(key), value)

    async def sync_state_delete(self, key: str) -> None:
        await self.base.sync_state_delete(self.instance_sync_key(key))

    def instance_sync_key(self, key: str) -> str:
        if self.instance.runtime_id == self.instance.runtime_type:
            return key
        type_prefix = f"{self.instance.runtime_type}/"
        suffix = key.removeprefix(type_prefix)
        namespace = self.instance.runtime_id
        if self.source_key is not None:
            namespace = f"{namespace}/{_source_key_digest(self.source_key)}"
        return f"{self.instance.runtime_type}/instances/{namespace}/{suffix}"

    def instance_metadata(
        self,
        metadata: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        result = _instance_metadata(self.instance, metadata)
        if self.source_key is not None:
            result["runtimeSource"] = {
                "kind": self.source_key.kind,
                "key": self.source_key.key,
            }
        return result

    def _validate_native_runtime(self, runtime: str) -> None:
        if runtime != self.instance.runtime_type:
            raise ValueError(
                f"runtime host call used type {runtime!r}; expected "
                f"{self.instance.runtime_type!r}"
            )


@dataclass(frozen=True, slots=True)
class RuntimeInstance(AgentRuntime):
    """Expose one native provider runtime without changing its provider type."""

    instance: RuntimeInstanceSpec
    native_runtime: AgentRuntime

    def __post_init__(self) -> None:
        if self.native_runtime.identity.runtime != self.instance.runtime_type:
            raise ValueError(
                "native runtime identity does not match the instance runtime type"
            )

    @property
    def identity(self) -> RuntimeIdentity:
        identity = self.native_runtime.identity
        return replace(
            identity,
            runtime=self.instance.runtime_type,
            runtime_id=self.instance.runtime_id,
            display_name=self.instance.name,
        )

    async def start(self) -> None:
        await self.native_runtime.start()

    async def stop(self) -> None:
        await self.native_runtime.stop()

    async def get_config(self) -> RuntimeConfig:
        return runtime_config_for_instance(
            await self.native_runtime.get_config(),
            self.instance,
        )

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return runtime_capabilities_for_instance(
            await self.native_runtime.get_runtime_capabilities(),
            self.instance,
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        catalog = await self.native_runtime.list_model_catalog(query=query, limit=limit)
        return replace(
            catalog,
            runtime=self.instance.runtime_type,
            runtime_id=self.instance.runtime_id,
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        catalog = await self.native_runtime.list_permission_catalog(
            query=query,
            limit=limit,
        )
        return replace(
            catalog,
            runtime=self.instance.runtime_type,
            runtime_id=self.instance.runtime_id,
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions = await self.native_runtime.list_sessions(
            limit=limit,
            cursor=cursor,
            force=force,
        )
        return tuple(
            session_meta_for_instance(session, self.instance) for session in sessions
        )

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions = await self.native_runtime.list_complete_session_inventory(
            page_size=page_size,
            force=force,
        )
        return tuple(
            session_meta_for_instance(session, self.instance) for session in sessions
        )

    def supports_complete_session_inventory(self) -> bool:
        return self.native_runtime.supports_complete_session_inventory()

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        snapshot = await self.native_runtime.get_session_snapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            limit=limit,
        )
        return timeline_snapshot_for_instance(snapshot, self.instance)

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> bool:
        return await self.native_runtime.sync_session_timeline(
            session_id=session_id,
            external_session_id=external_session_id,
        )

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        prepared = await self.native_runtime.prepare_session_timeline_sync(
            session_id=session_id,
            external_session_id=external_session_id,
        )
        if prepared is None or prepared.snapshot is None:
            return prepared
        return replace(
            prepared,
            snapshot=timeline_snapshot_for_instance(
                prepared.snapshot,
                self.instance,
            ),
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        state = await self.native_runtime.get_session_state(
            session_id,
            external_session_id,
        )
        return (
            None if state is None else session_state_for_instance(state, self.instance)
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        notices = await self.native_runtime.get_session_notices(
            session_id,
            external_session_id,
        )
        return tuple(
            session_notice_for_instance(notice, self.instance) for notice in notices
        )

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        capabilities = await self.native_runtime.get_session_capabilities(
            session_id,
            external_session_id,
        )
        return runtime_capabilities_for_instance(capabilities, self.instance)

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.native_runtime.create_and_start_session(
            session_id=session_id,
            content=content,
            title=title,
            cwd=cwd,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.native_runtime.start_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
            cwd=cwd,
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.native_runtime.steer_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.native_runtime.interrupt_session(session_id, reason)

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        return await self.native_runtime.update_session_selections(
            session_id,
            external_session_id,
            selections,
        )

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        return await self.native_runtime.list_commands(
            session_id=session_id,
            external_session_id=external_session_id,
            query=query,
            limit=limit,
        )

    async def list_runtime_commands(
        self,
        limit: int = 100,
    ) -> tuple[RuntimeCommand, ...]:
        return await self.native_runtime.list_runtime_commands(limit=limit)

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        return await self.native_runtime.execute_command(
            session_id=session_id,
            command=command,
            external_session_id=external_session_id,
            raw=raw,
            args=args,
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        return await self.native_runtime.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )


def _source_key_digest(source_key: RuntimeSourceKey) -> str:
    payload = f"{source_key.kind}\0{source_key.key}".encode()
    return hashlib.sha256(payload).hexdigest()[:24]
