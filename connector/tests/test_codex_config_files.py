from __future__ import annotations

import os
import stat
import tomllib
from pathlib import Path

import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.codex.sdk.config_files import persist_codex_model_gateway
from connector.runtimes.model_gateway import ModelGateway


def test_persist_appends_gateway_and_preserves_existing_config(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    original = (
        "[features]\n"
        "enable_experimental_windows_sandbox = true\n"
        "\n"
        "[model_providers.other]\n"
        'name = "Other Provider"\n'
        'base_url = "https://other.example/v1"\n'
    )
    config_path.write_text(original, encoding="utf-8")

    persist_codex_model_gateway(
        str(tmp_path),
        ModelGateway(
            base_url="https://gateway.example/v1",
            api_key="gateway-secret",
        ),
    )

    contents = config_path.read_text(encoding="utf-8")
    parsed = tomllib.loads(contents)
    assert parsed["features"] == {"enable_experimental_windows_sandbox": True}
    assert parsed["model_providers"]["other"] == {
        "name": "Other Provider",
        "base_url": "https://other.example/v1",
    }
    assert parsed["model_providers"]["agents_anywhere_gateway"] == {
        "name": "Agents Anywhere Model Gateway",
        "base_url": "https://gateway.example/v1",
        "wire_api": "responses",
        "requires_openai_auth": False,
        "experimental_bearer_token": "gateway-secret",
    }
    assert "Managed by Agents Anywhere" in contents
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600

    backups = list(tmp_path.glob("config.toml.backup.*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == original


def test_persist_updates_only_the_managed_gateway_table(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "# Managed by Agents Anywhere; updated whenever the Codex runtime starts.\n"
        "[model_providers.agents_anywhere_gateway]\n"
        'name = "Agents Anywhere Model Gateway"\n'
        'base_url = "https://old.example/v1"\n'
        'wire_api = "responses"\n'
        "requires_openai_auth = false\n"
        'experimental_bearer_token = "old-secret"\n'
        "\n"
        "[features]\n"
        "enabled = true\n",
        encoding="utf-8",
    )

    persist_codex_model_gateway(
        str(tmp_path),
        ModelGateway(
            base_url="https://new.example/v1",
            api_key="new-secret",
        ),
    )

    contents = config_path.read_text(encoding="utf-8")
    parsed = tomllib.loads(contents)
    assert parsed["features"] == {"enabled": True}
    assert parsed["model_providers"]["agents_anywhere_gateway"][
        "base_url"
    ] == "https://new.example/v1"
    assert parsed["model_providers"]["agents_anywhere_gateway"][
        "experimental_bearer_token"
    ] == "new-secret"
    assert contents.count("[model_providers.agents_anywhere_gateway]") == 1


def test_persist_is_idempotent_after_first_write(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text("[features]\nenabled = true\n", encoding="utf-8")
    gateway = ModelGateway(
        base_url="https://gateway.example/v1",
        api_key="gateway-secret",
    )

    persist_codex_model_gateway(str(tmp_path), gateway)
    first_contents = config_path.read_text(encoding="utf-8")
    first_backups = len(list(tmp_path.glob("config.toml.backup.*")))

    persist_codex_model_gateway(str(tmp_path), gateway)

    assert config_path.read_text(encoding="utf-8") == first_contents
    assert len(list(tmp_path.glob("config.toml.backup.*"))) == first_backups


def test_persist_none_removes_only_the_managed_provider(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "# Managed by Agents Anywhere; updated whenever the Codex runtime starts.\n"
        "[model_providers.agents_anywhere_gateway]\n"
        'name = "Agents Anywhere Model Gateway"\n'
        'base_url = "https://gateway.example/v1"\n'
        'wire_api = "responses"\n'
        "requires_openai_auth = false\n"
        'experimental_bearer_token = "gateway-secret"\n'
        "\n"
        "[model_providers.user]\n"
        'name = "User Provider"\n'
        'base_url = "https://user.example/v1"\n',
        encoding="utf-8",
    )

    persist_codex_model_gateway(str(tmp_path), None)

    parsed = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert parsed["model_providers"] == {
        "user": {
            "name": "User Provider",
            "base_url": "https://user.example/v1",
        }
    }


def test_persist_none_leaves_unmanaged_provider_untouched(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    original = (
        "[model_providers.agents_anywhere_gateway]\n"
        'name = "User Defined"\n'
        'base_url = "https://user.example/v1"\n'
    )
    config_path.write_text(original, encoding="utf-8")

    persist_codex_model_gateway(str(tmp_path), None)

    assert config_path.read_text(encoding="utf-8") == original


def test_persist_rejects_invalid_toml_without_writing(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    original = "[broken\nvalue = 1\n"
    config_path.write_text(original, encoding="utf-8")

    with pytest.raises(RuntimeInvalidRequestError):
        persist_codex_model_gateway(
            str(tmp_path),
            ModelGateway(
                base_url="https://gateway.example/v1",
                api_key="gateway-secret",
            ),
        )

    assert config_path.read_text(encoding="utf-8") == original
    assert not list(tmp_path.glob("config.toml.backup.*"))


def test_persist_escapes_gateway_strings_for_toml(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    gateway = ModelGateway(
        base_url='https://gateway.example/v1?label="quoted"&path=\\segment',
        api_key='key "quoted" \\ tab\t value',
    )

    persist_codex_model_gateway(str(tmp_path), gateway)

    parsed = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert parsed["model_providers"]["agents_anywhere_gateway"] == {
        "name": "Agents Anywhere Model Gateway",
        "base_url": gateway.base_url,
        "wire_api": "responses",
        "requires_openai_auth": False,
        "experimental_bearer_token": gateway.api_key,
    }


@pytest.mark.skipif(os.name == "nt", reason="POSIX file permissions")
def test_persist_uses_private_permissions(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text("[features]\n", encoding="utf-8")

    persist_codex_model_gateway(
        str(tmp_path),
        ModelGateway(
            base_url="https://gateway.example/v1",
            api_key="gateway-secret",
        ),
    )

    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
