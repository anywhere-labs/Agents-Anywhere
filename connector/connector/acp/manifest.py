from __future__ import annotations

import json
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any, Literal


ProcessModel = Literal["shared", "per_session"]
CapabilityLevel = Literal["required", "optional", "unsupported"]


@dataclass(frozen=True, slots=True)
class AgentManifest:
    """Declarative description of one ACP-compatible agent binary."""

    id: str
    display_name: str
    transport: Literal["acp"] = "acp"
    command: tuple[str, ...] = ()
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    env_paths: tuple[str, ...] = ()
    which: tuple[str, ...] = ()
    version_args: tuple[str, ...] = ("--version",)
    process_model: ProcessModel = "shared"
    preferred_auth_method_ids: tuple[str, ...] = ()
    pre_auth_hint: str | None = None
    capabilities_expected: dict[str, CapabilityLevel] = field(default_factory=dict)
    client_fs_read: bool = True
    client_fs_write: bool = False
    client_terminal: bool = False
    quirks: dict[str, Any] = field(default_factory=dict)

    def launch_args(self) -> list[str]:
        return list(self.args)

    def client_capabilities(self) -> dict[str, Any]:
        return {
            "fs": {
                "readTextFile": self.client_fs_read,
                "writeTextFile": self.client_fs_write,
            },
            "terminal": self.client_terminal,
        }


def manifest_from_dict(raw: dict[str, Any]) -> AgentManifest:
    discovery = raw.get("discovery") if isinstance(raw.get("discovery"), dict) else {}
    auth = raw.get("auth") if isinstance(raw.get("auth"), dict) else {}
    client_caps = raw.get("clientCapabilities") if isinstance(raw.get("clientCapabilities"), dict) else {}
    fs_caps = client_caps.get("fs") if isinstance(client_caps.get("fs"), dict) else {}
    caps_expected = raw.get("capabilitiesExpected") if isinstance(raw.get("capabilitiesExpected"), dict) else {}
    command = raw.get("command") or []
    args = raw.get("args") or []
    if not isinstance(command, list) or not command:
        raise ValueError(f"manifest {raw.get('id')!r} needs non-empty command")
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        raise ValueError("manifest needs id")
    return AgentManifest(
        id=raw["id"],
        display_name=str(raw.get("displayName") or raw["id"]),
        transport="acp",
        command=tuple(str(part) for part in command),
        args=tuple(str(part) for part in args) if isinstance(args, list) else (),
        env={str(k): str(v) for k, v in (raw.get("env") or {}).items()}
        if isinstance(raw.get("env"), dict)
        else {},
        env_paths=tuple(str(x) for x in (discovery.get("envPaths") or []) if x),
        which=tuple(str(x) for x in (discovery.get("which") or []) if x),
        version_args=tuple(str(x) for x in (discovery.get("versionArgs") or ["--version"])),
        process_model="per_session" if discovery.get("processModel") == "per_session" or raw.get("processModel") == "per_session" else "shared",
        preferred_auth_method_ids=tuple(str(x) for x in (auth.get("preferredMethodIds") or []) if x),
        pre_auth_hint=str(auth["preAuthHint"]) if auth.get("preAuthHint") else None,
        capabilities_expected={
            str(k): _capability_level(v) for k, v in caps_expected.items()
        },
        client_fs_read=bool(fs_caps.get("readTextFile", True)),
        client_fs_write=bool(fs_caps.get("writeTextFile", False)),
        client_terminal=bool(client_caps.get("terminal", False)),
        quirks=dict(raw.get("quirks") or {}) if isinstance(raw.get("quirks"), dict) else {},
    )


def load_manifest_file(path: str | Path) -> AgentManifest:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"manifest file must be a JSON object: {path}")
    return manifest_from_dict(data)


def load_builtin_manifests() -> list[AgentManifest]:
    manifests: list[AgentManifest] = []
    package = resources.files("connector.acp.manifests")
    for entry in sorted(package.iterdir()):
        if not entry.name.endswith(".json"):
            continue
        with entry.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            manifests.append(manifest_from_dict(data))
    return manifests


def _capability_level(value: Any) -> CapabilityLevel:
    text = str(value or "optional")
    if text in {"required", "optional", "unsupported"}:
        return text  # type: ignore[return-value]
    return "optional"
