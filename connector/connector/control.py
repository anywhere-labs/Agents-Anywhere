from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from connector.core.config import ConnectorConfig
from connector.core.control_config import (
    config_from_params,
    config_to_payload,
    default_config_payload,
    float_param,
    str_param,
)
from connector.core.runtime_owner import (
    ConnectorAlreadyRunningError,
    assert_can_start,
    clear_runtime,
    runtime_path,
    write_runtime,
)
from connector.logging import logger
from connector.server.auth import ConnectorAuthenticationError
from connector.server.client import BackendRpcClient
from connector.server.pairing import (
    poll_pairing,
    resolve_pair_server_url,
    start_pairing,
)

ControlNotifier = Callable[[str, Any], Awaitable[None]]


class ConnectorController:
    def __init__(
        self,
        *,
        config_path: str | Path | None = None,
        notifier: ControlNotifier | None = None,
        client_factory: Callable[
            [ConnectorConfig], BackendRpcClient
        ] = BackendRpcClient,
    ) -> None:
        self.config_path = (
            Path(config_path)
            if config_path is not None
            else ConnectorConfig.default_path()
        )
        self.notifier = notifier
        self.client_factory = client_factory
        self.runtime_path = runtime_path(self.config_path)
        self._runtime_task: asyncio.Task[None] | None = None
        self._pairing_task: asyncio.Task[None] | None = None
        self._last_error: str | None = None
        self._auth_failed = False

    def get_state(self, _params: Any = None) -> dict[str, Any]:
        return {
            "status": self._status(),
            "running": self._runtime_task is not None and not self._runtime_task.done(),
            "pairing": self._pairing_task is not None and not self._pairing_task.done(),
            "authFailed": self._auth_failed,
            "lastError": self._last_error,
            "configPath": str(self.config_path),
            "runtimePath": str(self.runtime_path),
            "hasConfig": self.config_path.exists(),
        }

    def get_paths(self, _params: Any = None) -> dict[str, str]:
        return {
            "configPath": str(self.config_path),
            "configDir": str(self.config_path.parent),
            "runtimePath": str(self.runtime_path),
        }

    def get_config(self, _params: Any = None) -> dict[str, Any]:
        if not self.config_path.exists():
            return default_config_payload()
        return config_to_payload(ConnectorConfig.load(self.config_path))

    async def save_config(self, params: Any) -> dict[str, Any]:
        config = config_from_params(params)
        saved_path = config.save(self.config_path)
        self._auth_failed = False
        self._last_error = None
        logger.info("saved connector config path={}", saved_path)
        await self._emit_state()
        return config_to_payload(config)

    async def start(self, params: Any = None) -> dict[str, Any]:
        if self._runtime_task is not None and not self._runtime_task.done():
            return self.get_state()

        config = (
            config_from_params(params)
            if isinstance(params, dict) and params
            else ConnectorConfig.load(self.config_path)
        )
        self._last_error = None
        self._auth_failed = False
        try:
            assert_can_start(self.runtime_path, config)
        except ConnectorAlreadyRunningError as exc:
            self._last_error = str(exc)
            await self._emit_state()
            raise
        write_runtime(self.runtime_path, config, kind="desktop")
        self._runtime_task = asyncio.create_task(self._run_runtime(config))
        logger.info("starting connector runtime")
        await self._emit_state()
        return self.get_state()

    async def stop(self, _params: Any = None) -> dict[str, Any]:
        if self._runtime_task is not None and not self._runtime_task.done():
            self._runtime_task.cancel()
            try:
                await self._runtime_task
            except asyncio.CancelledError:
                pass
        self._runtime_task = None
        clear_runtime(self.runtime_path)
        logger.info("stopped connector runtime")
        await self._emit_state()
        return self.get_state()

    async def restart(self, params: Any = None) -> dict[str, Any]:
        await self.stop()
        return await self.start(params)

    async def start_pairing(self, params: Any) -> dict[str, Any]:
        if self._pairing_task is not None and not self._pairing_task.done():
            self._pairing_task.cancel()
        server = str_param(params, "server") or str_param(params, "serverUrl")
        server_url = await resolve_pair_server_url(
            server, timeout=float_param(params, "resolveTimeout", 10)
        )
        timeout = float_param(params, "timeout", 600)
        poll_interval = float_param(params, "pollInterval", 2)
        self._pairing_task = asyncio.create_task(
            self._run_pairing(server_url, timeout=timeout, poll_interval=poll_interval)
        )
        payload = {"status": "starting", "serverUrl": server_url}
        await self._emit_pairing(payload)
        await self._emit_state()
        return payload

    async def cancel_pairing(self, _params: Any = None) -> dict[str, Any]:
        if self._pairing_task is not None and not self._pairing_task.done():
            self._pairing_task.cancel()
        self._pairing_task = None
        payload = {"status": "cancelled"}
        await self._emit_pairing(payload)
        await self._emit_state()
        return payload

    async def shutdown(self) -> None:
        if self._pairing_task is not None and not self._pairing_task.done():
            self._pairing_task.cancel()
        await self.stop()

    async def _run_runtime(self, config: ConnectorConfig) -> None:
        try:
            await self.client_factory(config).run_forever()
        except asyncio.CancelledError:
            raise
        except ConnectorAuthenticationError as exc:
            self._auth_failed = True
            self._last_error = str(exc)
            logger.error("connector authentication failed: {}", exc)
        except Exception as exc:
            self._last_error = str(exc) or exc.__class__.__name__
            logger.exception("connector runtime failed")
        finally:
            clear_runtime(self.runtime_path)
            if self._runtime_task is asyncio.current_task():
                self._runtime_task = None
            await self._emit_state()

    async def _run_pairing(
        self, server_url: str, *, timeout: float, poll_interval: float
    ) -> None:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                pairing = await start_pairing(client, server_url, timeout)
                pairing_id = pairing["pairingId"]
                code = pairing["code"]
                await self._emit_pairing(
                    {
                        "status": "waiting",
                        "serverUrl": server_url,
                        "pairingId": pairing_id,
                        "code": code,
                    }
                )

                deadline = asyncio.get_running_loop().time() + timeout
                while asyncio.get_running_loop().time() < deadline:
                    payload = await poll_pairing(client, server_url, str(pairing_id))
                    if payload["status"] == "claimed" and payload.get("config"):
                        config = ConnectorConfig.from_mapping(payload["config"])
                        config.save(self.config_path)
                        await self._emit_pairing(
                            {"status": "claimed", "config": config_to_payload(config)}
                        )
                        await self.start()
                        return
                    if payload["status"] in {"expired", "consumed"}:
                        await self._emit_pairing({"status": payload["status"]})
                        return
                    await asyncio.sleep(poll_interval)
            await self._emit_pairing({"status": "expired"})
        except asyncio.CancelledError:
            await self._emit_pairing({"status": "cancelled"})
            raise
        except Exception as exc:
            self._last_error = str(exc) or exc.__class__.__name__
            await self._emit_pairing({"status": "error", "error": self._last_error})
            await self._emit_state()

    def _status(self) -> str:
        if self._runtime_task is not None and not self._runtime_task.done():
            return "running"
        if self._auth_failed:
            return "expired credential"
        if self._last_error:
            return "error"
        return "stopped"

    async def _emit_state(self) -> None:
        await self._notify("connector/state", self.get_state())

    async def _emit_pairing(self, payload: dict[str, Any]) -> None:
        await self._notify("connector/pairing", payload)

    async def _notify(self, method: str, params: Any) -> None:
        if self.notifier is not None:
            await self.notifier(method, params)
