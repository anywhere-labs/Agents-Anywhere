import asyncio
from collections.abc import AsyncIterator, Coroutine
from typing import Any, TypeVar

from meshcall import (
    InvalidArgumentError as MeshInvalidArgumentError,
)
from meshcall import (
    PermissionDeniedError as MeshPermissionDeniedError,
)
from meshcall import (
    ResourceExhaustedError as MeshResourceExhaustedError,
)
from meshcall import (
    RpcContext,
    RpcInputStream,
    method,
    service,
)
from meshcall import (
    UnauthenticatedError as MeshUnauthenticatedError,
)
from meshcall import (
    UnavailableError as MeshUnavailableError,
)

from aa_control.core.auth import (
    ClientPrincipal,
    DevicePrincipal,
    parse_client_principal,
    parse_device_principal,
)
from aa_control.core.errors import (
    ControlError,
    DeviceOfflineError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    UnauthenticatedError,
    UpstreamUnavailableError,
    ValidationError,
)
from aa_control.core.models import (
    ClientPlatform,
    DeviceAdminPingResponse,
    DeviceRecord,
    DeviceSessionResult,
    ListDevicesResponse,
    ListSessionsOnceResponse,
    ListSessionsRequest,
    OkResponse,
    OpenTunnelRequest,
    OpenTunnelResponse,
    PresenceAck,
    PresenceReport,
    PushEventType,
    PushNotificationAck,
    PushNotificationRequest,
    RegisterClientPushRequest,
    RevokeTunnelResponse,
    WatchDevicesEvent,
)
from aa_control.services.device_service import DeviceService
from aa_control.services.fanout_service import FanoutService
from aa_control.services.push_service import PushService
from aa_control.services.tunnel_service import TunnelService


def _require_client(ctx: RpcContext) -> ClientPrincipal:
    principal = parse_client_principal(ctx.token_principal)
    if principal is None:
        raise MeshUnauthenticatedError(
            "valid client meshcall-token-principal (user:<uid>/client:<cid>) is required"
        )
    return principal


def _require_device(ctx: RpcContext) -> DevicePrincipal:
    principal = parse_device_principal(ctx.token_principal)
    if principal is None:
        raise MeshUnauthenticatedError(
            "valid device meshcall-token-principal (device:<did>) is required"
        )
    return principal


def _translate_error(exc: ControlError) -> Exception:
    if isinstance(exc, UnauthenticatedError):
        return MeshUnauthenticatedError(exc.message)
    if isinstance(exc, ForbiddenError):
        return MeshPermissionDeniedError(exc.message)
    if isinstance(exc, ValidationError):
        return MeshInvalidArgumentError(exc.message)
    if isinstance(exc, RateLimitError):
        return MeshResourceExhaustedError(exc.message)
    if isinstance(exc, (DeviceOfflineError, UpstreamUnavailableError)):
        return MeshUnavailableError(exc.message)
    if isinstance(exc, NotFoundError):
        return MeshInvalidArgumentError(exc.message)
    return MeshUnavailableError(exc.message)


_T = TypeVar("_T")


