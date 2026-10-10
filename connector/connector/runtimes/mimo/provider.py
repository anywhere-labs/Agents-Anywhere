"""RuntimeProvider for MiMoCode / MiMo Desktop engine (Agents Anywhere v2)."""

from __future__ import annotations

import os
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.mimo.db import default_mimocode_db
from connector.runtimes.mimo.runtime import MimoAgentRuntime

CONFIG_SCHEMA_REVISION = 1


class MimoRuntimeProvider(RuntimeProvider):
    @property
    def runtime_type(self) -> str:
        return "mimo"

    @property
    def runtime(self) -> str:
        return self.runtime_type

    @property
    def display_name(self) -> str:
        return "MiMo Code (MiMo Desktop)"

    @property
    def description(self) -> str | None:
        return "Xiaomi MiMoCode agent engine (MiMo Desktop / OpenCode fork)"

    @property
    def implementation_type(self) -> str | None:
        return "mimocode"

    @property
    def instance_policy(self):
        return "single"

    @property
    def max_instances(self) -> int:
        return 1

    def _find_mimo_bin(self) -> str | None:
        env = os.environ.get("MIMO_BIN")
        if env and Path(env).is_file():
            return env
        return shutil.which("mimo")

    def _find_db(self, values: Mapping[str, Any] | None = None) -> Path | None:
        if values and values.get("mimocode_db"):
            p = Path(str(values["mimocode_db"]))
            return p if p.is_file() else None
        return default_mimocode_db()

    def _capabilities(self, has_db: bool, has_bin: bool) -> dict[str, bool]:
        return {
            "modelCatalog": has_bin,
            "permissionCatalog": False,
            "sessionState": True,
            "sessionNotices": False,
            "createAndStartSession": has_bin,
            "startTurn": has_bin,
            "steerTurn": False,
            "interruptTurn": has_bin,
            "commands": False,
            "interactions": False,
            "attachments": False,
            "ipc": has_bin,
            "historyRead": has_db,
        }

    async def discover(self) -> RuntimeTypeDescriptor:
        db = self._find_db()
        mimo_bin = self._find_mimo_bin()
        available = bool(db or mimo_bin)
        reason = None
        if not available:
            reason = (
                "mimocode.db or mimo CLI not found — install MiMo Desktop "
                "or npm i -g @mimo-ai/cli"
            )
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=available,
            description=self.description,
            implementation_type=self.implementation_type,
            capabilities=self._capabilities(bool(db), bool(mimo_bin)),
            reason=reason,
            config_schema=await self.get_config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            metadata={
                "mimocode_db": str(db) if db else None,
                "mimo_bin": mimo_bin,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = {
            "type": "object",
            "properties": {
                "mimocode_db": {
                    "type": "string",
                    "title": "MiMoCode database path",
                    "description": "Path to mimocode.db (default: auto-detect)",
                },
                "mimo_bin": {
                    "type": "string",
                    "title": "mimo executable",
                    "description": "Path to mimo CLI (default: PATH / MIMO_BIN)",
                },
                "default_cwd": {
                    "type": "string",
                    "title": "Default workspace",
                    "description": "cwd for new sessions if not provided",
                },
            },
        }
        return RuntimeConfigSchema(
            runtime=self.runtime_type,
            revision=CONFIG_SCHEMA_REVISION,
            schema=schema,
            defaults={},
            metadata={"source": "mimo-provider"},
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        db = self._find_db(values)
        if values.get("mimocode_db") and not db:
            raise ValueError(f"mimocode.db not found: {values.get('mimocode_db')}")
        effective = {
            "mimocode_db": str(db) if db else None,
            "mimo_bin": values.get("mimo_bin") or self._find_mimo_bin(),
            "default_cwd": values.get("default_cwd") or os.getcwd(),
        }
        return RuntimeConfig(
            runtime=self.runtime_type,
            revision=int(values.get("revision") or CONFIG_SCHEMA_REVISION),
            values=effective,
        )

    async def create_runtime(self, config: RuntimeConfig, host: RuntimeHostClient) -> MimoAgentRuntime:
        values = config.values or {}
        db_path = values.get("mimocode_db") or default_mimocode_db()
        mimo_bin = values.get("mimo_bin") or self._find_mimo_bin()
        cwd = values.get("default_cwd") or os.getcwd()
        return MimoAgentRuntime(
            db_path=Path(db_path) if db_path else None,
            mimo_bin=mimo_bin,
            default_cwd=cwd,
            host=host,
        )

    async def stop_runtime(self, runtime) -> None:
        await runtime.stop()

    def resource_claims(self, config: RuntimeConfig) -> tuple[RuntimeResourceClaim, ...]:
        """MimoCode owns one local SQLite history + one mimo process family."""
        db = config.values.get("mimocode_db") if config.values else None
        key = str(db) if db else "mimocode-db"
        return (
            RuntimeResourceClaim(
                kind="sqlite",
                key=key,
                label="MiMoCode session database",
                mode="exclusive",
            ),
            RuntimeResourceClaim(
                kind="process",
                key="mimo-cli",
                label="mimo CLI process family",
                mode="exclusive",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey | None:
        db = config.values.get("mimocode_db") if config.values else None
        # stable path-derived source identity, no tokens/pids
        digest = __import__("hashlib").sha256(str(db or "default").encode("utf-8")).hexdigest()[:16]
        return RuntimeSourceKey(kind="mimocode-db", key=digest)
