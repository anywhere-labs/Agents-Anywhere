from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
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
    RuntimeLease,
    runtime_path,
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


class ConnectorBusyError(RuntimeError):
    """A lifecycle command cannot be accepted while another change is in flight."""


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
        self.lease = RuntimeLease(self.runtime_path, kind=os.environ.get("AA_CONNECTOR_OWNER_KIND", "cli"),
                                  legacy_paths=[self.config_path.with_name("connector-runtime.json")])
        self._runtime_task: asyncio.Task[None] | None = None
        self._pairing_task: asyncio.Task[None] | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._closing = False
        self._pairing_generation = 0
        self._pairing_ready: asyncio.Future[dict[str, Any]] | None = None
        self._pairing_tasks: set[asyncio.Task[None]] = set()
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

    def acquire_ownership(self, _params: Any = None) -> dict[str, Any]:
        """Reserve this Connector before provisioning; conflicts remain RPC errors."""
        self._ensure_open()
        self.lease.claim()
        return self.get_state()

    def get_config(self, _params: Any = None) -> dict[str, Any]:
        if not self.config_path.exists():
            return default_config_payload()
        return config_to_payload(ConnectorConfig.load(self.config_path))

    async def save_config(self, params: Any) -> dict[str, Any]:
        async with self._lifecycle_change():
            self.lease.claim()
            config = config_from_params(params)
            saved_path = config.save(self.config_path)
            self._auth_failed = False
            self._last_error = None
            logger.info("saved connector config path={}", saved_path)
            await self._emit_state()
            return config_to_payload(config)

    async def start(self, params: Any = None) -> dict[str, Any]:
        async with self._lifecycle_change():
            return await self._start_runtime(params)

    @asynccontextmanager
    async def _lifecycle_change(self) -> AsyncIterator[None]:
        self._ensure_open()
        task = self._runtime_task
        if self._lifecycle_lock.locked() or (task is not None and not task.done() and task.cancelling()):
            raise ConnectorBusyError("The Connector is changing state; check its state before issuing another command")
        # All controller work runs on one event loop. There is no suspension
        # between the busy check and acquiring the uncontended lock.
        async with self._lifecycle_lock:
            yield

    async def _start_runtime(self, params: Any = None) -> dict[str, Any]:
        """Start while holding the lifecycle lock; also used by restart and pairing."""
        if self._runtime_task is not None and not self._runtime_task.done():
            if not self._runtime_task.cancelling():
                return self.get_state()
            await self._stop_runtime()
            self._ensure_open()

        config = (
            config_from_params(params)
            if isinstance(params, dict) and params
            else ConnectorConfig.load(self.config_path)
        )
        self._last_error = None
        self._auth_failed = False
        try:
            self.lease.claim(config)
        except ConnectorAlreadyRunningError as exc:
            self._last_error = str(exc)
            await self._emit_state()
            raise
        self._runtime_task = asyncio.create_task(self._run_runtime(config))
        logger.info("starting connector runtime")
        await self._emit_state()
        return self.get_state()

    async def stop(self, _params: Any = None) -> dict[str, Any]:
        async with self._lifecycle_change():
            return await self._stop_runtime()

    async def _stop_runtime(self) -> dict[str, Any]:
        task = self._runtime_task
        if task is not None and not task.done():
            if not task.cancelling():
                task.cancel()
            try:
                # A cancelled RPC must not cancel backend cleanup a second time.
                await asyncio.shield(task)
            except asyncio.CancelledError:
                if not task.done() or asyncio.current_task().cancelling():
                    raise
        if self._runtime_task is task:
            self._runtime_task = None
        logger.info("stopped connector runtime")
        await self._emit_state()
        return self.get_state()

    async def restart(self, params: Any = None) -> dict[str, Any]:
        async with self._lifecycle_change():
            await self._stop_runtime()
            self._ensure_open()
            return await self._start_runtime(params)

    async def start_pairing(self, params: Any) -> dict[str, Any]:
        self._ensure_open()
        self.lease.claim()
        self._cancel_pairing_tasks()
        generation = self._pairing_generation
        ready = asyncio.get_running_loop().create_future()
        task = asyncio.create_task(
            self._begin_pairing(params, generation, ready), name="connector-pairing",
        )
        self._pairing_task = task
        self._pairing_ready = ready
        self._pairing_tasks.add(task)
        task.add_done_callback(self._pairing_tasks.discard)
        try:
            return await ready
        except asyncio.CancelledError:
            if self._pairing_task is task:
                self._cancel_pairing_tasks()
                await self._emit_state()
            raise

    async def _begin_pairing(
        self, params: Any, generation: int, ready: asyncio.Future[dict[str, Any]],
    ) -> None:
        try:
            server = str_param(params, "server") or str_param(params, "serverUrl")
            server_url = await resolve_pair_server_url(
                server, timeout=float_param(params, "resolveTimeout", 10),
            )
            if not self._pairing_current(generation):
                return
            timeout = float_param(params, "timeout", 600)
            poll_interval = float_param(params, "pollInterval", 2)
            payload = {"status": "starting", "serverUrl": server_url}
            await self._emit_pairing(payload)
            await self._emit_state()
            if not ready.done():
                ready.set_result(payload)
            if self._pairing_current(generation):
                await self._run_pairing(server_url, timeout=timeout, poll_interval=poll_interval, generation=generation)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - forward resolver failures to the waiting RPC.
            if not ready.done():
                ready.set_exception(exc)
        finally:
            if not ready.done():
                ready.set_result({"status": "cancelled"})
            if self._pairing_task is asyncio.current_task():
                self._pairing_task = None
                self._pairing_ready = None
                await self._emit_state()

    def _pairing_current(self, generation: int) -> bool:
        return not self._closing and generation == self._pairing_generation

    def _cancel_pairing_tasks(self) -> None:
        self._pairing_generation += 1
        self._pairing_task = None
        ready, self._pairing_ready = self._pairing_ready, None
        if ready is not None and not ready.done():
            ready.set_result({"status": "cancelled"})
        for task in self._pairing_tasks:
            if not task.done() and not task.cancelling():
                task.cancel()

    async def cancel_pairing(self, _params: Any = None) -> dict[str, Any]:
        self._cancel_pairing_tasks()
        payload = {"status": "cancelled"}
        await self._emit_pairing(payload)
        await self._emit_state()
        return payload

    async def shutdown(self) -> None:
        self._closing = True
        self._cancel_pairing_tasks()
        await asyncio.gather(*self._pairing_tasks, return_exceptions=True)
        async with self._lifecycle_lock:
            try:
                await self._stop_runtime()
            finally:
                self.lease.release()

    def _ensure_open(self) -> None:
        if self._closing:
            raise RuntimeError("The Connector is shutting down")

    async def _run_runtime(self, config: ConnectorConfig) -> None:
        try:
            await self.client_factory(config).run_forever()
        except asyncio.CancelledError:
            raise
        except ConnectorAuthenticationError as exc:
            self._auth_failed = True
            self._last_error = str(exc)
            logger.error("connector authentication failed: {}", exc)
        except Exception as exc:  # noqa: BLE001 - runtime errors become controller state.
            self._last_error = str(exc) or exc.__class__.__name__
            logger.exception("connector runtime failed")
        finally:
            if self._runtime_task is asyncio.current_task():
                self._runtime_task = None
            await self._emit_state()

    async def _run_pairing(
        self, server_url: str, *, timeout: float, poll_interval: float, generation: int,
    ) -> None:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                pairing = await start_pairing(client, server_url, timeout)
                if not self._pairing_current(generation):
                    return
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
                    if not self._pairing_current(generation):
                        return
                    if payload["status"] == "claimed" and payload.get("config"):
                        config = ConnectorConfig.from_mapping(payload["config"])
                        async with self._lifecycle_lock:
                            if not self._pairing_current(generation):
                                return
                            config.save(self.config_path)
                            await self._start_runtime()
                        if self._pairing_current(generation):
                            await self._emit_pairing(
                                {"status": "claimed", "config": config_to_payload(config)}
                            )
                        return
                    if payload["status"] in {"expired", "consumed"}:
                        await self._emit_pairing({"status": payload["status"]})
                        return
                    await asyncio.sleep(poll_interval)
            if self._pairing_current(generation):
                await self._emit_pairing({"status": "expired"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - pairing errors become controller state.
            if self._pairing_current(generation):
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
