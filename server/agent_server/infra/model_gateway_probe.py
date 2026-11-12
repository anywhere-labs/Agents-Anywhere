"""Calls to a model gateway the user entered, to see what it speaks.

The address comes from the user, so the server would otherwise call anything
it can reach on the user's behalf. Each host is resolved here, every address
it resolves to must be public, and the call goes to that checked address
(TLS still verifies the host name), so a second lookup cannot point it
elsewhere. Redirects are not followed. Deployments whose gateways live on a
private network allow them with ``AGENT_SERVER_ALLOW_PRIVATE_MODEL_GATEWAYS``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

import httpx

from agent_server.core.model_discovery import ProbeRequest, ProbeResponse

PROBE_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
MAX_BODY_BYTES = 2 * 1024 * 1024
ALLOW_PRIVATE_ENV = "AGENT_SERVER_ALLOW_PRIVATE_MODEL_GATEWAYS"

Resolver = Callable[[str, int], Awaitable[list[str]]]


class GatewayAddressNotAllowedError(Exception):
    """The address is on a private network and the deployment does not allow that."""


async def _resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def private_gateways_allowed() -> bool:
    return os.environ.get(ALLOW_PRIVATE_ENV, "").strip().lower() in {"1", "true", "yes"}


@dataclass(slots=True)
class GatewayProber:
    allow_private: bool = False
    transport: httpx.AsyncBaseTransport | None = field(default=None, repr=False)
    resolver: Resolver = field(default=_resolve, repr=False)

    async def run(self, requests: list[ProbeRequest]) -> dict[str, ProbeResponse]:
        """Every request at once; raises when the host may not be called."""
        if not requests:
            return {}
        pinned = await self._pinned_host(requests[0].url)
        async with httpx.AsyncClient(
            timeout=PROBE_TIMEOUT, transport=self.transport, follow_redirects=False, trust_env=False
        ) as client:
            answers = await asyncio.gather(*(self._send(client, request, pinned) for request in requests))
        return {request.name: answer for request, answer in zip(requests, answers, strict=True)}

    async def _pinned_host(self, url: str) -> str:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
        try:
            addresses = [host] if _is_ip(host) else await self.resolver(host, port)
        except OSError:
            # Unknown host: the calls fail as unreachable.
            return host
        if not addresses:
            return host
        if not self.allow_private and not all(ipaddress.ip_address(address).is_global for address in addresses):
            raise GatewayAddressNotAllowedError(host)
        return addresses[0]

    async def _send(self, client: httpx.AsyncClient, request: ProbeRequest, address: str) -> ProbeResponse:
        parts = urlsplit(request.url)
        host = parts.hostname or ""
        netloc = f"[{address}]" if ":" in address else address
        if parts.port:
            netloc = f"{netloc}:{parts.port}"
        extensions = {"sni_hostname": host} if parts.scheme == "https" and address != host else {}
        try:
            async with client.stream(
                request.method,
                urlunsplit((parts.scheme, netloc, parts.path, parts.query, "")),
                headers={**request.headers, "Host": parts.netloc},
                json={} if request.method == "POST" else None,
                extensions=extensions,
            ) as response:
                body = await _read_limited(response)
        except httpx.TimeoutException:
            return ProbeResponse(None, error="timeout")
        except httpx.HTTPError:
            return ProbeResponse(None, error="unreachable")
        if body is None:
            return ProbeResponse(response.status_code)
        try:
            return ProbeResponse(response.status_code, json.loads(body), is_json=True)
        except ValueError:
            return ProbeResponse(response.status_code)


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


async def _read_limited(response: httpx.Response) -> bytes | None:
    """The body, or None when it is too large to be a model list or an error."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)