@service(name="aa.v3.Control")
class ControlRpcService:
    """MeshCall control plane service mounted on every configured Router."""

    def __init__(
        self,
        *,
        device_service: DeviceService,
        tunnel_service: TunnelService,
        fanout_service: FanoutService,
        push_service: PushService,
    ) -> None:
        self._devices = device_service
        self._tunnels = tunnel_service
        self._fanout = fanout_service
        self._push = push_service
        self._app_loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the main application event loop owning DB, Redis, and MeshCall clients.

        MeshCall's RpcServer executes handlers inside a dedicated WorkerLoop thread;
        dispatching service coroutines back onto the app loop keeps asyncpg,
        redis.asyncio, and MeshCallRouterPool on a single owning loop.
        """
        self._app_loop = loop

    async def _on_app_loop(self, coro: Coroutine[Any, Any, _T]) -> _T:
        target = self._app_loop
        if target is None or target is asyncio.get_running_loop():
            return await coro
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, target))

    async def _stream_on_app_loop(self, gen_factory: Any) -> AsyncIterator[Any]:
        target = self._app_loop
        caller_loop = asyncio.get_running_loop()
        if target is None or target is caller_loop:
            async for item in gen_factory():
                yield item
            return

        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

        async def _pump() -> None:
            try:
                async for item in gen_factory():
                    caller_loop.call_soon_threadsafe(queue.put_nowait, ("item", item))
            except BaseException as exc:  # noqa: BLE001
                caller_loop.call_soon_threadsafe(queue.put_nowait, ("error", exc))
            else:
                caller_loop.call_soon_threadsafe(queue.put_nowait, ("done", None))

        pump_future = asyncio.run_coroutine_threadsafe(_pump(), target)
        try:
            while True:
                kind, payload = await queue.get()
                if kind == "item":
                    yield payload
                elif kind == "done":
                    break
                else:
                    raise payload
        finally:
            if not pump_future.done():
                pump_future.cancel()

    # ------------------------------------------------------------------
    # Client methods (principal: user:<uid>/client:<cid>)
    # ------------------------------------------------------------------

    @method(read_only=True)
    async def list_devices(self, ctx: RpcContext) -> ListDevicesResponse:
        """List all devices owned by the authenticated user with live presence."""
        client = _require_client(ctx)
        try:
            devices = await self._on_app_loop(self._devices.list_devices(client.user_id))
            return ListDevicesResponse(devices=devices)
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method(read_only=True)
    async def get_device(self, device_id: str, ctx: RpcContext) -> DeviceRecord:
        """Get metadata and live presence for one owned device."""
        client = _require_client(ctx)
        try:
            return await self._on_app_loop(
                self._devices.get_device(user_id=client.user_id, device_id=device_id)
            )
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method(idempotent=True)
    async def rename_device(self, device_id: str, name: str, ctx: RpcContext) -> DeviceRecord:
        """Rename an owned device and notify it via DeviceAdmin/rename if online."""
        client = _require_client(ctx)
        try:
            return await self._on_app_loop(
                self._devices.rename_device(
                    user_id=client.user_id,
                    device_id=device_id,
                    name=name,
                    actor=client.format(),
                )
            )
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method(destructive=True)
    async def delete_device(self, device_id: str, ctx: RpcContext) -> OkResponse:
        """Delete an owned device and revoke its credentials."""
        client = _require_client(ctx)
        try:
            deleted = await self._on_app_loop(
                self._devices.delete_device(
                    user_id=client.user_id,
                    device_id=device_id,
                    actor=client.format(),
                )
            )
            return OkResponse(ok=deleted)
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method.server_stream()
    async def watch_devices(self, ctx: RpcContext) -> AsyncIterator[WatchDevicesEvent]:
        """Stream an initial device snapshot followed by live device upsert/remove events."""
        client = _require_client(ctx)
        async for event in self._stream_on_app_loop(lambda: self._devices.watch_devices(client.user_id)):
            yield event

    @method()
    async def open_tunnel(
        self,
        device_id: str,
        ctx: RpcContext,
        client_id: str | None = None,
        e2e_key: str | None = None,
    ) -> OpenTunnelResponse:
        """Open a MeshCall tunnel to an online owned device (plain or E2E)."""
        client = _require_client(ctx)
        try:
            req = OpenTunnelRequest(device_id=device_id, client_id=client_id, e2e_key=e2e_key)
            return await self._on_app_loop(
                self._tunnels.open_tunnel(
                    user_id=client.user_id,
                    client_id=client.client_id,
                    req=req,
                )
            )
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method(idempotent=True)
    async def revoke_tunnel(
        self,
        device_id: str,
        tunnel_id: str,
        ctx: RpcContext,
    ) -> RevokeTunnelResponse:
        """Revoke a tunnel on the Router and instruct the device to drop its sessions."""
        client = _require_client(ctx)
        try:
            return await self._on_app_loop(
                self._tunnels.revoke_tunnel(
                    user_id=client.user_id,
                    device_id=device_id,
                    tunnel_id=tunnel_id,
                    actor=client.format(),
                )
            )
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method.server_stream()
    async def list_sessions(
        self,
        ctx: RpcContext,
        device_ids: list[str] | None = None,
        limit_per_device: int | None = None,
    ) -> AsyncIterator[DeviceSessionResult]:
        """Stream aggregated session lists across online normal devices and placeholders for encrypted/offline ones."""
        client = _require_client(ctx)
        req = ListSessionsRequest(device_ids=device_ids, limit_per_device=limit_per_device)
        async for result in self._stream_on_app_loop(
            lambda: self._fanout.list_sessions_stream(
                user_id=client.user_id,
                req=req,
                via="client",
            )
        ):
            yield result

    @method(read_only=True)
    async def list_sessions_once(
        self,
        ctx: RpcContext,
        device_ids: list[str] | None = None,
        limit_per_device: int | None = None,
    ) -> ListSessionsOnceResponse:
        """Return aggregated session lists across devices in a single unary response."""
        client = _require_client(ctx)
        req = ListSessionsRequest(device_ids=device_ids, limit_per_device=limit_per_device)
        return await self._on_app_loop(
            self._fanout.list_sessions_once(
                user_id=client.user_id,
                req=req,
                via="client",
            )
        )

    @method(read_only=True)
    async def ping_device(self, device_id: str, ctx: RpcContext) -> DeviceAdminPingResponse:
        """Probe latency and reachability of an online owned device via DeviceAdmin/ping."""
        client = _require_client(ctx)
        try:
            return await self._on_app_loop(
                self._devices.ping_device(user_id=client.user_id, device_id=device_id)
            )
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method(idempotent=True)
    async def check_device_update(
        self,
        device_id: str,
        ctx: RpcContext,
        channel: str | None = None,
    ) -> OkResponse:
        """Hint an online owned device to check for updates via DeviceAdmin/check_update."""
        client = _require_client(ctx)
        try:
            ok = await self._on_app_loop(
                self._devices.check_device_update(
                    user_id=client.user_id,
                    device_id=device_id,
                    channel=channel,
                    actor=client.format(),
                )
            )
            return OkResponse(ok=ok)
        except ControlError as exc:
            raise _translate_error(exc) from exc

    @method(idempotent=True)
    async def register_client_push_token(
        self,
        client_id: str,
        platform: ClientPlatform,
        ctx: RpcContext,
        push_token: str | None = None,
        label: str | None = None,
    ) -> OkResponse:
        """Register or update a mobile/desktop push notification token for this client."""
        client = _require_client(ctx)
        try:
            req = RegisterClientPushRequest(
                client_id=client_id,
                platform=platform,
                push_token=push_token,
                label=label,
            )
            await self._on_app_loop(
                self._devices.register_client_push_token(user_id=client.user_id, req=req)
            )
            return OkResponse(ok=True)
        except ControlError as exc:
            raise _translate_error(exc) from exc

    # ------------------------------------------------------------------
    # Connector / Device methods (principal: device:<did>)
    # ------------------------------------------------------------------

    @method.client_stream()
    async def presence(
        self,
        items: RpcInputStream[PresenceReport],
        ctx: RpcContext,
    ) -> PresenceAck:
        """Long-lived client stream carrying Connector presence heartbeats."""
        device = _require_device(ctx)
        accepted = 0
        try:
            async for report in items:
                await self._on_app_loop(
                    self._devices.handle_presence_report(
                        authenticated_device_id=device.device_id,
                        report=report,
                    )
                )
                accepted += 1
        except ControlError as exc:
            raise _translate_error(exc) from exc
        finally:
            await self._on_app_loop(self._devices.mark_device_offline(device.device_id))
        return PresenceAck(accepted=accepted)

    @method()
    async def notify_push(
        self,
        device_id: str,
        event_type: PushEventType,
        ctx: RpcContext,
        session_id: str | None = None,
        title: str | None = None,
        body: str | None = None,
    ) -> PushNotificationAck:
        """Enqueue a push notification for the device owner (strips content for encrypted devices)."""
        device = _require_device(ctx)
        try:
            req = PushNotificationRequest(
                device_id=device_id,
                event_type=event_type,
                session_id=session_id,
                title=title,
                body=body,
            )
            return await self._on_app_loop(
                self._push.notify_from_device(
                    authenticated_device_id=device.device_id,
                    req=req,
                )
            )
        except ControlError as exc:
            raise _translate_error(exc) from exc
