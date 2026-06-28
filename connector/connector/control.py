from __future__ import annotations

import asyncio
import shlex
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from connector.logging import logger
from connector.runtime import BackendRpcClient, ConnectorAuthenticationError, ConnectorConfig


ControlNotifier = Callable[[str, Any], Awaitable[None]]


class ConnectorController:
    def __init__(
        self,
        *,
        config_path: str | Path | None = None,
        notifier: ControlNotifier | None = None,
        client_factory: Callable[[ConnectorConfig], BackendRpcClient] = BackendRpcClient,
    ) -> None:
        self.config_path = Path(config_path) if config_path is not None else ConnectorConfig.default_path()
        self.notifier = notifier
        self.client_factory = client_factory
        self._runtime_task: asyncio.Task[None] | None = None
        self._pairing_task: asyncio.Task[None] | None = None
        self._last_error: str | None = None
        self._auth_failed = False

    def get_state(self) -> dict[str, Any]:
        return {
            "status": self._status(),
            "running": self._runtime_task is not None and not self._runtime_task.done(),
            "pairing": self._pairing_task is not None and not self._pairing_task.done(),
            "authFailed": self._auth_failed,
            "lastError": self._last_error,
            "configPath": str(self.config_path),
            "hasConfig": self.config_path.exists(),
        }

    def get_paths(self) -> dict[str, str]:
        return {
            "configPath": str(self.config_path),
            "configDir": str(self.config_path.parent),
        }

    def get_config(self) -> dict[str, Any]:
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

        config = config_from_params(params) if isinstance(params, dict) and params else ConnectorConfig.load(self.config_path)
        self._last_error = None
        self._auth_failed = False
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
        logger.info("stopped connector runtime")
        await self._emit_state()
        return self.get_state()

    async def restart(self, params: Any = None) -> dict[str, Any]:
        await self.stop()
        return await self.start(params)

    async def start_from_command(self, params: Any) -> dict[str, Any]:
        parsed = parse_connector_command(str_param(params, "command") or str_param(params, "input"))
        if parsed["kind"] == "pair":
            return await self.start_pairing({"server": parsed["server"]})
        config = parsed["config"]
        if bool_param(params, "save"):
            await self.save_config(config)
            return await self.start()
        return await self.start(config)

    async def start_pairing(self, params: Any) -> dict[str, Any]:
        if self._pairing_task is not None and not self._pairing_task.done():
            self._pairing_task.cancel()
        server = str_param(params, "server") or str_param(params, "serverUrl")
        server_url = await resolve_pair_server_url(server, timeout=float_param(params, "resolveTimeout", 10))
        timeout = float_param(params, "timeout", 600)
        poll_interval = float_param(params, "pollInterval", 2)
        self._pairing_task = asyncio.create_task(self._run_pairing(server_url, timeout=timeout, poll_interval=poll_interval))
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
            await self._emit_state()

    async def _run_pairing(self, server_url: str, *, timeout: float, poll_interval: float) -> None:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                start_response = await client.post(
                    f"{server_url}/pairing/start",
                    json={"serverUrl": server_url, "ttlSeconds": int(timeout)},
                )
                start_response.raise_for_status()
                pairing = start_response.json()
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
                    poll_response = await client.post(f"{server_url}/pairing/poll", json={"pairingId": pairing_id})
                    poll_response.raise_for_status()
                    payload = poll_response.json()
                    if payload["status"] == "claimed" and payload.get("config"):
                        config = ConnectorConfig.from_mapping(payload["config"])
                        config.save(self.config_path)
                        await self._emit_pairing({"status": "claimed", "config": config_to_payload(config)})
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


def default_config_payload() -> dict[str, Any]:
    return {
        "serverUrl": "",
        "connectorId": "",
        "connectorToken": "",
        "heartbeatSeconds": 20,
        "reconnectSeconds": 3,
        "syncExistingOnConnect": True,
        "syncIntervalSeconds": 30,
        "stateDbPath": None,
    }


def config_to_payload(config: ConnectorConfig) -> dict[str, Any]:
    return {
        "serverUrl": config.server_url,
        "connectorId": config.connector_id,
        "connectorToken": config.connector_token,
        "heartbeatSeconds": config.heartbeat_seconds,
        "reconnectSeconds": config.reconnect_seconds,
        "syncExistingOnConnect": config.sync_existing_on_connect,
        "syncIntervalSeconds": config.sync_interval_seconds,
        "stateDbPath": config.state_db_path,
    }


def config_from_params(params: Any) -> ConnectorConfig:
    if not isinstance(params, dict):
        raise ValueError("config params must be an object")
    server_url = str(params.get("serverUrl") or "").strip().rstrip("/")
    connector_id = str(params.get("connectorId") or "").strip()
    connector_token = str(params.get("connectorToken") or "").strip()
    if not server_url or not connector_id or not connector_token:
        raise ValueError("serverUrl, connectorId, and connectorToken are required")
    return ConnectorConfig(
        server_url=server_url,
        connector_id=connector_id,
        connector_token=connector_token,
        heartbeat_seconds=float(params.get("heartbeatSeconds", 20)),
        reconnect_seconds=float(params.get("reconnectSeconds", 3)),
        sync_existing_on_connect=bool(params.get("syncExistingOnConnect", True)),
        sync_interval_seconds=float(params.get("syncIntervalSeconds", 30)),
        state_db_path=params.get("stateDbPath") if isinstance(params.get("stateDbPath"), str) else None,
    )


def parse_connector_command(input_text: str | None) -> dict[str, Any]:
    text = str(input_text or "").strip()
    if not text:
        raise ValueError("command is required")
    parts = split_command(text)
    command_index = next((index for index, part in enumerate(parts) if part in {"start", "pair", "login"}), -1)
    if command_index < 0:
        return {"kind": "pair", "server": text}
    command = parts[command_index]

    def arg(name: str) -> str | None:
        try:
            index = parts.index(name)
        except ValueError:
            return None
        return parts[index + 1] if index + 1 < len(parts) else None

    if command == "start":
        return {
            "kind": "start",
            "config": {
                "serverUrl": (arg("--server-url") or "").rstrip("/"),
                "connectorId": arg("--connector-id"),
                "connectorToken": arg("--connector-token"),
            },
        }
    return {"kind": "pair", "server": arg("--server-url") or (parts[command_index + 1] if command_index + 1 < len(parts) else "")}


def split_command(text: str) -> list[str]:
    return shlex.split(text)


async def resolve_pair_server_url(value: str | None, *, timeout: float = 10) -> str:
    normalized = str(value or "").strip().rstrip("/")
    if not normalized:
        raise ValueError("server is required")
    if normalized.startswith(("http://", "https://")):
        return normalized
    candidates = [f"https://{normalized}", f"http://{normalized}"]
    errors: list[str] = []
    for candidate in candidates:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(f"{candidate}/health")
                if response.status_code < 500:
                    return candidate
                errors.append(f"{candidate}: HTTP {response.status_code}")
        except httpx.RequestError as exc:
            errors.append(f"{candidate}: {exc}")
    raise ValueError(f"could not reach server over https or http ({'; '.join(errors)})")


def str_param(params: Any, key: str) -> str | None:
    if not isinstance(params, dict):
        return None
    value = params.get(key)
    return value if isinstance(value, str) and value.strip() else None


def bool_param(params: Any, key: str) -> bool:
    return bool(isinstance(params, dict) and params.get(key))


def float_param(params: Any, key: str, default: float) -> float:
    if not isinstance(params, dict):
        return default
    try:
        return float(params.get(key, default))
    except (TypeError, ValueError):
        return default
