"""Provider and discovery tests for the OpenCode host-service runtime.

The provider must derive everything from what discovery reports (m3: a capability
the hub/runtime cannot perform must never be advertised), keep instance identity
distinguishable per (registration dir, servicePid, location) without leaking the
service password into any key, and treat "OpenCode is not running" as a temporary
state with an actionable message rather than an invalid configuration.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol.filesystem import canonical_path
from connector.runtimes.opencode import provider_config
from connector.runtimes.opencode.provider import OpenCodeProvider
from connector.runtimes.opencode.serve import discovery as serve_discovery
from connector.runtimes.opencode.serve.client import OpenCodeServerClient
from connector.runtimes.opencode.serve.runtime import OpenCodeServiceRuntime
from connector.runtimes.opencode.serve.service import OpenCodeService

# Opaque location string: discovery only forwards it, so it must not be a path
# that exists on the machine running the tests.
DIRECTORY = "/work/repo"


def fake_discovery(**overrides: Any) -> serve_discovery.ServiceDiscovery:
    base: dict[str, Any] = {
        "available": True,
        "configured": True,
        "reason": None,
        "metadata": {
            "serviceVersion": "2.0.18",
            "runtimeCapabilities": {
                "capabilities": [
                    {"capabilityId": "catalog.model", "supported": True, "available": True, "allowed": True},
                    {"capabilityId": "session.send_message", "supported": True, "available": True, "allowed": True},
                    {"capabilityId": "session.discovery", "supported": True, "available": True, "allowed": True},
                ]
            },
        },
    }
    base.update(overrides)
    return serve_discovery.ServiceDiscovery(**base)


def provider_with(result: serve_discovery.ServiceDiscovery) -> OpenCodeProvider:
    async def discover(_values: Any) -> serve_discovery.ServiceDiscovery:
        return result

    return OpenCodeProvider(discoverer=discover)


# --------------------------------------------------------------- provider shape


def test_provider_identity_and_description() -> None:
    provider = OpenCodeProvider()
    assert (provider.runtime, provider.runtime_type) == ("opencode", "opencode")
    assert provider.implementation_type == "local-service"
    assert provider.instance_policy == "multiple" and provider.max_instances is None
    assert "nothing installed in OpenCode" in provider.description


def test_config_schema_is_service_shaped() -> None:
    schema = OpenCodeProvider()._config_schema()
    properties = schema.schema["properties"]
    assert schema.revision == 2
    assert properties["stateDir"]["type"] == "string"
    assert "registryDir" not in properties, "the bridge registry is gone"
    assert "servicePid" in properties and "location" in properties
    assert schema.ui_schema["order"][0] == "stateDir"


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ({"stateDir": "relative/path"}, "stateDir must be an absolute path"),
        ({"servicePid": 0}, "servicePid"),
        ({"location": "not/absolute"}, "location must be an absolute path"),
    ],
)
def test_validate_config_rejects_bad_values(values: dict[str, Any], message: str) -> None:
    provider = provider_with(fake_discovery())

    async def scenario() -> None:
        await provider.validate_config({**provider_config.default_config_values(), **values})

    with pytest.raises(RuntimeInvalidRequestError, match=message):
        asyncio.run(scenario())


def test_validate_config_normalizes_paths_and_records_transport(tmp_path: Path) -> None:
    provider = provider_with(fake_discovery())
    target = str(tmp_path / "aa-state")

    async def scenario() -> Any:
        return await provider.validate_config({"stateDir": target, "location": target})

    config = asyncio.run(scenario())
    assert config.values["stateDir"] == canonical_path(target)
    assert config.metadata["transport"] == "service-http"
    assert config.metadata["readOnly"] is False


# ------------------------------------------------------------- discovery output


def test_discover_derives_capabilities_from_reported_rows() -> None:
    provider = provider_with(fake_discovery())

    descriptor = asyncio.run(provider.discover())
    assert descriptor.available is True
    assert descriptor.capabilities["modelCatalog"] is True
    assert descriptor.capabilities["startTurn"] is True
    assert descriptor.capabilities["sessionDiscovery"] is True
    assert descriptor.metadata["transport"] == "service-http"
    assert descriptor.reason is None


def test_capabilities_are_never_hardcoded_when_the_runtime_cannot_do_them() -> None:
    # m3: discovery reports the row as unsupported -> the descriptor must not
    # claim the capability, even though the transport normally supports it.
    provider = provider_with(
        fake_discovery(
            metadata={
                "runtimeCapabilities": {
                    "capabilities": [
                        {"capabilityId": "catalog.model", "supported": False, "available": False, "allowed": False},
                        {"capabilityId": "session.discovery", "supported": False, "available": False, "allowed": False},
                    ]
                }
            }
        )
    )

    descriptor = asyncio.run(provider.discover())
    assert descriptor.capabilities["modelCatalog"] is False
    assert descriptor.capabilities["sessionDiscovery"] is False
    assert descriptor.capabilities["startTurn"] is False
    assert descriptor.metadata["readOnly"] is True


def test_the_real_capability_rows_survive_the_provider_derivation() -> None:
    # The fakes above hand-write `allowed`, which is exactly what hid the bug the
    # first live Hub round-trip found: rows without `supported`/`available`/
    # `allowed` read as "off" to `opencode_capabilities` while the attached
    # runtime still served them, so the descriptor advertised an OpenCode runtime
    # with no model catalog and no way to send a message.
    from connector.runtimes.opencode import provider_config
    from connector.runtimes.opencode.serve.runtime import capability_rows

    rows = capability_rows("/work/repo")
    capabilities = provider_config.opencode_capabilities({"capabilities": rows})
    for key in ("modelCatalog", "sessionDiscovery", "startTurn", "interruptTurn", "commands", "interactions", "sessionSnapshot"):
        assert capabilities.get(key) is True, (key, capabilities)
    for key in ("permissionCatalog", "steerTurn", "attachments"):
        assert capabilities[key] is False, key
    discovery = next(row for row in rows if row["capabilityId"] == "session.discovery")
    assert discovery["metadata"] == {"discoveryState": "complete"}
    unloaded = next(row for row in capability_rows("/work/repo", loaded=False) if row["capabilityId"] == "session.discovery")
    assert unloaded["available"] is False and unloaded["metadata"] == {"discoveryState": "partial"}
    assert "not loaded" in (unloaded["reason"] or "")


def test_unavailable_discovery_keeps_the_actionable_reason() -> None:
    provider = provider_with(fake_discovery(available=False, reason=serve_discovery.UNAVAILABLE_REASON))

    descriptor = asyncio.run(provider.discover())
    assert descriptor.available is False
    assert "opencode serve" in descriptor.reason


# ---------------------------------------------------------- instance identity


def test_claims_and_source_key_distinguish_instances(tmp_path: Path) -> None:
    provider = provider_with(fake_discovery())
    state = str(tmp_path / "state")
    proj_a = str(tmp_path / "proj-a")
    proj_b = str(tmp_path / "proj-b")

    async def build(values: dict[str, Any]) -> Any:
        return await provider.validate_config(values)

    base = asyncio.run(build({"stateDir": state}))
    pinned = asyncio.run(build({"stateDir": state, "servicePid": 4242, "location": proj_a}))
    other = asyncio.run(build({"stateDir": state, "servicePid": 4242, "location": proj_b}))

    base_claim = provider.resource_claims(base)[0]
    pinned_claim = provider.resource_claims(pinned)[0]
    other_claim = provider.resource_claims(other)[0]
    assert base_claim.kind == "opencode_service_registration"
    assert pinned_claim.key != base_claim.key
    assert pinned_claim.key != other_claim.key, "two locations must not collapse into one identity"
    assert "servicePid=4242" in pinned_claim.label or "servicePid=4242" in pinned_claim.key
    assert provider.session_source_key(pinned).key == pinned_claim.key
    assert "password" not in json.dumps([pinned_claim.key, pinned_claim.label])


def test_create_runtime_honours_the_state_directory(tmp_path: Path) -> None:
    provider = provider_with(fake_discovery())
    registration = tmp_path / "opencode" / "service.json"
    registration.parent.mkdir(parents=True)
    registration.write_text(
        json.dumps(
            {"id": "i", "version": "2.0.18", "url": "http://127.0.0.1:1", "pid": 7, "password": "pw"}
        ),
        encoding="utf-8",
    )

    async def scenario() -> Any:
        config = await provider.validate_config({"stateDir": str(tmp_path), "location": str(tmp_path)})
        host = type("H", (), {"connector_id": "c", "session_namespace": "ns"})()
        return await provider.create_runtime(config, host)

    runtime = asyncio.run(scenario())
    assert isinstance(runtime, OpenCodeServiceRuntime)
    found = runtime._service_reader()
    assert isinstance(found, OpenCodeService) and found.pid == 7


# ------------------------------------------------------- serve-side discovery


def service(tmp_path: Path, **overrides: Any) -> OpenCodeService:
    payload = {"id": "i", "version": "2.0.18", "url": "http://127.0.0.1:49374", "pid": 18772, "password": "pw"}
    payload.update(overrides)
    target = tmp_path / "opencode" / "service.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload), encoding="utf-8")
    return OpenCodeService(
        url=payload["url"], pid=payload["pid"], version=payload["version"], password=payload["password"], path=target
    )


def client_returning(tmp_path: Path, info: dict[str, Any]) -> Any:
    registered = service(tmp_path)

    def factory(item: OpenCodeService) -> OpenCodeServerClient:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/info"
            return httpx.Response(200, json=info)

        return OpenCodeServerClient(item or registered, transport=httpx.MockTransport(handler))

    return factory


def test_discovery_reports_available_on_a_matching_service(tmp_path: Path) -> None:
    registered = service(tmp_path)
    factory = client_returning(tmp_path, {"version": "2.0.18", "pid": 18772, "urls": [], "paths": {"tmp": "T"}})

    result = asyncio.run(
        serve_discovery.discover({"location": DIRECTORY}, service_reader=lambda: registered, client_factory=factory)
    )
    assert result.available is True and result.configured is True
    assert result.metadata["serviceVersion"] == "2.0.18"
    assert "password" not in json.dumps(result.metadata)
    rows = result.metadata["runtimeCapabilities"]["capabilities"]
    discovery_row = next(row for row in rows if row["capabilityId"] == "session.discovery")
    assert discovery_row["metadata"]["discoveryState"] == "complete"


def test_discovery_calls_a_stale_registration_stale(tmp_path: Path) -> None:
    registered = service(tmp_path)
    factory = client_returning(tmp_path, {"version": "2.0.18", "pid": 999, "urls": [], "paths": {"tmp": "T"}})

    result = asyncio.run(
        serve_discovery.discover({}, service_reader=lambda: registered, client_factory=factory)
    )
    assert result.available is False
    assert result.reason == serve_discovery.STALE_REASON


def test_discovery_without_any_registration_is_unavailable(tmp_path: Path) -> None:
    result = asyncio.run(serve_discovery.discover({"location": DIRECTORY}, service_reader=lambda: None))
    assert result.available is False and result.configured is True
    assert result.reason == serve_discovery.UNAVAILABLE_REASON
    # Capabilities are still reported so the descriptor stays derivable.
    assert any(row["capabilityId"] == "catalog.model" for row in result.metadata["runtimeCapabilities"]["capabilities"])


def test_discovery_marks_partial_without_a_location(tmp_path: Path) -> None:
    registered = service(tmp_path)
    factory = client_returning(tmp_path, {"version": "2.0.18", "pid": 18772, "urls": [], "paths": {"tmp": "T"}})

    result = asyncio.run(serve_discovery.discover({}, service_reader=lambda: registered, client_factory=factory))
    rows = result.metadata["runtimeCapabilities"]["capabilities"]
    discovery_row = next(row for row in rows if row["capabilityId"] == "session.discovery")
    assert discovery_row["metadata"]["discoveryState"] == "partial"
    assert discovery_row["available"] is False


# ------------------------------------------------- the four review findings
#
# Every discovery test above injects `service_reader`, which is exactly how
# "discovery ignores stateDir" stayed invisible: the injected reader bypasses
# the path the config names. These tests go through the real default path.


def test_discovery_reads_the_registration_from_the_configured_state_dir(tmp_path: Path) -> None:
    # A custom stateDir is the documented way to point at another OpenCode's
    # registration; discovery must read it from there, not from ~/.local/state.
    service(tmp_path)
    factory = client_returning(tmp_path, {"version": "2.0.18", "pid": 18772, "urls": [], "paths": {"tmp": "T"}})

    result = asyncio.run(
        serve_discovery.discover({"stateDir": str(tmp_path), "location": DIRECTORY}, client_factory=factory)
    )
    assert result.available is True, result.reason
    assert result.metadata["servicePid"] == 18772


def test_a_state_dir_naming_the_registration_directory_itself_is_found(
    tmp_path: Path,
) -> None:
    # "stateDir" reads as the XDG state home and as the directory holding
    # service.json. OpenCode writes the former layout, but pointing at either one
    # must find the same registration, or a correct-looking config silently means
    # "no OpenCode here".
    payload = {
        "id": "i",
        "version": "2.0.18",
        "url": "http://127.0.0.1:49374",
        "pid": 18772,
        "password": "pw",
    }
    (tmp_path / "service.json").write_text(json.dumps(payload), encoding="utf-8")

    def factory(item: OpenCodeService) -> OpenCodeServerClient:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/info"
            return httpx.Response(
                200, json={"version": "2.0.18", "pid": item.pid, "urls": [], "paths": {"tmp": "T"}}
            )

        return OpenCodeServerClient(item, transport=httpx.MockTransport(handler))

    result = asyncio.run(
        serve_discovery.discover(
            {"stateDir": str(tmp_path), "location": DIRECTORY}, client_factory=factory
        )
    )
    assert result.available is True, result.reason
    assert result.metadata["servicePid"] == 18772


def test_registry_dir_always_points_at_the_opencode_subdirectory(tmp_path: Path) -> None:
    # `stateDir` is the XDG state home: both branches must append `opencode`,
    # or a configured value silently means something different from the default.
    configured = provider_config.registry_dir({"stateDir": str(tmp_path)})
    default = provider_config.registry_dir({})
    assert configured == Path(canonical_path(tmp_path / "opencode"))
    assert default.name == "opencode"


def test_a_pinned_service_pid_that_does_not_match_is_refused(tmp_path: Path) -> None:
    # The pin exists so one instance drives one OpenCode process. Reading whoever
    # happens to be registered turns the pin into decoration.
    service(tmp_path)
    factory = client_returning(tmp_path, {"version": "2.0.18", "pid": 18772, "urls": [], "paths": {"tmp": "T"}})

    result = asyncio.run(
        serve_discovery.discover(
            {"stateDir": str(tmp_path), "servicePid": 99999, "location": DIRECTORY}, client_factory=factory
        )
    )
    assert result.available is False
    assert "99999" in (result.reason or "") and "18772" in (result.reason or "")
    assert result.metadata["pinnedPid"] == 99999 and result.metadata["registeredPid"] == 18772
