"""Connection-scoped remote control transport; no workspace business workflow."""

from __future__ import annotations

import asyncio
import math
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

import httpx
from meshcall import (
    query,
    service,
)
from pydantic import BaseModel

from connector.server.control_log import control_log, error_fields
from connector.server.mesh_lifecycle import ControlMeshServer, complete_cleanup
from connector.server.mesh_services import (
    ConnectorControlExecutor,
    bind_control_services,
)
from connector.server.urls import is_loopback_url

# Longest Server control wait is shell.exec (310s). Stop new work with margin
# even when candidate admission/status confirmation remains unavailable.
CONTROL_DRAIN_RESERVE_SECONDS = 320.0

class Empty(BaseModel):
    pass


class ConnectionInfo(BaseModel):
    protocolVersion: str = "1.0"


def bind_connection_service(name: str):
    @service(name, targeted=True)
    class ConnectionService:
        """Probe the current transport registration without invoking business work."""

        @query(description="Check this connection's transport registration.")
        async def ping(self) -> ConnectionInfo:
            return ConnectionInfo()

    return ConnectionService()


@dataclass(eq=False)
class _ControlLink:
    mesh: ControlMeshServer
    stack: AsyncExitStack
    info: dict = field(repr=False)
    expires_at: float
    refresh_at: float
    running: ControlMeshServer | None = field(default=None, repr=False)
    retire_requested: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    retirement: asyncio.Task | None = field(default=None, repr=False)
    retire_reason: str = 'route_replaced'
    retiring: bool = False
    cleanup: asyncio.Task | None = field(default=None, repr=False)


