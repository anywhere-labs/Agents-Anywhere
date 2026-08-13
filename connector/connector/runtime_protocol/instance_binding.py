from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    PreparedSessionTimelineSync,
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInstanceSpec,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeStatus,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.protocol import AgentRuntime


def runtime_capabilities_for_instance(
    value: RuntimeCapabilitySet,
    runtime_id: str,
) -> RuntimeCapabilitySet:
    capabilities = tuple(
        replace(capability, runtime=runtime_id) for capability in value.capabilities
    )
    return replace(value, runtime=runtime_id, capabilities=capabilities)


def timeline_item_for_instance(
    item: RuntimeTimelineItem,
    runtime_id: str,
) -> RuntimeTimelineItem:
    source = {**dict(item.source), "runtime": runtime_id}
    return replace(item, source=source)


def session_meta_for_instance(value: SessionMeta, runtime_id: str) -> SessionMeta:
    return replace(value, runtime=runtime_id)


def session_state_for_instance(value: SessionState, runtime_id: str) -> SessionState:
    return replace(value, runtime=runtime_id)


def session_notice_for_instance(
    value: SessionNotice,
    runtime_id: str,
) -> SessionNotice:
    source = {**dict(value.source), "runtime": runtime_id}
    return replace(value, runtime=runtime_id, source=source)


def timeline_snapshot_for_instance(
    value: RuntimeTimelineSnapshot,
    runtime_id: str,
) -> RuntimeTimelineSnapshot:
    return replace(
        value,
        runtime=runtime_id,
        items=tuple(
            timeline_item_for_instance(item, runtime_id) for item in value.items
        ),
    )


