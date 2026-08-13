from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol.errors import RuntimeUnsupportedError
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInstanceSpec,
    RuntimeResourceClaim,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.protocol import AgentRuntime


class RuntimeProvider(ABC):
    """Connector -> Runtime provider lifecycle.

    Providers own discovery, configuration validation, and creation of runtime
    instances. A running AgentRuntime exposes its effective config as read-only.
    """

    @property
    @abstractmethod
    def runtime_type(self) -> str:
        raise NotImplementedError

    @property
    @abstractmethod
    def display_name(self) -> str:
        raise NotImplementedError

    @property
    def description(self) -> str | None:
        return None

    @property
    def recommended(self) -> bool:
        return False

    @property
    def recommendation_rank(self) -> int | None:
        return None

    async def discover(self) -> RuntimeTypeDescriptor:
        raise RuntimeUnsupportedError("discover")

    async def get_config_schema(self) -> RuntimeConfigSchema:
        raise RuntimeUnsupportedError("get_config_schema")

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raise RuntimeUnsupportedError("validate_config")

    async def create_runtime(
        self,
        instance: RuntimeInstanceSpec,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        raise RuntimeUnsupportedError("create_runtime")

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        return ()

    def session_source_key(self, config: RuntimeConfig) -> str | None:
        return None

    async def stop_runtime(self, runtime: AgentRuntime) -> None:
        await runtime.stop()