class RemoteConnectorControl:
    def __init__(self, backend) -> None:
        self.backend = backend
        self.executor = ConnectorControlExecutor(
            backend._dispatcher.dispatch, connector_id=getattr(backend.config, "connector_id", ""),
        )
        self._links: set[_ControlLink] = set()
        self._draining: set[asyncio.Task] = set()
        self._drain_reserve_seconds = CONTROL_DRAIN_RESERVE_SECONDS

    def _fields(self, link: _ControlLink | None = None) -> dict:
        return {"connectorId": self.executor.connector_id,
                **({"connectionId": link.info["connectionId"], "linkId": link.info["instanceId"]} if link else {})}

    async def run(self, request_session=None) -> None:
        serving = asyncio.create_task(self._serve(), name="connector-mesh-links")
        try:
            await asyncio.shield(serving)
        finally:
            await complete_cleanup(self._shutdown(serving))

    async def _shutdown(self, serving: asyncio.Task) -> None:
        # The base connection owner closes the shared executor before
        # cancelling this transport supervisor.
        serving.cancel()
        await asyncio.gather(serving, return_exceptions=True)
        retiring = tuple(self._draining)
        for link in tuple(self._links):
            link.retire_requested.set()
        if not self.executor.accepting:
            for task in retiring:
                task.cancel()
        await asyncio.gather(*retiring, return_exceptions=True)
        await asyncio.gather(*(self._close_link(link) for link in tuple(self._links)))

    async def _status(self, link: _ControlLink) -> bool:
        response = await self.backend._get_http_client().get(
            self.backend.config.server_url.rstrip("/") + "/api/v2/connector/mesh/status",
            headers={"Authorization": f"Bearer {link.info['token']}"}, timeout=5,
        )
        response.raise_for_status()
        return response.json().get("ready") is True

    async def _open_link(self) -> _ControlLink:
        async with asyncio.timeout(30):
            link = await self._admit_link()
        try:
            # A lost status response is not proof that publication failed. Keep
            # the candidate serving: requests may already be routed to it.
            while asyncio.get_running_loop().time() < link.expires_at:
                if getattr(link, "retiring", False) or link.running is None or not link.running.server.driver.connected:
                    raise ConnectionError("MeshCall registration connection closed")
                try:
                    if await self._status(link):
                        control_log("link.registered", **self._fields(link))
                        return link
                except httpx.HTTPError as error:
                    if self._authorization_rejected(error):
                        raise
                    control_log("link.status_unavailable", level="DEBUG", **self._fields(link),
                                phase="confirm_publication", **error_fields(error))
                await asyncio.sleep(1)
            raise TimeoutError("MeshCall credential expired before publication confirmation")
        except BaseException:
            await self._close_link(link)
            raise

    @staticmethod
    def _authorization_rejected(error: httpx.HTTPError) -> bool:
        return isinstance(error, httpx.HTTPStatusError) and error.response.status_code in {401, 403}

    async def _admit_link(self) -> _ControlLink:
        backend = self.backend
        generation = self.executor.generation
        self.executor.require_session(generation)
        # Start before the HTTP request: this is a conservative local estimate
        # of expiry, independent of clock skew and request/registration latency.
        started = asyncio.get_running_loop().time()
        token = await backend.ensure_access_token()
        response = await backend._get_http_client().post(
            backend.config.server_url.rstrip("/") + "/api/v2/connector/mesh/bootstrap",
            headers={"Authorization": f"Bearer {token}"},
            json={"connectionToken": backend._mesh_connection_token, "protocolVersion": "1.0"},
            timeout=15,
        )
        response.raise_for_status()
        info = response.json()
        self.executor.require_session(generation)
        if info["protocolVersion"] != "1.0" or info["connectorId"] != backend.config.connector_id:
            raise ValueError("MeshCall bootstrap identity mismatch")
        lifetime = float(info["expiresIn"])
        if not math.isfinite(lifetime) or lifetime <= 0:
            raise ValueError("Invalid MeshCall credential lifetime")
        parts = urlsplit(backend.config.server_url)
        if parts.scheme not in {"http", "https"}:
            raise ValueError("Unsupported Server URL")
        if parts.scheme == "http" and not is_loopback_url(backend.config.server_url):
            raise ValueError("Remote MeshCall connections require HTTPS/WSS")
        url = urlunsplit(("wss" if parts.scheme == "https" else "ws", parts.netloc, info["path"], "", ""))
        mesh = ControlMeshServer(url, info["token"], info["instanceId"], (
            bind_connection_service(info["services"]["Connection"]),
            *bind_control_services(info["services"], backend._dispatcher.dispatch, asyncio.get_running_loop(),
                                   executor=self.executor, generation=generation),
        ))
        link = _ControlLink(mesh, AsyncExitStack(), info, started + lifetime, started + lifetime / 2)
        self._links.add(link)
        try:
            link.stack.push_async_callback(mesh.close)
            link.running = await mesh.start()
            self.executor.require_session(generation)
            link.retirement = asyncio.create_task(self._retire_when_needed(link), name="connector-mesh-retirement")
            self._draining.add(link.retirement)
            link.retirement.add_done_callback(self._draining.discard)
            return link
        except BaseException:
            await self._close_link(link)
            raise

    async def _close_link(self, link: _ControlLink) -> bool:
        try:
            task = link.retirement
            if task is not None and task is not asyncio.current_task():
                if not link.retiring or not self.executor.accepting:
                    task.cancel()
                await asyncio.shield(asyncio.gather(task, return_exceptions=True))
            if link.cleanup is None:
                async def cleanup() -> None:
                    await link.stack.aclose()
                    self._links.discard(link)
                link.cleanup = asyncio.create_task(cleanup(), name="connector-mesh-link-close")
            await asyncio.shield(link.cleanup)
        except Exception as error:  # noqa: BLE001 - close the remaining links as well
            control_log("link.close_failed", level="WARNING", **self._fields(link), **error_fields(error))
            return False
        return True

    async def _retire_when_needed(self, link: _ControlLink) -> None:
        reason = "grant_expiring"
        try:
            async with asyncio.timeout(max(0, link.expires_at - asyncio.get_running_loop().time() - self._drain_reserve_seconds)):
                await link.retire_requested.wait()
            reason = link.retire_reason
        except TimeoutError:
            pass
        link.retiring = True
        await self._retire(link, reason=reason)

    async def _retire(self, link: _ControlLink, *, reason: str = "route_replaced") -> None:
        started = asyncio.get_running_loop().time()
        # Rotate halfway through the lifetime, leaving ~450 seconds with the
        # normal grant. Preserve the old authorization while draining, but never
        # extend it. Leave margin for the Router token's integer-second expiry.
        lifetime_left = link.expires_at - started
        remaining = max(0.0, lifetime_left - min(5.0, max(1.0, lifetime_left / 10)))
        control_log("link.draining", **self._fields(link), reason=reason)
        try:
            await link.mesh.drain(timeout=remaining)
        except Exception as error:  # noqa: BLE001 - retirement never replays business work
            control_log("link.drain_failed", level="WARNING", **self._fields(link), **error_fields(error))
        finally:
            if await self._close_link(link):
                control_log("link.drained", **self._fields(link), elapsedMs=(asyncio.get_running_loop().time() - started) * 1000)

    async def _serve(self) -> None:
        current = None
        while self.executor.accepting:
            if current is None or asyncio.get_running_loop().time() >= current.refresh_at:
                try:
                    if current is not None:
                        control_log("link.refresh", **self._fields(current), reason="credential_refresh")
                    candidate = await self._open_link()
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - retain the current link while retrying admission
                    control_log("link.retry", level="WARNING", **self._fields(current),
                                phase="bootstrap_or_registration", **error_fields(error))
                    await asyncio.sleep(3)
                    continue
                previous, current = current, candidate
                if previous is not None:
                    previous.retire_requested.set()
            try:
                await asyncio.sleep(min(5, max(0, current.refresh_at - asyncio.get_running_loop().time())))
                if not await self._status(current):
                    control_log("link.reconnecting", level="WARNING", **self._fields(current), reason="registration_lost")
                    # A route is only an address for new work. Losing it does
                    # not revoke the authorization of admitted requests.
                    current.retire_reason = 'registration_lost'
                    current.retire_requested.set()
                    current = None
            except asyncio.CancelledError:
                raise
            except httpx.HTTPError as error:
                control_log("link.status_unavailable", level="WARNING", **self._fields(current),
                            phase="monitor_registration", **error_fields(error))
                if self._authorization_rejected(error):
                    await self._close_link(current)
                    current = None
            except Exception as error:  # noqa: BLE001 - replace an unconfirmed registration without cutting admitted work
                control_log("link.retry", level="WARNING", **self._fields(current),
                            phase="monitor_registration", **error_fields(error))
                current.retire_reason = 'registration_unconfirmed'
                current.retire_requested.set()
                current = None
                await asyncio.sleep(3)
