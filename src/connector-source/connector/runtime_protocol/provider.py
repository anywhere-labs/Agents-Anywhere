from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol.errors import RuntimeUnsupportedError
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInventoryItem,
)
from connector.runtime_protocol.protocol import AgentRuntime


class RuntimeProvider(ABC):
    """Connector -> Runtime provider lifecycle.

    Providers own discovery, configuration validation, and creation of runtime
    instances. A running AgentRuntime exposes its effective config as read-only.
    """

    @property
    @abstractmethod
    def runtime(self) -> str:
        raise NotImplementedError

    @property
    @abstractmethod
    def runtime_type(self) -> str:
        raise NotImplementedError

    @property
    @abstractmethod
    def display_name(self) -> str:
        raise NotImplementedError

    async def discover(self) -> RuntimeInventoryItem:
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
