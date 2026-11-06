from __future__ import annotations

import asyncio
import os
import socket
import ssl
from collections.abc import Iterator

import httpx
import pytest

from connector.core.config import ConnectorConfig
from connector.server import network
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
    client = egress.http_client(5)
    assert client._trust_env is False
    assert len(client._mounts) == 1 and next(iter(client._mounts.values())) is not None


def test_https_proxy_gets_its_own_tls_options(monkeypatch: pytest.MonkeyPatch) -> None:
    egress = NetworkEgress(SERVER, "https://p:1")
    assert isinstance(egress.websocket_options("wss://web.example.com/ws")["proxy_ssl"], ssl.SSLContext)


def test_refresh_reports_a_route_change(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        egress = NetworkEgress(SERVER)
        assert await egress.refresh() is False
        assert await egress.refresh() is False
        system(monkeypatch, LOCAL)
        assert await egress.refresh() is True
        assert egress.current.proxy == "http://127.0.0.1:7890"

    asyncio.run(scenario())


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
