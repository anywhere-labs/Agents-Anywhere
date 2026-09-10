from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol.errors import RuntimeUnsupportedError
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.instance_models import (
    RuntimeInstancePolicy,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.models import (
    RuntimeConfig,
    RuntimeConfigSchema,
)
from connector.runtime_protocol.protocol import AgentRuntime


class RuntimeProvider(ABC):
    """Connector -> Runtime provider lifecycle.

    Providers own discovery, configuration validation, and creation of runtime
    instances. A running AgentRuntime exposes its effective config as read-only.
    """

    @property
    def runtime(self) -> str:
        """Legacy provider key retained for Runtime Control 1.x callers."""

        return self.runtime_type

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
    def implementation_type(self) -> str | None:
        return None

    @property
    def recommended(self) -> bool:
        return False

    @property
    def recommendation_rank(self) -> int | None:
        return None

    @property
    def instance_policy(self) -> RuntimeInstancePolicy:
        return "single"

    @property
    def max_instances(self) -> int | None:
        return 1 if self.instance_policy == "single" else None

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
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        raise RuntimeUnsupportedError("create_runtime")

    async def stop_runtime(self, runtime: AgentRuntime) -> None:
        await runtime.stop()

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        return ()

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey | None:
        return None
