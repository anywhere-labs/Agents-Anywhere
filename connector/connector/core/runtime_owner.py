"""Connector-owned, per-user startup exclusion and local identity history."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import psutil

from connector.core.json_rpc import JsonRpcError

if TYPE_CHECKING:
    from connector.core.config import ConnectorConfig


def system_home() -> Path:
    if sys.platform != "win32":
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    return Path.home()


def runtime_path(config_path: str | Path | None = None) -> Path:
    # Credentials may be relocated; the per-user mutex may not.
    return system_home() / ".agents-anywhere" / "connector-runtime.json"


@contextmanager
def state_lock(path: Path, timeout: float = 5) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = str(path.parent.resolve() / path.name)
    if sys.platform == "win32":
        identity = identity.lower()
    digest = hashlib.sha256(f"aa-machine-state-v1\n{identity}".encode()).digest()
    port = 49152 + int.from_bytes(digest[:2], "big") % 16384
    deadline = time.monotonic() + timeout
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as lease:
        if sys.platform == "win32":
            lease.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            lease.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        while True:
            try:
                lease.bind(("127.0.0.1", port))
                lease.listen()
                break
            except OSError as exc:
                if exc.errno not in {errno.EADDRINUSE, errno.EACCES}:
                    raise
                if time.monotonic() >= deadline:
                    raise RuntimeError("The local Connector record is busy. Please retry.") from exc
                time.sleep(0.02)
        yield


def _json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise RuntimeError("Cannot read the local Connector record. Check its format and permissions.") from exc
    if not isinstance(value, dict):
        raise RuntimeError("Invalid local Connector record.")
    return value


def _ids(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(v, str) or not v.strip() for v in value):
        raise RuntimeError("Invalid local Connector IDs.")
    return list(dict.fromkeys(v.strip() for v in value))


def _validate_owner(value: Any) -> dict[str, Any]:
    if (not isinstance(value, dict) or type(value.get("pid")) is not int or value["pid"] <= 0
            or not isinstance(value.get("kind"), str) or not isinstance(value.get("instanceId"), str)
            or not value["instanceId"] or not isinstance(value.get("startedAt"), str)
            or ("childPid" in value and (type(value["childPid"]) is not int or value["childPid"] <= 0))
            or any(key in value and not isinstance(value[key], str) for key in ("processStartedAt", "childStartedAt"))):
        raise RuntimeError("Invalid local Connector owner.")
    return value


def read_state(path: str | Path) -> dict[str, Any]:
    value = _json(Path(path))
    if value is None:
        return {"version": 2, "connectorIds": []}
    if "version" not in value and type(value.get("pid")) is int and isinstance(value.get("kind"), str):
        owner = _validate_owner({**value, "instanceId": f"legacy-{value['pid']}", "startedAt": value.get("startedAt", "")})
        return {"version": 2, "connectorIds": [value["connectorId"]] if value.get("connectorId") else [], "runtime": owner}
    if value.get("version") != 2:
        raise RuntimeError("Unsupported local Connector record version.")
    value["connectorIds"] = _ids(value.get("connectorIds"))
    if "runtime" in value:
        _validate_owner(value["runtime"])
    return value


def _write(path: Path, state: dict[str, Any]) -> None:
    contents = json.dumps(state, indent=2, ensure_ascii=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == contents:
        return
    temporary = path.with_name(f"{path.name}.{uuid.uuid4()}.tmp")
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def state_transaction(path: str | Path) -> Iterator[dict[str, Any]]:
    file = Path(path)
    with state_lock(file):
        state = read_state(file)
        if state.get("legacyMachineMigrated") is True:
            yield state
            _write(file, state)
            return
        legacy = file.parent.parent / ".agentsanywhere" / "machine.json"
        installation = legacy.parent / "desktop" / "install.json"
        with state_lock(legacy):
            machine, desktop = _json(legacy), _json(installation)
            if machine and machine.get("version") != 1:
                raise RuntimeError("Unsupported legacy machine record version.")
            if desktop and desktop.get("version") != 1:
                raise RuntimeError("Unsupported legacy installation record version.")
            if machine:
                state = {**machine, **state, "version": 2, "connectorIds": _ids([*_ids(machine.get("connectorIds")), *state["connectorIds"]])}
            if "desktop" not in state and desktop:
                state["desktop"] = desktop
            state["legacyMachineMigrated"] = True
            yield state
            _write(file, state)
            if machine:
                legacy.unlink()
            if desktop:
                installation.unlink()


def process_identity(pid: int) -> str | None:
    try:
        return f"unix:{psutil.Process(pid).create_time():.6f}"
    except psutil.NoSuchProcess:
        return None
    except psutil.AccessDenied as exc:
        raise RuntimeError("Cannot verify the Connector process. Check process inspection permissions.") from exc


def _legacy_process_identity(pid: int) -> str | None:
    command = (["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", f"(Get-Process -Id {pid}).StartTime.ToUniversalTime().Ticks"]
               if sys.platform == "win32" else ["ps", "-o", "lstart=", "-p", str(pid)])
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=2, env={**os.environ, "LC_ALL": "C", "TZ": "UTC"})
        return " ".join(result.stdout.split()) or None
    except (OSError, subprocess.SubprocessError):
        return None


def _connector_command(executable: str, arguments: list[str]) -> bool:
    """Recognize the running Connector entry point, not an app or uv parent."""
    name = Path(executable.replace("\\", "/")).name.lower()
    entry_points = {"anywhere-cli", "agent-connector", "anywhere-cli.exe", "agent-connector.exe"}
    if name in entry_points:
        return True
    if not name.startswith(("python", "pypy")):
        return False
    index = 1
    while index < len(arguments):
        argument = arguments[index]
        if argument == "-m":
            return index + 1 < len(arguments) and arguments[index + 1] in {"connector", "connector.cli"}
        if argument == "-c":
            return False
        if argument in {"-W", "-X"}:
            index += 2
            continue
        if argument.startswith("-"):
            index += 1
            continue
        script = argument.replace("\\", "/")
        return Path(script).name.lower() in entry_points or script.endswith("/connector/cli.py")
    return False


def _pid_alive(pid: int | None, identity: str | None = None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        process = psutil.Process(pid)
        if process.status() == psutil.STATUS_ZOMBIE:
            return False
        if identity:
            current = (f"unix:{process.create_time():.6f}" if identity.startswith("unix:")
                       else _legacy_process_identity(pid))
            if current is None:
                raise RuntimeError("Cannot verify the Connector process start time.")
            if identity != current:
                return False
        return _connector_command(process.exe(), process.cmdline()) and process.is_running()
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied as exc:
        raise RuntimeError("Cannot verify the Connector process. Check process inspection permissions.") from exc


def owner_alive(value: dict[str, Any]) -> bool:
    return _pid_alive(value["pid"], value.get("processStartedAt")) or _pid_alive(value.get("childPid"), value.get("childStartedAt"))


@dataclass(slots=True)
class RuntimeOwner:
    pid: int
    kind: str
    connector_id: str = ""
    server_url: str = ""
    started_at: str | None = None

    @classmethod
    def from_record(cls, value: dict[str, Any]) -> RuntimeOwner:
        pid = value["pid"]
        if value.get("childPid") and not _pid_alive(pid, value.get("processStartedAt")):
            pid = value["childPid"]
        return cls(pid, value["kind"], value.get("connectorId", ""), value.get("serverUrl", ""), value.get("startedAt"))


class ConnectorAlreadyRunningError(JsonRpcError):
    def __init__(self, owner: RuntimeOwner) -> None:
        super().__init__(
            -32009,
            f"Another Connector is running ({owner.kind}, PID {owner.pid}). Stop that Connector process, then retry.",
            {"reason": "connector_already_running", "owner": {"kind": owner.kind, "pid": owner.pid}},
        )
        self.owner = owner


class RuntimeLease:
    def __init__(self, path: str | Path | None = None, *, kind: str = "cli",
                 legacy_paths: list[Path] | None = None) -> None:
        self.path = Path(path) if path is not None else runtime_path()
        self.kind = kind
        self.instance_id = str(uuid.uuid4())
        self.acquired = False
        self.identity = process_identity(os.getpid())
        self.legacy_paths = legacy_paths or []

    def claim(self, config: ConnectorConfig | None = None) -> None:
        with state_transaction(self.path) as state:
            owner = state.get("runtime")
            if owner and owner["instanceId"] != self.instance_id and owner_alive(owner):
                raise ConnectorAlreadyRunningError(RuntimeOwner.from_record(owner))
            for legacy in self.legacy_paths:
                if legacy.resolve() == self.path.resolve():
                    continue
                previous = read_state(legacy).get("runtime")
                if previous and owner_alive(previous):
                    raise ConnectorAlreadyRunningError(RuntimeOwner.from_record(previous))
            if not owner or owner["instanceId"] != self.instance_id:
                owner = {"instanceId": self.instance_id, "pid": os.getpid(), "kind": self.kind, "startedAt": datetime.now(UTC).isoformat()}
                if self.identity:
                    owner["processStartedAt"] = self.identity
            state["runtime"] = owner
            if config:
                owner.update(connectorId=config.connector_id, serverUrl=config.server_url)
                state["connectorIds"] = _ids([*state["connectorIds"], config.connector_id])
        self.acquired = True

    def release(self) -> None:
        if not self.acquired:
            return
        with state_transaction(self.path) as state:
            owner = state.get("runtime")
            if not owner or owner["instanceId"] != self.instance_id:
                return
            state.pop("runtime", None)
        self.acquired = False


def read_runtime(path: str | Path) -> RuntimeOwner | None:
    owner = read_state(path).get("runtime")
    return RuntimeOwner.from_record(owner) if owner else None
