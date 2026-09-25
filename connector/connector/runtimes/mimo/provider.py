"""RuntimeProvider for MiMoCode / MiMo Desktop engine."""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from typing import Any, Mapping

from .db import default_mimocode_db
from .runtime import MimoAgentRuntime


class RuntimeUnsupportedError(Exception):
    def __init__(self, op: str):
        super().__init__(f"mimo runtime does not support {op}")
        self.op = op


class MimoRuntimeProvider:
    """Matches Agents Anywhere RuntimeProvider contract (protocol v1 draft).

    Connector may import this class directly; when the full ABC lands in
    connector.runtime_protocol, subclass it with the same methods.
    """

    @property
    def runtime(self) -> str:
        return "mimo"

    @property
    def runtime_type(self) -> str:
        return "mimo"

    @property
    def display_name(self) -> str:
        return "MiMo Code (MiMo Desktop)"

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

    async def discover(self):
        db = self._find_db()
        mimo_bin = self._find_mimo_bin()
        available = bool(db or mimo_bin)
        configured = bool(db)
        caps = {
            "modelCatalog": bool(mimo_bin),
            "permissionCatalog": False,
            "sessionState": True,
            "sessionNotices": False,
            "createAndStartSession": bool(mimo_bin),
            "startTurn": bool(mimo_bin),
            "steerTurn": False,
            "interruptTurn": bool(mimo_bin),
            "commands": False,
            "interactions": False,
            "attachments": False,
            "ipc": bool(mimo_bin),
            "historyRead": bool(db),
        }
        reason = None
        if not available:
            reason = "mimocode.db or mimo CLI not found (install @mimo-ai/cli / MiMo Desktop)"
        elif not configured:
            reason = "mimo CLI found but mimocode.db missing — history sync limited"
        # Lazy import to avoid hard dependency if connector stubs types
        try:
            from connector.runtime_protocol import RuntimeInventoryItem  # type: ignore

            return RuntimeInventoryItem(
                runtime=self.runtime,
                runtime_type=self.runtime_type,
                display_name=self.display_name,
                available=available,
                configured=configured,
                capabilities=caps,
                reason=reason,
                config_schema=await self.get_config_schema(),
                metadata={
                    "mimocode_db": str(db) if db else None,
                    "mimo_bin": mimo_bin,
                },
            )
        except Exception:
            # Standalone fallback for unit tests
            return {
                "runtime": self.runtime,
                "runtime_type": self.runtime_type,
                "display_name": self.display_name,
                "available": available,
                "configured": configured,
                "capabilities": caps,
                "reason": reason,
                "metadata": {
                    "mimocode_db": str(db) if db else None,
                    "mimo_bin": mimo_bin,
                },
            }

    async def get_config_schema(self):
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
        try:
            from connector.runtime_protocol import RuntimeConfigSchema  # type: ignore

            return RuntimeConfigSchema(
                runtime=self.runtime,
                revision=1,
                schema=schema,
                ui_schema=None,
                defaults={},
                metadata={"source": "mimo-provider"},
            )
        except Exception:
            return {
                "runtime": self.runtime,
                "revision": 1,
                "schema": schema,
                "defaults": {},
            }

    async def validate_config(self, values: Mapping[str, Any]):
        db = self._find_db(values)
        if values.get("mimocode_db") and not db:
            raise ValueError(f"mimocode.db not found: {values.get('mimocode_db')}")
        effective = {
            "mimocode_db": str(db) if db else None,
            "mimo_bin": values.get("mimo_bin") or self._find_mimo_bin(),
            "default_cwd": values.get("default_cwd") or os.getcwd(),
        }
        try:
            from connector.runtime_protocol import RuntimeConfig  # type: ignore

            return RuntimeConfig(
                runtime=self.runtime,
                revision=int(values.get("revision") or 1),
                values=effective,
                schema=None,
                ui_schema=None,
                metadata={},
            )
        except Exception:
            return {
                "runtime": self.runtime,
                "revision": 1,
                "values": effective,
            }

    async def create_runtime(self, config, host):
        values = getattr(config, "values", None) or (
            config.get("values") if isinstance(config, Mapping) else {}
        )
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
