from __future__ import annotations

from typing import Any

from agent_server.core.runtime_config import serialize_runtime_params
from agent_server.infra.runtimes.base import RuntimeSerializer


class ClaudeRuntimeSerializer:
    def serialize(self, *, settings: dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
        return serialize_runtime_params(runtime="claude", settings=settings, cwd=cwd)


class CodexRuntimeSerializer:
    def serialize(self, *, settings: dict[str, Any], cwd: str | None = None) -> dict[str, Any]:
        return serialize_runtime_params(runtime="codex", settings=settings, cwd=cwd)


def serializer_for_runtime(runtime: str) -> RuntimeSerializer:
    if runtime == "claude":
        return ClaudeRuntimeSerializer()
    if runtime == "codex":
        return CodexRuntimeSerializer()
    raise ValueError(f"unsupported runtime: {runtime}")
