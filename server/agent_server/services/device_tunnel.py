"""``WS /api/v3/tunnel`` <-> ``aa.device.v1.Secure/channel`` (E2EE mode, ``contracts/e2ee/1.0``).

The worker that holds the client's WebSocket opens one duplex ``Secure/channel``
per ``(deviceId, clientId, ch)`` route and forwards ``{n, ct}`` both ways
unchanged. It reads only the route and the counter; ``ct`` is opaque.

Frames on the WebSocket:

- ``{"t": "tun", "route": {deviceId, clientId, ch}, "n", "ct"}`` in both directions;
  the first one for a route opens the call.
- ``{"t": "end", "route", "code"}``: from the Server when the device ended the call
  (``code`` is its error code, ``closed`` when it simply returned) or is offline
  (``connector_offline``); from the client to cancel the call.

Nothing crosses workers: a client reconnecting on another worker reopens its channels.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from agent_server.core.device_meshcall import (
    LINK_ROUTES,
    SecureChannelItem,
    SecureChannelOpen,
)
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh

# Mirrors ``contracts/e2ee/1.0`` (F, #671) until that lands in this stack.
CLIENT_ID_PATTERN = re.compile(r"^cli_[a-z2-7]{26}$")
CHANNEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_CHANNELS_PER_SOCKET = 32
# One Noise transport message is at most 64 KiB; base64 adds a third.
MAX_CT_CHARS = 96 * 1024

Send = Callable[[dict[str, Any]], Awaitable[None]]


class TunnelFrameError(ValueError):
    """The client sent something that is not a tunnel frame; the socket is closed (1008)."""


@dataclass
class _Channel:
    route: dict[str, str]
    call: Any
    reader: asyncio.Task[None] | None = None
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _route_key(route: dict[str, str]) -> tuple[str, str, str]:
    return route["deviceId"], route["clientId"], route["ch"]


def parse_route(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise TunnelFrameError("route must be an object")
    device_id, client_id, ch = value.get("deviceId"), value.get("clientId"), value.get("ch")
    if not isinstance(device_id, str) or not device_id:
        raise TunnelFrameError("route.deviceId is required")
    if not isinstance(client_id, str) or not CLIENT_ID_PATTERN.fullmatch(client_id):
        raise TunnelFrameError("route.clientId is not a client id")
    if not isinstance(ch, str) or not CHANNEL_ID_PATTERN.fullmatch(ch):
        raise TunnelFrameError("route.ch is not a channel id")
    return {"deviceId": device_id, "clientId": client_id, "ch": ch}


class TunnelSession:
    """One client WebSocket's channels."""

    def __init__(
        self,
        *,
        user_id: str,
        store: Any,
        mesh: DeviceMesh,
        hub: DeviceLinkHub,
        send: Send,
        reach: Callable[[str], bool] | None = None,
    ) -> None:
        """``reach``: which devices this socket may open channels to besides the user's own check (a delegated
        Agent's scope); None allows every device of the user."""

        self._user_id = user_id
        self._reach = reach
        self._store = store
        self._mesh = mesh
        self._hub = hub
        self._send = send
        self._channels: dict[tuple[str, str, str], _Channel] = {}
        self._owned: dict[str, bool] = {}
        self._ws_lock = asyncio.Lock()

    async def _emit(self, frame: dict[str, Any]) -> None:
        async with self._ws_lock:
            await self._send(frame)

    async def _end(self, route: dict[str, str], code: str) -> None:
        with contextlib.suppress(Exception):
            await self._emit({"t": "end", "route": route, "code": code})

    async def _owns(self, device_id: str) -> bool:
        cached = self._owned.get(device_id)
        if cached is not None:
            return cached
        try:
            owned = (await self._store.get_connector(device_id)).userId == self._user_id
        except KeyError:
            owned = False
        if owned and self._reach is not None:
            owned = bool(self._reach(device_id))
        self._owned[device_id] = owned
        return owned

    async def handle(self, frame: Any) -> None:
        if not isinstance(frame, dict):
            raise TunnelFrameError("frames are JSON objects")
        kind = frame.get("t")
        route = parse_route(frame.get("route"))
        key = _route_key(route)
        if kind == "end":
            channel = self._channels.pop(key, None)
            if channel is not None:
                await self._close(channel, "client_closed")
            return
        if kind != "tun":
            raise TunnelFrameError("unknown frame type")
        n, ct = frame.get("n"), frame.get("ct")
        if not isinstance(n, int) or n < 0 or not isinstance(ct, str) or not ct or len(ct) > MAX_CT_CHARS:
            raise TunnelFrameError("tun frames carry n >= 0 and a base64 ct")
        channel = self._channels.get(key)
        if channel is None:
            channel = await self._open(route)
            if channel is None:
                return
        try:
            async with channel.send_lock:
                await channel.call.send(SecureChannelItem(n=n, ct=ct))
        except Exception as exc:  # noqa: BLE001 - the reader reports the call's end
            logger.info("tunnel send failed device_id={} error={!r}", route["deviceId"], exc)

    async def _open(self, route: dict[str, str]) -> _Channel | None:
        device_id = route["deviceId"]
        if not await self._owns(device_id):
            await self._end(route, "connector_offline")
            return None
        if len(self._channels) >= MAX_CHANNELS_PER_SOCKET:
            await self._end(route, "too_large")
            return None
        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            await self._end(route, "connector_offline")
            return None
        try:
            call = await self._mesh.duplex(
                device_id,
                LINK_ROUTES["secure.channel"],
                SecureChannelOpen(clientId=route["clientId"], ch=route["ch"]),
                SecureChannelItem,
                SecureChannelItem,
                connection_id=connection_id,
            )
        except Exception as exc:  # noqa: BLE001 - Router unreachable: the device is unreachable
            logger.info("tunnel open failed device_id={} error={!r}", device_id, exc)
            await self._end(route, "connector_offline")
            return None
        channel = _Channel(route=route, call=call)
        self._channels[_route_key(route)] = channel
        channel.reader = asyncio.create_task(self._read(channel), name=f"tunnel-{device_id}-{route['ch']}")
        return channel

    async def _read(self, channel: _Channel) -> None:
        code = "closed"
        try:
            async for item in channel.call:
                await self._emit({"t": "tun", "route": channel.route, "n": item.n, "ct": item.ct})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - every end is reported to the client
            classified = exc if isinstance(exc, DeviceCallError) else self._mesh.classify(exc)
            code = "connector_offline" if classified.not_delivered else (classified.code or "closed")
            details = getattr(exc, "details", None) or {}
            if isinstance(details, dict) and isinstance(details.get("aaCode"), str):
                code = details["aaCode"]
        if self._channels.get(_route_key(channel.route)) is channel:
            del self._channels[_route_key(channel.route)]
            await self._end(channel.route, code)

    async def _close(self, channel: _Channel, reason: str) -> None:
        with contextlib.suppress(Exception):
            await channel.call.cancel(reason)
        if channel.reader is not None and channel.reader is not asyncio.current_task():
            channel.reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await channel.reader

    async def close(self) -> None:
        channels, self._channels = list(self._channels.values()), {}
        for channel in channels:
            await self._close(channel, "client_closed")

    @property
    def open_channels(self) -> int:
        return len(self._channels)
