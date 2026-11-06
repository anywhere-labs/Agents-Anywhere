"""How the Connector reaches its Server: which proxy, and which trust store.

Every connection to the Server takes the same route from here, so HTTP and both
WebSockets cannot disagree. Left to themselves httpx and websockets each read
``urllib.request.getproxies()``, which has three traps this module avoids:

* A lone ``NO_PROXY`` makes the environment look configured, so the system proxy
  is skipped entirely and the Connector silently goes direct.
* httpx ignores the system bypass list (macOS exceptions, Windows
  ``ProxyOverride``), so excluding the Server in the OS settings has no effect.
* httpx rejects some ``NO_PROXY`` spellings, such as ``[::1]``, while building
  the client, which stops the Connector from starting at all.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
import ssl
import sys
import urllib.request
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import urlparse

import certifi
import httpx
from loguru import logger

from connector.server.urls import is_loopback_url

PROXY_ENV = "AA_CONNECTOR_PROXY"
MODE_SYSTEM = "system"
MODE_DIRECT = "direct"

_PROXY_SCHEMES = {"http", "https", "socks5", "socks5h"}
_DEFAULT_PROXY_PORTS = {"http": 80, "https": 443, "socks5": 1080, "socks5h": 1080}
_DOMAIN = re.compile(r"^[a-z0-9_-]+(\.[a-z0-9_-]+)*$")
_BRACKETED_IPV6 = re.compile(r"^\[([^\]]+)\](?::(\d+))?$")
_LOOPBACK_PROBE_SECONDS = 0.5


@dataclass(frozen=True, slots=True)
class Egress:
    """The route to the Server. ``source`` says which setting decided it."""

    proxy: str | None
    source: str

    def __str__(self) -> str:
        return f"proxy={redact_proxy(self.proxy) if self.proxy else 'direct'} source={self.source}"


class NetworkEgress:
    """The route to one Server, shared by everything that connects to it.

    ``refresh`` re-reads the settings off the event loop, because the macOS bypass
    check can do a DNS lookup; each backend reconnect calls it, so a proxy switched
    on or off is picked up without restarting the Connector. HTTP clients follow the
    change on their own, see ``_EgressTransport``.
    """

    def __init__(self, server_url: str, configured: str | None = None) -> None:
        self.server_url = server_url
        self.configured = configured
        self._current: Egress | None = None

    @property
    def current(self) -> Egress:
        return self._current if self._current is not None else self._store(self._resolve())

    async def refresh(self) -> None:
        self._store(await asyncio.to_thread(self._resolve))

    def http_client(self, timeout: httpx.Timeout | float) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, trust_env=False, transport=_EgressTransport(self))

    def websocket_options(self, url: str) -> dict[str, Any]:
        """Keyword arguments for ``websockets.connect``; ``ssl`` is only valid for wss."""
        proxy = self.current.proxy
        options: dict[str, Any] = {"proxy": proxy}
        if url.startswith("wss://"):
            options["ssl"] = tls_context()
        if proxy is not None and proxy.startswith("https://"):
            options["proxy_ssl"] = tls_context()
        return options

    def _resolve(self) -> Egress:
        return resolve_egress(self.server_url, self.configured)

    def _store(self, egress: Egress) -> Egress:
        if egress != self._current:
            logger.info("connector egress server={} {}", self.server_url, egress)
        self._current = egress
        return egress


class _Route:
    """One connection pool, on one route to the Server."""

    def __init__(self, egress: Egress) -> None:
        self.egress = egress
        self.active = 0
        # Without its own context an HTTPS proxy is checked against httpx's default
        # store, so one trusted only by the system would work for WebSockets alone.
        proxy = httpx.Proxy(egress.proxy, ssl_context=tls_context()) if egress.proxy else None
        self.transport = httpx.AsyncHTTPTransport(verify=tls_context(), trust_env=False, proxy=proxy)


class _RouteStream(httpx.AsyncByteStream):
    """A response body; the request holds its route until the body is closed."""

    def __init__(self, stream: httpx.AsyncByteStream, on_close: Callable[[], Awaitable[None]]) -> None:
        self._stream = stream
        self._on_close = on_close

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._stream:
            yield chunk

    async def aclose(self) -> None:
        try:
            await self._stream.aclose()
        finally:
            await self._on_close()


class _EgressTransport(httpx.AsyncBaseTransport):
    """Sends each request on the current route, and lets a client outlive a route change.

    Code that holds a client across awaits, such as an upload that refreshes its token
    and sends again, must never find it closed: that error is not a network failure and
    would stop the task. So the client stays and only what is under it changes. A request
    in progress finishes on the route it started on, which is closed once it is idle.
    """

    def __init__(self, egress: NetworkEgress) -> None:
        self._egress = egress
        self._route: _Route | None = None
        self._retired: set[_Route] = set()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        route = await self._current_route()
        route.active += 1
        released = False

        async def release() -> None:
            nonlocal released
            if not released:
                released = True
                route.active -= 1
                await self._close_if_idle(route)

        try:
            response = await route.transport.handle_async_request(request)
        except BaseException:
            await release()
            raise
        response.stream = _RouteStream(response.stream, release)
        return response

    async def aclose(self) -> None:
        routes = [*self._retired, *([self._route] if self._route else [])]
        self._retired.clear()
        self._route = None
        await asyncio.gather(*(route.transport.aclose() for route in routes), return_exceptions=True)

    async def _current_route(self) -> _Route:
        egress = self._egress.current
        if self._route is None or self._route.egress != egress:
            previous, self._route = self._route, _Route(egress)
            if previous is not None:
                self._retired.add(previous)
                await self._close_if_idle(previous)
        return self._route

    async def _close_if_idle(self, route: _Route) -> None:
        if route in self._retired and route.active == 0:
            self._retired.discard(route)
            await route.transport.aclose()


async def open_http_client(server_url: str, timeout: httpx.Timeout | float) -> httpx.AsyncClient:
    """A client for a Server known only by URL, as during pairing."""
    egress = NetworkEgress(server_url)
    await egress.refresh()
    return egress.http_client(timeout)


def resolve_egress(url: str, configured: str | None = None) -> Egress:
    """Decide the route to ``url``. The environment variable overrides the config file."""
    if is_loopback_url(url):
        return Egress(None, "loopback")
    from_env = os.environ.get(PROXY_ENV, "").strip()
    mode = from_env or (configured or "").strip() or MODE_SYSTEM
    origin = "env" if from_env else "config"
    if mode == MODE_DIRECT:
        return Egress(None, f"{origin}-direct")
    if mode != MODE_SYSTEM:
        explicit = normalize_proxy_url(mode)
        if explicit is not None:
            return Egress(explicit, origin)
        logger.warning("ignoring invalid connector proxy setting {}", redact_proxy(mode))
    return _resolve_system(url)


def _resolve_system(url: str) -> Egress:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    secure = parsed.scheme in {"https", "wss"}
    environment = urllib.request.getproxies_environment()
    # A NO_PROXY covering this Server wins over any proxy, wherever the proxy came from.
    if _no_proxy_matches(environment.get("no", ""), host, parsed.port or (443 if secure else 80)):
        return Egress(None, "no-proxy")
    proxy = _pick_proxy(environment, secure)
    if proxy is not None:
        return Egress(proxy, "env-proxy")

    proxy = _pick_proxy(_system_proxies(), secure, system=True)
    if proxy is None:
        return Egress(None, "system-none")
    if _system_bypass(host):
        return Egress(None, "system-bypass")
    # A proxy app that has quit often leaves the system switch on. Only a local
    # port gives a certain answer: a remote proxy that is slow to answer must not
    # send a network that forbids direct traffic down a path that cannot work.
    if not _local_proxy_alive(proxy):
        logger.warning("system proxy {} is not accepting connections; connecting directly", redact_proxy(proxy))
        return Egress(None, "system-proxy-down")
    return Egress(proxy, "system-proxy")


def _pick_proxy(proxies: dict[str, str], secure: bool, *, system: bool = False) -> str | None:
    # The HTTP entry is not a fallback for an https target: that matches curl and
    # httpx, and a system configured with only an HTTP proxy keeps going direct.
    for scheme in ("https" if secure else "http", "all", "socks"):
        value = proxies.get(scheme)
        if not value:
            continue
        # macOS reports a SOCKS proxy as {"socks": "http://host:port"}.
        if scheme == "socks" and value.startswith("http://"):
            value = "socks5h://" + value.removeprefix("http://")
        # CPython labels a Windows SOCKS entry socks4, a guess: httpx has no SOCKS4
        # and the local proxy apps people run speak SOCKS5.
        if system and value.startswith("socks4://"):
            value = "socks5h://" + value.removeprefix("socks4://")
        normalized = normalize_proxy_url(value)
        if normalized is not None:
            return normalized
        logger.warning("ignoring unsupported proxy {}", redact_proxy(value))
    return None


def _system_proxies() -> dict[str, str]:
    if sys.platform == "darwin":
        return urllib.request.getproxies_macosx_sysconf()
    if sys.platform == "win32":
        return urllib.request.getproxies_registry()
    return {}


def _system_bypass(host: str) -> bool:
    if sys.platform == "darwin":
        return bool(urllib.request.proxy_bypass_macosx_sysconf(host))
    if sys.platform == "win32":
        return bool(urllib.request.proxy_bypass_registry(host))
    return False


def _local_proxy_alive(proxy: str) -> bool:
    parsed = urlparse(proxy)
    host = parsed.hostname or ""
    if host not in {"127.0.0.1", "localhost", "::1"}:
        return True
    port = parsed.port or _DEFAULT_PROXY_PORTS.get(parsed.scheme, 80)
    try:
        with socket.create_connection((host, port), timeout=_LOOPBACK_PROBE_SECONDS):
            return True
    except OSError:
        return False


def normalize_proxy_url(value: str) -> str | None:
    """The proxy URL with a scheme httpx and websockets both accept, or None."""
    candidate = value.strip()
    if not candidate:
        return None
    if "://" not in candidate:
        candidate = f"http://{candidate}"
    if candidate.startswith("socks://"):
        candidate = "socks5h://" + candidate.removeprefix("socks://")
    try:
        parsed = urlparse(candidate)
        _ = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in _PROXY_SCHEMES or not parsed.hostname:
        return None
    return candidate


def redact_proxy(value: str) -> str:
    """Proxy URLs can carry a password, and these strings go to the logs."""
    return re.sub(r"(?<=://)[^/@]*@", "***@", value)


@dataclass(frozen=True, slots=True)
class _NoProxyEntry:
    domain: str | None = None
    network: ipaddress.IPv4Network | ipaddress.IPv6Network | None = None
    port: int | None = None
    everything: bool = False

    def matches(self, host: str, port: int) -> bool:
        if self.everything:
            return True
        if self.port is not None and self.port != port:
            return False
        if self.network is not None:
            try:
                return ipaddress.ip_address(host) in self.network
            except ValueError:
                return False
        return host == self.domain or host.endswith(f".{self.domain}")

    def __str__(self) -> str:
        if self.everything:
            return "*"
        if self.network is not None:
            prefix_is_host = self.network.prefixlen == self.network.max_prefixlen
            text = str(self.network.network_address) if prefix_is_host else str(self.network)
            # httpx cannot parse a bracketed IPv6 entry, with or without a port.
            return text if self.port is None or self.network.version == 6 else f"{text}:{self.port}"
        return self.domain if self.port is None else f"{self.domain}:{self.port}"  # type: ignore[return-value]


def _parse_no_proxy_entry(raw: str) -> _NoProxyEntry | None:
    entry = raw.strip().lower()
    if not entry:
        return None
    if entry == "*":
        return _NoProxyEntry(everything=True)
    port: int | None = None
    if bracketed := _BRACKETED_IPV6.match(entry):
        entry = bracketed.group(1)
        port = int(bracketed.group(2)) if bracketed.group(2) else None
    elif entry.count(":") == 1:
        entry, _, port_text = entry.partition(":")
        if not port_text.isdigit():
            return None
        port = int(port_text)
    try:
        return _NoProxyEntry(network=ipaddress.ip_network(entry, strict=False), port=port)
    except ValueError:
        pass
    domain = entry.removeprefix("*.").lstrip(".")
    return _NoProxyEntry(domain=domain, port=port) if _DOMAIN.match(domain) else None


def _no_proxy_entries(value: str) -> list[_NoProxyEntry]:
    entries: list[_NoProxyEntry] = []
    for raw in value.split(","):
        entry = _parse_no_proxy_entry(raw)
        if entry is not None:
            entries.append(entry)
        elif raw.strip():
            logger.warning("ignoring NO_PROXY entry {!r}", raw.strip())
    return entries


def _no_proxy_matches(value: str, host: str, port: int) -> bool:
    return any(entry.matches(host.lower(), port) for entry in _no_proxy_entries(value))


def sanitize_no_proxy_environment() -> None:
    """Rewrite NO_PROXY in place so nothing in this process tree trips over it.

    Libraries and Agent subprocesses read it directly and some fail on spellings
    such as ``[::1]``, so correcting only this module's reading would not help them.
    """
    for name in ("NO_PROXY", "no_proxy"):
        value = os.environ.get(name)
        if value:
            os.environ[name] = ",".join(str(entry) for entry in _no_proxy_entries(value))


@lru_cache(maxsize=1)
def tls_context() -> ssl.SSLContext:
    """The trust store for the Server's certificate.

    The operating system decides on macOS and Windows. OpenSSL's own view of the
    Windows store can miss a root that Windows would fetch on demand, and a
    python.org build on macOS may have no roots at all, while the system verifier
    also knows a company's own root. ``SSL_CERT_FILE`` and ``SSL_CERT_DIR`` remain
    an explicit override.
    """
    if os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR"):
        return ssl.create_default_context()
    if sys.platform in {"darwin", "win32"}:
        try:
            import truststore

            return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        except Exception as exc:  # noqa: BLE001 - the bundle below still verifies.
            logger.warning("system trust store unavailable ({}); using bundled CA certificates", exc)
    context = ssl.create_default_context()
    context.load_verify_locations(certifi.where())
    return context


def certificate_hint(error: BaseException, server_url: str) -> str | None:
    """Explain a certificate failure: its text blames the Server for a stale local store.

    The system verifiers word their errors in their own way, and httpx wraps them,
    so the exception chain is what identifies one.
    """
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(current):
            return (
                f"certificate for {urlparse(server_url).hostname} was rejected ({current}); the Server's "
                "certificate may be fine and the local CA store out of date or missing the root that issued it"
            )
        current = current.__cause__ or current.__context__
    return None
