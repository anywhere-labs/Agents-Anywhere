"""Which devices speak device-meshcall, and the reads the Server itself makes of them.

Client reads of session content go to the device with ``Client/call`` (``services.client_forward``). The
Server still reads workflow progress (``read_method``), blobs and share exports (``services.device_blobs``):

- Device offline (not delivered): ``None``.
- Opened and then failed or timed out (outcome unknown): ``DeviceReadTimeout`` (``device_read_timeout``).
- The device's own error: ``DeviceReadError`` with its code.
"""

from __future__ import annotations

from typing import Any

from agent_server.core.device_meshcall import REQUEST_METHODS, MethodPayload
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh


class DeviceReadTimeout(Exception):
    """The device is online but the read did not complete (``device_read_timeout``)."""

    code = "device_read_timeout"

    def __init__(self, message: str = "the device did not answer in time") -> None:
        super().__init__(message)
        self.message = message


class DeviceReadError(Exception):
    """The device answered with an application error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class DeviceReadService:
    def __init__(self, store: Any, mesh: DeviceMesh | None = None, hub: DeviceLinkHub | None = None) -> None:
        self._store = store
        self._mesh = mesh
        self._hub = hub

    async def is_v3_device(self, connector_id: str) -> bool:
        """Whether the connector last linked as a device-meshcall device rather than over the v2 socket."""

        return bool(await self._store.connector_link_contract(connector_id))

    async def read_method(self, device_id: str, method: str, params: dict[str, Any]) -> dict[str, Any] | None:
        """A small read (``workspace.preparation.get``, ``session.creation.get``): the device's body, None when
        the device is offline."""

        if self._mesh is None or self._hub is None:
            raise RuntimeError("this DeviceReadService has no device link")
        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            return None
        try:
            result = await self._mesh.unary(
                device_id,
                REQUEST_METHODS[method],
                MethodPayload(**params),
                MethodPayload,
                connection_id=connection_id,
                timeout=self._mesh.settings.read_timeout_seconds,
            )
        except DeviceCallError as exc:
            if exc.not_delivered:
                return None
            if exc.outcome_unknown:
                raise DeviceReadTimeout(exc.message or "the device did not answer in time") from exc
            # The device's own error code (``details.aaCode``) wins over the MeshCall status.
            aa_code = exc.details.get("aaCode") if isinstance(exc.details, dict) else None
            code = aa_code if isinstance(aa_code, str) and aa_code else exc.code
            raise DeviceReadError(code, exc.message or code) from exc
        return result.model_dump(mode="json")
