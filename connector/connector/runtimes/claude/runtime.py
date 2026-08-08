from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
    SessionMeta,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import provider_config

SdkLoader = Callable[[], Any]


@dataclass(slots=True)
class ClaudeRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    sdk_loader: SdkLoader | None = None
    runtime_version: str = "native-skeleton-0"

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="claude",
            runtime_version=self.runtime_version,
            display_name="Claude",
        )

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        capabilities = provider_config.claude_capabilities()
        return RuntimeCapabilitySet(
            runtime="claude",
            revision=self.config.revision,
            connector_id=self.host.connector_id,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=protocol_id,
                    scope="runtime",
                    runtime="claude",
                    connector_id=self.host.connector_id,
                    supported=supported,
                    available=supported,
                    allowed=True,
                    unavailable_reason=None
                    if supported
                    else "not_implemented",
                    metadata={"source": "claude.skeleton"},
                )
                for inventory_key, protocol_id in (
                    ("modelCatalog", "catalog.model"),
                    ("modelCatalog", "catalog.effort"),
                    ("permissionCatalog", "catalog.permission"),
                    ("startTurn", "session.send_message"),
                    ("steerTurn", "session.steer"),
                    ("interruptTurn", "session.interrupt"),
                    ("interactions", "session.interaction.approval"),
                    ("attachments", "runtime.attachment"),
                )
                for supported in (capabilities.get(inventory_key) is True,)
            ),
            metadata={"source": "claude.skeleton"},
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        _ = query
        _ = limit
        return RuntimeModelCatalog(runtime="claude", revision=self.config.revision, models=())

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        _ = query
        _ = limit
        return RuntimePermissionCatalog(
            runtime="claude",
            revision=self.config.revision,
            permissions=(),
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = limit
        _ = cursor
        _ = force
        return ()