@dataclass(frozen=True, slots=True)
class RuntimeInstanceHost(RuntimeHostClient):
    """Bind all runtime-to-connector side effects to one runtime instance."""

    base: RuntimeHostClient
    instance: RuntimeInstanceSpec
    session_source_key: str | None = None

    @property
    def connector_id(self) -> str:
        return self.base.connector_id

    @property
    def runtime_id(self) -> str:
        return self.instance.runtime_id

    @property
    def runtime_type(self) -> str:
        return self.instance.runtime_type

    @property
    def session_namespace(self) -> str:
        if self.session_source_key is None:
            return f"{self.base.connector_id}:{self.instance.runtime_id}"
        digest = hashlib.sha256(self.session_source_key.encode()).hexdigest()[:24]
        return f"{self.base.connector_id}:{self.instance.runtime_type}:{digest}"

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
        await self.base.session_meta_upsert(
            session_id=session_id,
            runtime=self.instance.runtime_id,
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
        await self.base.session_state_update(
            session_id=session_id,
            runtime=self.instance.runtime_id,
            status=status,
            selections=selections,
            external_session_id=external_session_id,
            status_reason=status_reason,
            error=error,
            metadata=self.instance_metadata(metadata),
        )

    async def runtime_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        await self.base.runtime_capabilities_update(
            runtime_capabilities_for_instance(
                capabilities,
                self.instance.runtime_id,
            )
        )

    async def session_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        await self.base.session_capabilities_update(
            runtime_capabilities_for_instance(
                capabilities,
                self.instance.runtime_id,
            )
        )

    async def model_catalog_update(self, catalog: RuntimeModelCatalog) -> None:
        await self.base.model_catalog_update(
            replace(catalog, runtime=self.instance.runtime_id)
        )

    async def permission_catalog_update(
        self,
        catalog: RuntimePermissionCatalog,
    ) -> None:
        await self.base.permission_catalog_update(
            replace(catalog, runtime=self.instance.runtime_id)
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
        await self.base.timeline_sync(
            session_id=session_id,
            runtime=self.instance.runtime_id,
            items=tuple(
                timeline_item_for_instance(item, self.instance.runtime_id)
                for item in items
            ),
            external_session_id=external_session_id,
            complete=complete,
            metadata=self.instance_metadata(metadata),
        )

    async def timeline_item_upsert(self, item: RuntimeTimelineItem) -> None:
        await self.base.timeline_item_upsert(
            timeline_item_for_instance(item, self.instance.runtime_id)
        )

    async def notice_upsert(self, notice: SessionNotice) -> None:
        await self.base.notice_upsert(
            session_notice_for_instance(notice, self.instance.runtime_id)
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
        await self.base.runtime_error(
            runtime=self.instance.runtime_id,
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
        type_prefix = f"{self.instance.runtime_type}/"
        suffix = key.removeprefix(type_prefix)
        if self.session_source_key is None:
            namespace = self.instance.runtime_id
        else:
            digest = hashlib.sha256(self.session_source_key.encode()).hexdigest()[:24]
            namespace = f"{self.instance.runtime_type}-{digest}"
        return f"{namespace}/{suffix}"

    def instance_metadata(
        self,
        metadata: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        return {
            **dict(metadata or {}),
            "runtimeType": self.instance.runtime_type,
        }


@dataclass(frozen=True, slots=True)
class RuntimeInstance(AgentRuntime):
    """Expose one provider runtime through an instance-scoped protocol surface."""

    instance: RuntimeInstanceSpec
    runtime: AgentRuntime

    @property
    def identity(self) -> RuntimeIdentity:
        identity = self.runtime.identity
        return RuntimeIdentity(
            runtime_id=self.instance.runtime_id,
            runtime_type=self.instance.runtime_type,
            name=self.instance.name,
            runtime_version=identity.runtime_version,
            protocol_version=identity.protocol_version,
        )

    async def start(self) -> None:
        await self.runtime.start()

    async def stop(self) -> None:
        await self.runtime.stop()

    async def get_config(self) -> RuntimeConfig:
        return await self.runtime.get_config()

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return runtime_capabilities_for_instance(
            await self.runtime.get_runtime_capabilities(),
            self.instance.runtime_id,
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        catalog = await self.runtime.list_model_catalog(query=query, limit=limit)
        return replace(catalog, runtime=self.instance.runtime_id)

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        catalog = await self.runtime.list_permission_catalog(query=query, limit=limit)
        return replace(catalog, runtime=self.instance.runtime_id)

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions = await self.runtime.list_sessions(
            limit=limit,
            cursor=cursor,
            force=force,
        )
        return tuple(
            session_meta_for_instance(session, self.instance.runtime_id)
            for session in sessions
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        snapshot = await self.runtime.get_session_snapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            limit=limit,
        )
        return timeline_snapshot_for_instance(snapshot, self.instance.runtime_id)

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> bool:
        return await self.runtime.sync_session_timeline(
            session_id=session_id,
            external_session_id=external_session_id,
        )

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        prepared = await self.runtime.prepare_session_timeline_sync(
            session_id=session_id,
            external_session_id=external_session_id,
        )
        if prepared is None or prepared.snapshot is None:
            return prepared
        return replace(
            prepared,
            snapshot=timeline_snapshot_for_instance(
                prepared.snapshot,
                self.instance.runtime_id,
            ),
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        state = await self.runtime.get_session_state(session_id, external_session_id)
        if state is None:
            return None
        return session_state_for_instance(state, self.instance.runtime_id)

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        notices = await self.runtime.get_session_notices(
            session_id,
            external_session_id,
        )
        return tuple(
            session_notice_for_instance(notice, self.instance.runtime_id)
            for notice in notices
        )

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        capabilities = await self.runtime.get_session_capabilities(
            session_id,
            external_session_id,
        )
        return runtime_capabilities_for_instance(
            capabilities,
            self.instance.runtime_id,
        )

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
        return await self.runtime.create_and_start_session(
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
        return await self.runtime.start_turn(
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
        return await self.runtime.steer_turn(
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
        return await self.runtime.interrupt_session(session_id, reason)

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        return await self.runtime.update_session_selections(
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
        return await self.runtime.list_commands(
            session_id=session_id,
            external_session_id=external_session_id,
            query=query,
            limit=limit,
        )

    async def list_runtime_commands(
        self,
        limit: int = 100,
    ) -> tuple[RuntimeCommand, ...]:
        return await self.runtime.list_runtime_commands(limit=limit)

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        return await self.runtime.execute_command(
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
        return await self.runtime.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )
