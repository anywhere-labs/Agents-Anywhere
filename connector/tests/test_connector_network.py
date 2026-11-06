from __future__ import annotations

import asyncio
import os
import socket
import ssl
from collections.abc import Iterator
from typing import ClassVar

import httpx
import pytest

from connector.core.config import ConnectorConfig
from connector.server import network
from connector.server.ingest import ConnectorIngestClient
from connector.server.network import (
    Egress,
    NetworkEgress,
    certificate_hint,
    normalize_proxy_url,
    redact_proxy,
    resolve_egress,
    sanitize_no_proxy_environment,
    tls_context,
)

SERVER = "https://web.example.com"
PROXY_VARIABLES = ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "AA_CONNECTOR_PROXY")


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in list(os.environ):
        if name.lower() in PROXY_VARIABLES or name == "AA_CONNECTOR_PROXY":
            monkeypatch.delenv(name)
    system(monkeypatch)
    yield


def system(
    monkeypatch: pytest.MonkeyPatch,
    proxies: dict[str, str] | None = None,
    *,
    bypass: bool = False,
    alive: bool = True,
) -> None:
    monkeypatch.setattr(network, "_system_proxies", lambda: proxies or {})
    monkeypatch.setattr(network, "_system_bypass", lambda _host: bypass)
    monkeypatch.setattr(network, "_local_proxy_alive", lambda _proxy: alive)


REAL_PROBE = network._local_proxy_alive
LOCAL = {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}


def test_no_settings_goes_direct() -> None:
    assert resolve_egress(SERVER) == Egress(None, "system-none")


def test_system_proxy_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    system(monkeypatch, LOCAL)
    assert resolve_egress(SERVER) == Egress("http://127.0.0.1:7890", "system-proxy")


def test_lone_no_proxy_does_not_hide_the_system_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    # urllib treats {"no": ...} as a configured environment and skips the system (#501).
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    system(monkeypatch, LOCAL)
    assert resolve_egress(SERVER) == Egress("http://127.0.0.1:7890", "system-proxy")


def test_system_bypass_list_is_respected(monkeypatch: pytest.MonkeyPatch) -> None:
    # Excluding the Server in the OS settings used to have no effect (#502).
    system(monkeypatch, LOCAL, bypass=True)
    assert resolve_egress(SERVER) == Egress(None, "system-bypass")


def test_environment_proxy_beats_system(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://env:1")
    system(monkeypatch, LOCAL)
    assert resolve_egress(SERVER) == Egress("http://env:1", "env-proxy")


def test_http_proxy_is_not_used_for_an_https_server(monkeypatch: pytest.MonkeyPatch) -> None:
    system(monkeypatch, {"http": "http://127.0.0.1:7890"})
    assert resolve_egress(SERVER).proxy is None
    assert resolve_egress("http://web.example.com").proxy == "http://127.0.0.1:7890"


@pytest.mark.parametrize("no_proxy", [
    "web.example.com", ".example.com", "*.example.com", "example.com", "WEB.EXAMPLE.COM",
    "web.example.com:443", "other.test, web.example.com", "*",
])
def test_no_proxy_spellings_that_cover_the_server(monkeypatch: pytest.MonkeyPatch, no_proxy: str) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://env:1")
    monkeypatch.setenv("NO_PROXY", no_proxy)
    assert resolve_egress(SERVER) == Egress(None, "no-proxy")


@pytest.mark.parametrize("no_proxy", ["web.example.com:8443", "ample.com", "[::1]", "not a host", "[[", "10.*"])
def test_no_proxy_entries_that_do_not_cover_the_server(monkeypatch: pytest.MonkeyPatch, no_proxy: str) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://env:1")
    monkeypatch.setenv("NO_PROXY", no_proxy)
    assert resolve_egress(SERVER) == Egress("http://env:1", "env-proxy")


def test_no_proxy_cidr_matches_an_ip_server(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://env:1")
    monkeypatch.setenv("NO_PROXY", "10.0.0.0/8")
    assert resolve_egress("https://10.1.2.3").source == "no-proxy"
    assert resolve_egress("https://11.1.2.3").source == "env-proxy"


def test_dead_local_system_proxy_falls_back_to_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    system(monkeypatch, LOCAL, alive=False)
    assert resolve_egress(SERVER) == Egress(None, "system-proxy-down")


def test_local_proxy_probe_only_rules_out_a_closed_local_port() -> None:
    with socket.socket() as listening:
        listening.bind(("127.0.0.1", 0))
        listening.listen()
        port = listening.getsockname()[1]
        assert REAL_PROBE(f"http://127.0.0.1:{port}") is True
    assert REAL_PROBE(f"http://127.0.0.1:{port}") is False
    # A remote proxy is never declared dead here, however it behaves.
    assert REAL_PROBE("http://proxy.invalid:8080") is True


def test_loopback_server_is_never_proxied(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AA_CONNECTOR_PROXY", "http://explicit:1")
    assert resolve_egress("http://[::1]:8000") == Egress(None, "loopback")


def test_explicit_settings_and_their_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    system(monkeypatch, LOCAL)
    assert resolve_egress(SERVER, "direct") == Egress(None, "config-direct")
    assert resolve_egress(SERVER, "http://config:1") == Egress("http://config:1", "config")
    monkeypatch.setenv("AA_CONNECTOR_PROXY", "direct")
    assert resolve_egress(SERVER, "http://config:1") == Egress(None, "env-direct")
    monkeypatch.setenv("AA_CONNECTOR_PROXY", "system")
    assert resolve_egress(SERVER, "http://config:1").source == "system-proxy"
    monkeypatch.setenv("AA_CONNECTOR_PROXY", "socks5://explicit:1")
    assert resolve_egress(SERVER) == Egress("socks5://explicit:1", "env")


def test_invalid_explicit_setting_falls_back_to_system(monkeypatch: pytest.MonkeyPatch) -> None:
    system(monkeypatch, LOCAL)
    assert resolve_egress(SERVER, "ftp://nope:1").source == "system-proxy"


@pytest.mark.parametrize(("entries", "expected"), [
    ({"socks": "http://127.0.0.1:1080"}, "socks5h://127.0.0.1:1080"),
    ({"https": "socks4://127.0.0.1:1080"}, "socks5h://127.0.0.1:1080"),
    ({"socks": "socks://127.0.0.1:1080"}, "socks5h://127.0.0.1:1080"),
    ({"https": "http://a:1", "socks": "http://b:2"}, "http://a:1"),
])
def test_system_socks_entries(monkeypatch: pytest.MonkeyPatch, entries: dict[str, str], expected: str) -> None:
    system(monkeypatch, entries)
    assert resolve_egress(SERVER).proxy == expected


def test_environment_socks4_is_reported_not_rewritten(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "socks4://env:1")
    assert resolve_egress(SERVER).proxy is None


@pytest.mark.parametrize(("value", "expected"), [
    ("127.0.0.1:7890", "http://127.0.0.1:7890"),
    ("https://p:1", "https://p:1"),
    ("socks5h://p:1", "socks5h://p:1"),
    ("ftp://p:1", None),
    ("http://p:notaport", None),
    ("", None),
])
def test_normalize_proxy_url(value: str, expected: str | None) -> None:
    assert normalize_proxy_url(value) == expected


def test_proxy_password_stays_out_of_logs() -> None:
    assert redact_proxy("http://user:secret@p:1") == "http://***@p:1"
    assert "secret" not in str(Egress("http://user:secret@p:1", "env"))


def test_sanitized_no_proxy_no_longer_breaks_httpx(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://env:1")
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1,::1,[::1],[::1]:8080,*.corp.test,10.0.0.0/8,bad entry,host:81")
    with pytest.raises(httpx.InvalidURL):
        httpx.Client(trust_env=True)
    sanitize_no_proxy_environment()
    assert os.environ["NO_PROXY"] == "localhost,127.0.0.1,::1,::1,::1,corp.test,10.0.0.0/8,host:81"
    httpx.Client(trust_env=True).close()


def test_clients_share_one_route(monkeypatch: pytest.MonkeyPatch) -> None:
    system(monkeypatch, LOCAL)
    egress = NetworkEgress(SERVER)
    options = egress.websocket_options("wss://web.example.com/ws")
    assert options["proxy"] == "http://127.0.0.1:7890"
    assert isinstance(options["ssl"], ssl.SSLContext)
    assert "proxy_ssl" not in options
    assert "ssl" not in egress.websocket_options("ws://web.example.com/ws")
    assert egress.http_client(5)._trust_env is False


def test_https_proxy_gets_its_own_tls_options(monkeypatch: pytest.MonkeyPatch) -> None:
    egress = NetworkEgress(SERVER, "https://p:1")
    assert isinstance(egress.websocket_options("wss://web.example.com/ws")["proxy_ssl"], ssl.SSLContext)


class FakeTransport(httpx.AsyncBaseTransport):
    """Stands in for one connection pool, and records what it was built with."""

    built: ClassVar[list[FakeTransport]] = []

    def __init__(self, *, verify: object, trust_env: bool, proxy: httpx.Proxy | None) -> None:
        self.verify, self.trust_env, self.proxy = verify, trust_env, proxy
        self.requests: list[httpx.Request] = []
        self.closed = False
        self.gate: asyncio.Event | None = None
        self.statuses: list[int] = []
        FakeTransport.built.append(self)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        assert not self.closed, "a request reached a closed pool"
        self.requests.append(request)
        if self.gate is not None:
            await self.gate.wait()
        # A stream, as a real pool returns: a response built with its content is never closed.
        body = httpx.ByteStream(b'{"accepted": 1, "rejected": []}')
        return httpx.Response(self.statuses.pop(0) if self.statuses else 200, stream=body)

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def pools(monkeypatch: pytest.MonkeyPatch) -> list[FakeTransport]:
    FakeTransport.built.clear()
    monkeypatch.setattr(network.httpx, "AsyncHTTPTransport", FakeTransport)
    return FakeTransport.built


def test_a_route_change_keeps_clients_usable_and_finishes_requests_in_progress(
    monkeypatch: pytest.MonkeyPatch, pools: list[FakeTransport],
) -> None:
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        await egress.refresh()
        client = egress.http_client(5)
        assert (await client.get(f"{SERVER}/a")).status_code == 200
        old = pools[0]
        assert old.proxy is None
        old.gate = asyncio.Event()
        slow = asyncio.create_task(client.get(f"{SERVER}/slow"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        system(monkeypatch, LOCAL)
        await egress.refresh()
        # The same client, on the new route, while the old request is still running.
        assert (await client.get(f"{SERVER}/b")).status_code == 200
        new = pools[1]
        assert new.proxy is not None and str(new.proxy.url) == "http://127.0.0.1:7890"
        assert [request.url.path for request in new.requests] == ["/b"]
        assert old.closed is False

        old.gate.set()
        assert (await slow).status_code == 200
        assert old.closed is True, "the old route closes once it is idle"
        assert new.closed is False
        await client.aclose()
        assert new.closed is True

    asyncio.run(scenario())


def test_a_route_change_closes_an_idle_route_at_once(monkeypatch: pytest.MonkeyPatch, pools: list[FakeTransport]) -> None:
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        client = egress.http_client(5)
        await client.get(f"{SERVER}/a")
        system(monkeypatch, LOCAL)
        await egress.refresh()
        await client.get(f"{SERVER}/b")
        assert pools[0].closed is True
        await client.aclose()

    asyncio.run(scenario())


def test_a_failed_request_releases_its_route(monkeypatch: pytest.MonkeyPatch, pools: list[FakeTransport]) -> None:
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        client = egress.http_client(5)
        await client.get(f"{SERVER}/a")
        old = pools[0]

        async def refuse(_request: httpx.Request) -> httpx.Response:
            system(monkeypatch, LOCAL)
            await egress.refresh()
            raise httpx.ConnectError("proxy went away")

        monkeypatch.setattr(old, "handle_async_request", refuse)
        with pytest.raises(httpx.ConnectError):
            await client.get(f"{SERVER}/b")
        await client.get(f"{SERVER}/c")
        assert old.closed is True
        await client.aclose()

    asyncio.run(scenario())


def test_ingest_survives_a_route_change_during_its_token_refresh(
    monkeypatch: pytest.MonkeyPatch, pools: list[FakeTransport],
) -> None:
    # The upload holds its client across the refresh, then sends again. With a closed
    # client that is a RuntimeError, which ends the flush loop and the Connector with it.
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        client = egress.http_client(5)

        async def token(force: bool) -> str:
            if force:
                system(monkeypatch, LOCAL)
                await egress.refresh()
                return "fresh"
            return "stale"

        ingest = ConnectorIngestClient(SERVER, token, lambda: client, lambda timeout: client)
        await client.get(f"{SERVER}/warm")
        pools[0].statuses.append(401)
        await ingest._post_batch([{"method": "m", "params": {}}])
        assert [request.headers["authorization"] for request in pools[1].requests] == ["Bearer fresh"]
        await client.aclose()

    asyncio.run(scenario())


def test_discarding_the_route_opens_a_fresh_pool(pools: list[FakeTransport]) -> None:
    # A connection that dies without a FIN or RST stays in the pool as a socket the peer
    # has forgotten, so the next attempt must not be handed one of them.
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        client = egress.http_client(5)
        await client.get(f"{SERVER}/a")
        old = pools[0]

        await egress.discard_route()
        assert old.closed is True, "an idle pool is closed right away"

        await client.get(f"{SERVER}/b")
        assert len(pools) == 2
        assert [request.url.path for request in pools[1].requests] == ["/b"]
        await client.aclose()

    asyncio.run(scenario())


def test_discarding_keeps_a_request_in_flight_and_closes_the_pool_when_idle(pools: list[FakeTransport]) -> None:
    # The client is never closed: an upload can hold it across a token refresh, and a
    # closed client raises there, which is not a network error the loop would retry.
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        client = egress.http_client(5)
        await client.get(f"{SERVER}/a")
        old = pools[0]
        old.gate = asyncio.Event()
        slow = asyncio.create_task(client.get(f"{SERVER}/slow"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        await egress.discard_route()
        assert old.closed is False, "a pool still carrying a request is kept"

        assert (await client.get(f"{SERVER}/b")).status_code == 200
        assert old.closed is False
        assert pools[1].requests[-1].url.path == "/b"

        old.gate.set()
        assert (await slow).status_code == 200
        assert old.closed is True, "the pool closes once the request finishes"
        await client.aclose()

    asyncio.run(scenario())


def test_an_https_proxy_is_checked_with_the_shared_trust_store(pools: list[FakeTransport]) -> None:
    async def scenario() -> None:
        client = NetworkEgress(SERVER, "https://proxy.test:443").http_client(5)
        await client.get(f"{SERVER}/a")
        assert pools[0].proxy is not None
        assert pools[0].proxy.ssl_context is tls_context()
        assert pools[0].verify is tls_context()
        assert pools[0].trust_env is False
        await client.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize("proxy", [None, "http://p:1", "https://p:1", "socks5://p:1", "socks5h://p:1", "http://user:secret@p:1"])
def test_every_proxy_scheme_builds_a_real_connection_pool(proxy: str | None) -> None:
    # Not the fake: httpcore validates these arguments itself and raises when building.
    assert network._Route(Egress(proxy, "config")).transport is not None


def test_config_round_trips_proxy(tmp_path) -> None:
    base = {"serverUrl": SERVER, "connectorId": "c", "connectorToken": "t"}
    assert ConnectorConfig.from_mapping(base).proxy is None
    path = ConnectorConfig.from_mapping({**base, "proxy": "direct"}).save(tmp_path / "c.json")
    assert ConnectorConfig.load(path).proxy == "direct"
    unset = ConnectorConfig.from_mapping(base).save(tmp_path / "u.json")
    assert '"proxy"' not in unset.read_text(encoding="utf-8")


def test_tls_context_prefers_an_explicit_ca_override(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    tls_context.cache_clear()
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path))
    try:
        assert type(tls_context()) is ssl.SSLContext
    finally:
        tls_context.cache_clear()


def test_tls_context_falls_back_to_the_bundle_without_a_system_verifier(monkeypatch: pytest.MonkeyPatch) -> None:
    tls_context.cache_clear()
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    monkeypatch.setattr(network.sys, "platform", "linux")
    try:
        context = tls_context()
        assert type(context) is ssl.SSLContext
        assert context.cert_store_stats()["x509_ca"] > 0
    finally:
        tls_context.cache_clear()


def test_certificate_hint_recognises_every_wording() -> None:
    # OpenSSL's text, the wording of a system verifier, and httpx wrapping either one.
    openssl = ssl.SSLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate has expired")
    system_verifier = ssl.SSLCertVerificationError("certificate is not trusted")
    wrapped = httpx.ConnectError("connect failed")
    wrapped.__cause__ = system_verifier
    for error in (openssl, system_verifier, wrapped):
        hint = certificate_hint(error, SERVER)
        assert hint is not None and "web.example.com" in hint
    assert certificate_hint(ConnectionRefusedError("refused"), SERVER) is None
