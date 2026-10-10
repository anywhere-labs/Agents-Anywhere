from __future__ import annotations

from pathlib import Path

import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.pi.config import (
    default_config_values,
    normalized_config_values,
    pi_config_schema,
)
from connector.runtimes.pi.provider import PiProvider, probe_pi_version


def test_schema_shape() -> None:
    schema = pi_config_schema()
    assert schema["type"] == "object"
    assert set(schema["properties"]) == {
        "executablePath",
        "sessionsDir",
        "defaultCwd",
        "requestTimeoutMs",
        "idleTimeoutSeconds",
        "permissionMode",
    }
    assert schema["additionalProperties"] is False


def test_normalized_defaults(tmp_path: Path) -> None:
    values = normalized_config_values({"sessionsDir": str(tmp_path / "sessions")})
    assert values["executablePath"] == "pi"
    assert values["sessionsDir"].startswith(str(tmp_path))
    assert values["requestTimeoutMs"] == default_config_values()["requestTimeoutMs"]
    assert values["idleTimeoutSeconds"] == default_config_values()["idleTimeoutSeconds"]


def test_normalized_rejects_bad_timeout() -> None:
    with pytest.raises(RuntimeInvalidRequestError):
        normalized_config_values({"requestTimeoutMs": 10})


async def test_probe_version(fake_pi: Path) -> None:
    assert await probe_pi_version("pi") == "9.9.9-fake"
    assert await probe_pi_version(str(fake_pi.parent / "missing")) is None


async def test_discover_available(fake_pi: Path) -> None:
    descriptor = await PiProvider().discover()
    assert descriptor.runtime_type == "pi"
    assert descriptor.available is True
    assert descriptor.capabilities["startTurn"] is True
    assert descriptor.capabilities["attachments"] is True
    assert descriptor.metadata["version"] == "9.9.9-fake"


async def test_validate_config(fake_pi: Path, tmp_path: Path) -> None:
    runtime_config = await PiProvider().validate_config({"sessionsDir": str(tmp_path / "sessions")})
    assert runtime_config.runtime == "pi"
    assert runtime_config.values["executablePath"] == "pi"
    with pytest.raises(RuntimeInvalidRequestError):
        await PiProvider().validate_config({"executablePath": "definitely-not-pi"})
