"""Port preview control plane (``contracts/preview/1.0``; data plane is frp).

The Server owns the ``Preview`` aggregate: who may preview which device port, the slug
(the DNS label under the separately registered preview domain), expiry and closing. It
asks the device to add or remove the frpc proxy (``preview.open`` / ``preview.close``),
answers frps's plugin calls (``Login``, ``NewProxy``, ``CloseProxy``) and redeems the
one-time tickets preview-auth exchanges for its cookie. The page itself never passes
through the Server.

Previews close when the user stops them, when they expire, when the port stops
listening (``port.closed``) and when the device has been offline for ten minutes.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from loguru import logger

from agent_server.core.e2ee_settings import E2eeSettings
from agent_server.core.preview import (
    COOKIE_TTL_HOURS,
    DEFAULT_TTL_HOURS,
    MAX_OPEN_PREVIEWS_PER_DEVICE,
    TICKET_TTL_SECONDS,
    CreatePreviewRequest,
    PreviewCloseCommand,
    PreviewOpenCommand,
    PreviewTicketResponse,
    PreviewView,
)
from agent_server.core.preview_access import (
    COOKIE,
    FRP_TOKEN,
    TICKET_PATH,
    frps_addr,
    internal_token,
    preview_domain,
    sign,
    verify,
)
from agent_server.infra.preview_state import PreviewStateStore
from agent_server.services.device_commands import (
    DeviceCommandError,
    DeviceCommandOffline,
    DeviceCommandOutcomeUnknown,
    DeviceCommandService,
)

OFFLINE_GRACE_SECONDS = 600
SWEEP_INTERVAL_SECONDS = 30
OPEN_STATES = ("opening", "open")

Publish = Callable[[str, dict[str, Any]], Awaitable[None]]
IsOnline = Callable[[str], Awaitable[bool]]


class PreviewError(Exception):
    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


class PreviewService:
    def __init__(
        self,
        store: Any,
        state: PreviewStateStore,
        commands: DeviceCommandService,
        publish: Publish,
        is_online: IsOnline,
        *,
        clock: Callable[[], float] = time.time,
        e2ee_settings: Callable[[], E2eeSettings] = E2eeSettings,
    ) -> None:
        self._e2ee_settings = e2ee_settings
        self._store = store
        self._state = state
        self._commands = commands
        self._publish = publish
        self._is_online = is_online
        self._clock = clock
        self._offline_since: dict[str, float] = {}

    # -- configuration --------------------------------------------------------------

    def _require_enabled(self) -> tuple[str, str]:
        domain, token = preview_domain(), internal_token()
        if domain is None or token is None:
            raise PreviewError(404, "preview_domain_not_configured", "this server has no preview domain configured")
        settings = self._e2ee_settings()
        if settings.required and settings.preview == "deny":
            raise PreviewError(404, "preview_disabled", "port preview is turned off on this server")
        return domain, token

    def view(self, row: dict[str, Any]) -> PreviewView:
        domain = preview_domain()
        return PreviewView(
            previewId=row["previewId"],
            slug=row["slug"],
            deviceId=row["deviceId"],
            sessionId=row["sessionId"],
            port=row["port"],
            visibility=row["visibility"],
            state=row["state"],
            closeReason=row["closeReason"],
            url=f"https://{row['slug']}.{domain}" if domain and row["state"] != "closed" else None,
            expiresAt=row["expiresAt"],
            plaintextNotice=self._e2ee_settings().required,
        )

    # -- client API -------------------------------------------------------------------

    async def create(self, user_id: str, request: CreatePreviewRequest) -> PreviewView:
        _domain, token = self._require_enabled()
        try:
            device = await self._store.get_connector(request.deviceId)
        except KeyError:
            raise PreviewError(404, "device_not_found", "device not found") from None
        if device.userId != user_id:
            raise PreviewError(404, "device_not_found", "device not found")
        if await self._store.connector_link_contract(request.deviceId) is None:
            raise PreviewError(409, "device_upgrade_required", "port preview needs Agents Anywhere 3 on the device")
        if request.sessionId is not None:
            try:
                session = await self._store.get_session(request.sessionId, user_id=user_id)
            except KeyError:
                raise PreviewError(404, "session_not_found", "session not found") from None
            if session.connectorId != request.deviceId:
                raise PreviewError(404, "session_not_found", "session not found")
        others = await self._store.count_open_device_previews(request.deviceId, excluding_port=request.port)
        if others >= MAX_OPEN_PREVIEWS_PER_DEVICE:
            raise PreviewError(
                409, "preview_limit_reached", "this device has reached the limit of open previews",
                limit=MAX_OPEN_PREVIEWS_PER_DEVICE,
            )
        expires = self._clock() + (request.ttlHours or DEFAULT_TTL_HOURS) * 3600
        row = await self._store.open_preview_row(
            user_id=user_id,
            device_id=request.deviceId,
            port=request.port,
            session_id=request.sessionId,
            visibility=request.visibility,
            expires_at=_iso(expires),
        )
        frp_token = sign(token, FRP_TOKEN, {"d": row["deviceId"], "p": row["previewId"], "s": row["slug"], "exp": int(expires)})
        command = PreviewOpenCommand(
            previewId=row["previewId"],
            slug=row["slug"],
            port=row["port"],
            frpsAddr=frps_addr() or "",
            frpToken=frp_token,
            tokenExpiresAt=row["expiresAt"],
        )
        try:
            await self._commands.send(
                user_id=user_id,
                device_id=row["deviceId"],
                kind="preview.open",
                command_id=f"pvo_{row['previewId']}_{secrets.token_hex(6)}",
                payload=command.model_dump(mode="json"),
            )
        except DeviceCommandOutcomeUnknown as exc:
            # Stays ``opening``: frps's NewProxy call opens it if the device did add the proxy.
            raise PreviewError(504, exc.code, exc.message, previewId=row["previewId"]) from exc
        except DeviceCommandError as exc:
            reason = "device_offline" if isinstance(exc, DeviceCommandOffline) else None
            await self._store.set_preview_state(row["previewId"], "closed", reason=reason)
            raise PreviewError(exc.status, exc.code, exc.message, previewId=row["previewId"]) from exc
        opened = await self._mark_open(row)
        return self.view(opened)

    async def list_for_user(self, user_id: str) -> list[PreviewView]:
        now = self._clock()
        views: list[PreviewView] = []
        for row in await self._store.list_user_previews(user_id):
            if _epoch(row["expiresAt"]) <= now:
                await self._close(row, "expired")
                continue
            views.append(self.view(row))
        return views

    async def close(self, user_id: str, preview_id: str) -> PreviewView:
        try:
            row = await self._store.get_preview(preview_id, user_id=user_id)
        except KeyError:
            raise PreviewError(404, "preview_not_found", "preview not found") from None
        closed = await self._close(row, "user_closed")
        return self.view(closed or row)

    async def ticket(self, user_id: str, preview_id: str) -> PreviewTicketResponse:
        domain, _token = self._require_enabled()
        try:
            row = await self._store.get_preview(preview_id, user_id=user_id)
        except KeyError:
            raise PreviewError(404, "preview_not_found", "preview not found") from None
        if row["state"] not in OPEN_STATES:
            raise PreviewError(404, "preview_not_found", "the preview is closed")
        if _epoch(row["expiresAt"]) <= self._clock():
            await self._close(row, "expired")
            raise PreviewError(404, "preview_not_found", "the preview has expired")
        ticket = await self._state.issue_ticket(
            {"p": row["previewId"], "u": user_id, "s": row["slug"]}, ttl_seconds=TICKET_TTL_SECONDS
        )
        return PreviewTicketResponse(
            ticketUrl=f"https://{row['slug']}.{domain}{TICKET_PATH}?t={ticket}",
            expiresAt=_iso(self._clock() + TICKET_TTL_SECONDS),
        )

    # -- preview-auth -----------------------------------------------------------------

    async def redeem(self, ticket: str, slug: str) -> dict[str, Any]:
        """Exchange a one-time ticket for the signed preview cookie."""

        _domain, token = self._require_enabled()
        claims = await self._state.redeem_ticket(ticket)
        if claims is None or claims.get("s") != slug:
            raise PreviewError(403, "preview_ticket_invalid", "the ticket is unknown, used, expired or for another preview")
        row = await self._store.get_preview_by_slug(slug)
        now = self._clock()
        if (
            row is None
            or row["previewId"] != claims.get("p")
            or row["userId"] != claims.get("u")
            or row["state"] not in OPEN_STATES
            or _epoch(row["expiresAt"]) <= now
        ):
            raise PreviewError(403, "preview_ticket_invalid", "the preview is closed")
        expires = min(now + COOKIE_TTL_HOURS * 3600, _epoch(row["expiresAt"]))
        cookie = sign(token, COOKIE, {"s": slug, "u": row["userId"], "p": row["previewId"], "exp": int(expires)})
        return {
            "previewId": row["previewId"],
            "userId": row["userId"],
            "slug": slug,
            "cookie": cookie,
            "maxAge": max(int(expires - now), 1),
        }

    # -- frps server plugin -----------------------------------------------------------

    async def frps_plugin(self, op: str, content: dict[str, Any]) -> dict[str, Any]:
        """frp server plugin protocol: ``{"reject": bool, "reject_reason"?, "unchange": true}``."""

        token = internal_token()
        if token is None:
            return _reject("port preview is not configured")
        if op == "Login":
            claims = verify(token, FRP_TOKEN, _metas(content).get("token"))
            if claims is None or not await self._device_active(claims.get("d")):
                return _reject("invalid preview token")
            return _allow()
        if op == "NewProxy":
            return await self._new_proxy(token, content)
        # CloseProxy and anything else frps reports: nothing to decide. A proxy that went away
        # with frpc's connection comes back when frpc reconnects; previews close through the
        # device, the user, expiry or the offline grace period.
        return _allow()

    async def _new_proxy(self, token: str, content: dict[str, Any]) -> dict[str, Any]:
        user = content.get("user") if isinstance(content.get("user"), dict) else {}
        login = verify(token, FRP_TOKEN, _metas(user).get("token"))
        metas = _metas(content)
        claims = verify(token, FRP_TOKEN, metas.get("previewToken"))
        if login is None or claims is None or login.get("d") != claims.get("d"):
            return _reject("invalid preview token")
        slug = content.get("subdomain")
        if (
            content.get("proxy_type") != "http"
            or content.get("custom_domains")
            or slug != claims.get("s")
            or metas.get("previewId", claims.get("p")) != claims.get("p")
        ):
            return _reject("the proxy does not match its preview")
        row = await self._store.get_preview_by_slug(str(slug))
        if (
            row is None
            or row["previewId"] != claims.get("p")
            or row["deviceId"] != claims.get("d")
            or row["state"] not in OPEN_STATES
            or _epoch(row["expiresAt"]) <= self._clock()
        ):
            return _reject("the preview is closed")
        if row["state"] == "opening":
            await self._mark_open(row)
        return _allow()

    async def _device_active(self, device_id: Any) -> bool:
        if not isinstance(device_id, str):
            return False
        try:
            await self._store.get_connector(device_id)
        except KeyError:
            return False
        return True

    # -- device events ----------------------------------------------------------------

    async def on_device_event(self, device_id: str, method: str, payload: dict[str, Any]) -> None:
        if method == "port.listening":
            ports = [port for port in payload.get("ports") or [] if isinstance(port, dict) and isinstance(port.get("port"), int)]
            before = await self._state.ports(device_id)
            await self._state.set_ports(device_id, ports)
            sessions = {p.get("sessionId") for p in before} | {p.get("sessionId") for p in ports}
            for session_id in sorted(s for s in sessions if isinstance(s, str) and s):
                await self._publish_port_event(
                    session_id,
                    "port.listening",
                    {"deviceId": device_id, "ports": [p for p in ports if p.get("sessionId") == session_id]},
                )
        elif method == "port.closed" and isinstance(payload.get("port"), int):
            port = payload["port"]
            before = await self._state.ports(device_id)
            await self._state.set_ports(device_id, [p for p in before if p.get("port") != port])
            for session_id in sorted({p.get("sessionId") for p in before if p.get("port") == port and p.get("sessionId")}):
                await self._publish_port_event(session_id, "port.closed", {"deviceId": device_id, "port": port})
            for row in await self._store.open_device_previews(device_id, port=port):
                await self._close(row, "port_closed", notify_device=False)

    async def on_presence(self, device_id: str, online: bool) -> None:
        if online:
            self._offline_since.pop(device_id, None)
            return
        self._offline_since.setdefault(device_id, self._clock())
        before = await self._state.ports(device_id)
        await self._state.drop_ports(device_id)
        for session_id in sorted({p.get("sessionId") for p in before if p.get("sessionId")}):
            await self._publish_port_event(session_id, "port.listening", {"deviceId": device_id, "ports": []})

    async def session_ports(self, device_id: str, session_id: str) -> list[dict[str, Any]]:
        return [p for p in await self._state.ports(device_id) if p.get("sessionId") == session_id]

    async def _publish_port_event(self, session_id: str, event_type: str, payload: dict[str, Any]) -> None:
        await self._publish(session_id, {"sessionId": session_id, "portEvent": {"type": event_type, "payload": payload}})

    # -- lifecycle ----------------------------------------------------------------------

    async def _mark_open(self, row: dict[str, Any]) -> dict[str, Any]:
        opened = await self._store.set_preview_state(row["previewId"], "open", only_from=("opening",)) or row
        if opened["state"] in OPEN_STATES:
            await self._state.publish_slug(
                opened["slug"],
                {
                    "previewId": opened["previewId"],
                    "userId": opened["userId"],
                    "visibility": opened["visibility"],
                    "exp": int(_epoch(opened["expiresAt"])),
                },
                ttl_seconds=_epoch(opened["expiresAt"]) - self._clock(),
            )
        return opened

    async def _close(self, row: dict[str, Any], reason: str, *, notify_device: bool = True) -> dict[str, Any] | None:
        closed = await self._store.set_preview_state(row["previewId"], "closed", reason=reason)
        await self._state.drop_slug(row["slug"])
        if closed is None or not notify_device:
            return closed
        try:
            await self._commands.send(
                user_id=row["userId"],
                device_id=row["deviceId"],
                kind="preview.close",
                command_id=f"pvc_{row['previewId']}_{secrets.token_hex(6)}",
                payload=PreviewCloseCommand(previewId=row["previewId"], slug=row["slug"]).model_dump(mode="json"),
            )
        except DeviceCommandError as exc:
            # frps already refuses the slug's proxy (NewProxy checks the state), and the
            # gateway refuses the slug (its Redis key is gone); the device drops the proxy
            # the next time it reconciles.
            logger.info("preview.close not confirmed preview_id={} code={}", row["previewId"], exc.code)
        return closed

    async def sweep(self) -> int:
        """Close expired previews and those of devices offline past the grace period."""

        closed = 0
        now = self._clock()
        for row in await self._store.expired_previews(_iso(now)):
            if await self._close(row, "expired"):
                closed += 1
        for device_id in await self._store.devices_with_open_previews():
            if await self._is_online(device_id):
                self._offline_since.pop(device_id, None)
                continue
            since = self._offline_since.setdefault(device_id, now)
            if now - since < OFFLINE_GRACE_SECONDS:
                continue
            for row in await self._store.open_device_previews(device_id):
                if await self._close(row, "device_offline", notify_device=False):
                    closed += 1
        return closed

    async def run(self) -> None:
        while True:
            try:
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the sweeper keeps running
                logger.exception("preview sweep failed")
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def _metas(content: dict[str, Any]) -> dict[str, Any]:
    metas = content.get("metas")
    return metas if isinstance(metas, dict) else {}


def _allow() -> dict[str, Any]:
    return {"reject": False, "unchange": True}


def _reject(reason: str) -> dict[str, Any]:
    return {"reject": True, "reject_reason": reason}

