from __future__ import annotations

from typing import Any, Protocol


class RuntimeSerializer(Protocol):
    def serialize(self, *, settings: dict[str, Any], cwd: str | None = None) -> dict[str, Any]: ...


class RuntimeDriver(Protocol):
    runtime: str

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]: ...

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]: ...

    async def interrupt(self, params: dict[str, Any]) -> dict[str, Any]: ...
