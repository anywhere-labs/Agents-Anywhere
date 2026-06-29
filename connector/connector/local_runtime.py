from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from connector.runtime import ConnectorConfig


@dataclass(slots=True)
class RuntimeOwner:
    pid: int
    kind: str
    connector_id: str
    server_url: str
    started_at: str | None = None


class ConnectorAlreadyRunningError(RuntimeError):
    def __init__(self, owner: RuntimeOwner) -> None:
        super().__init__(f"connector {owner.connector_id} is already running in {owner.kind} pid {owner.pid}")
        self.owner = owner


def runtime_path(config_path: str | Path | None = None) -> Path:
    base = Path(config_path) if config_path is not None else ConnectorConfig.default_path()
    return base.with_name("connector-runtime.json")


def read_runtime(path: str | Path) -> RuntimeOwner | None:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    pid = data.get("pid")
    kind = data.get("kind")
    connector_id = data.get("connectorId")
    server_url = data.get("serverUrl")
    if not isinstance(pid, int) or not isinstance(kind, str) or not isinstance(connector_id, str) or not isinstance(server_url, str):
        return None
    return RuntimeOwner(
        pid=pid,
        kind=kind,
        connector_id=connector_id,
        server_url=server_url,
        started_at=data.get("startedAt") if isinstance(data.get("startedAt"), str) else None,
    )


def assert_can_start(path: str | Path, config: ConnectorConfig, *, current_pid: int | None = None) -> None:
    owner = read_runtime(path)
    if owner is None:
        return
    if current_pid is not None and owner.pid == current_pid:
        return
    if not _pid_alive(owner.pid):
        clear_runtime(path)
        return
    raise ConnectorAlreadyRunningError(owner)


def write_runtime(path: str | Path, config: ConnectorConfig, *, kind: str, pid: int | None = None) -> Path:
    import datetime as _dt

    runtime_file = Path(path)
    runtime_file.parent.mkdir(parents=True, exist_ok=True)
    runtime_file.write_text(
        json.dumps(
            {
                "pid": int(pid if pid is not None else os.getpid()),
                "kind": kind,
                "connectorId": config.connector_id,
                "serverUrl": config.server_url,
                "startedAt": _dt.datetime.now(_dt.UTC).isoformat(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        runtime_file.chmod(0o600)
    except OSError:
        pass
    return runtime_file


def clear_runtime(path: str | Path, *, pid: int | None = None) -> None:
    runtime_file = Path(path)
    if pid is not None:
        owner = read_runtime(runtime_file)
        if owner is not None and owner.pid != pid:
            return
    try:
        runtime_file.unlink()
    except FileNotFoundError:
        return
    except OSError:
        return


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        if sys.platform != "win32":
            return False
        return _windows_pid_alive(pid)
    return True


def _windows_pid_alive(pid: int) -> bool:
    try:
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        exit_code = wintypes.DWORD()
        try:
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == 259
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    except Exception:
        return False
