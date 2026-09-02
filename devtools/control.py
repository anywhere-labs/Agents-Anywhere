from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
LOCAL_DIR = Path(
    os.environ.get("AGENTS_ANYWHERE_LOCAL_DIR", str(ROOT / ".local-dev"))
).expanduser()
LOG_DIR = LOCAL_DIR / "logs"
LOCAL_UP_PID_FILE = LOCAL_DIR / "run" / "local-up.pid"
CONNECTOR_CONFIG = LOCAL_DIR / "connector-source.json"
COMPOSE_FILE = ROOT / "docker" / "docker-compose.local.yml"
HTML_FILE = Path(__file__).with_name("index.html")

LEGACY_STACK_SESSION = "aa-local-stack"
LEGACY_CONNECTOR_SESSION = "aa-source-connector"
SERVER_SESSION = "aa-dev-server"
WEB_SESSION = "aa-dev-web"
CONNECTOR_SESSION = "aa-dev-connector"

SERVER_PORT = 8000
WEB_PORT = 5174
POSTGRES_PORT = 55432
REDIS_PORT = 56379
CONTROL_PORT = 8765
LISTEN_HOST = os.environ.get("AGENTS_ANYWHERE_LISTEN_HOST", "0.0.0.0")

SERVER_URL = f"http://127.0.0.1:{SERVER_PORT}"
WEB_URL = f"http://127.0.0.1:{WEB_PORT}"
POSTGRES_PASSWORD = os.environ.get(
    "POSTGRES_PASSWORD", "agents_anywhere_dev_password"
)
DB_URL = os.environ.get(
    "AGENT_SERVER_DB_URL",
    f"postgresql+asyncpg://agents_anywhere:{POSTGRES_PASSWORD}"
    f"@127.0.0.1:{POSTGRES_PORT}/agents_anywhere",
)
REDIS_URL = os.environ.get(
    "AGENT_SERVER_REDIS_URL", f"redis://127.0.0.1:{REDIS_PORT}/0"
)

_SCREEN_RE = re.compile(r"\s*\d+\.([^\s]+)")
_SENSITIVE_ENV_RE = re.compile(
    r"(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)",
    re.IGNORECASE,
)
_URL_USERINFO_RE = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s]+@")
_RESTART_LOCK = threading.Lock()


class DevControlError(RuntimeError):
    pass


def decode_connector_credential(raw: str) -> dict[str, str]:
    encoded = "".join(raw.split())
    if not encoded or len(encoded) > 16_384:
        raise DevControlError("Connector credential is empty or too large")
    encoded += "=" * (-len(encoded) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DevControlError("Invalid Connector credential") from exc
    if not isinstance(payload, dict):
        raise DevControlError("Invalid Connector credential payload")
    if payload.get("type") != "agents-anywhere.connector-credentials":
        raise DevControlError("Unsupported Connector credential type")
    if payload.get("version") != 1:
        raise DevControlError("Unsupported Connector credential version")

    values: dict[str, str] = {}
    for source, target in (
        ("serverUrl", "serverUrl"),
        ("connectorId", "connectorId"),
        ("connectorToken", "connectorToken"),
    ):
        value = payload.get(source)
        if not isinstance(value, str) or not value.strip():
            raise DevControlError(f"Connector credential is missing {source}")
        values[target] = value.strip()

    parsed_url = urlsplit(values["serverUrl"])
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
        raise DevControlError("Connector credential has an invalid serverUrl")
    if parsed_url.username or parsed_url.password:
        raise DevControlError("Connector serverUrl must not contain user info")
    return values


def save_connector_credential(raw: str, path: Path = CONNECTOR_CONFIG) -> None:
    payload = decode_connector_credential(raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, separators=(",", ":"))
            stream.write("\n")
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def _run(
    command: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=90,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise DevControlError(f"Command timed out: {command[0]}") from exc
    if check and result.returncode != 0:
        detail = _redact_command_output(result.stdout.strip(), env=env)
        summary = f"{Path(command[0]).name} exited with status {result.returncode}"
        raise DevControlError(f"{summary}:\n{detail}" if detail else summary)
    return result


def _redact_command_output(output: str, *, env: dict[str, str] | None) -> str:
    redacted = _URL_USERINFO_RE.sub(r"\1<redacted>@", output)
    effective_env = os.environ if env is None else env
    for name, value in effective_env.items():
        if _SENSITIVE_ENV_RE.search(name) and len(value) >= 4:
            redacted = redacted.replace(value, "<redacted>")
    return redacted


def screen_sessions() -> set[str]:
    result = _run(["screen", "-ls"], check=False)
    return {
        match.group(1)
        for line in result.stdout.splitlines()
        if (match := _SCREEN_RE.match(line)) is not None
    }


def _wait_until(predicate: Any, *, timeout: float, message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise DevControlError(message)


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def _listener_pids(port: int) -> set[int]:
    result = _run(
        ["lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
        check=False,
    )
    return {int(line) for line in result.stdout.splitlines() if line.isdigit()}


def _matching_process_pids(pattern: str) -> set[int]:
    result = _run(["pgrep", "-f", pattern], check=False)
    return {int(line) for line in result.stdout.splitlines() if line.isdigit()}


def _process_command(pid: int) -> str:
    result = _run(["ps", "-p", str(pid), "-o", "command="], check=False)
    return result.stdout.strip()


def _process_cwd(pid: int) -> Path | None:
    result = _run(
        ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
        check=False,
    )
    for line in result.stdout.splitlines():
        if line.startswith("n"):
            return Path(line[1:]).resolve()
    return None


def local_up_running() -> bool:
    """Return whether the foreground local-up launcher owns this checkout.

    ``local-up.sh`` intentionally stays in the foreground and owns the child
    Server/Web processes. Dev Control may still expose status while it is
    running, but must never terminate or replace that process tree.
    """

    try:
        pid = int(LOCAL_UP_PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    if pid <= 0 or pid == os.getpid():
        return False

    command = _process_command(pid)
    process_cwd = _process_cwd(pid)
    running = process_cwd == ROOT.resolve() and "local-up.sh" in command
    if not running:
        try:
            LOCAL_UP_PID_FILE.unlink()
        except OSError:
            pass
    return running


def _ensure_stack_not_owned_by_local_up(action: str) -> None:
    if local_up_running():
        raise DevControlError(
            "local-up.sh owns the foreground stack; stop it with Ctrl-C "
            f"before {action}"
        )


def _process_is_owned(
    pid: int,
    *,
    cwd: Path,
    command_markers: tuple[str, ...],
) -> bool:
    process_cwd = _process_cwd(pid)
    command = _process_command(pid)
    return (
        process_cwd == cwd.resolve()
        and all(marker in command for marker in command_markers)
    )


def _process_group_ids(pids: set[int]) -> set[int]:
    groups: set[int] = set()
    for pid in pids:
        try:
            groups.add(os.getpgid(pid))
        except ProcessLookupError:
            continue
    return groups


def _process_group_exists(group_id: int) -> bool:
    try:
        os.killpg(group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _terminate_process_groups(pids: set[int], *, name: str) -> None:
    groups = _process_group_ids(pids)
    if not groups:
        return
    if os.getpgrp() in groups:
        raise DevControlError(f"Refusing to stop the Dev Control process group for {name}")

    for group_id in groups:
        try:
            os.killpg(group_id, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError as exc:
            raise DevControlError(f"Permission denied stopping {name}") from exc

    try:
        _wait_until(
            lambda: not any(_process_group_exists(group_id) for group_id in groups),
            timeout=5,
            message=f"Timed out stopping {name}",
        )
        return
    except DevControlError:
        pass

    for group_id in groups:
        try:
            os.killpg(group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError as exc:
            raise DevControlError(f"Permission denied stopping {name}") from exc
    _wait_until(
        lambda: not any(_process_group_exists(group_id) for group_id in groups),
        timeout=5,
        message=f"Timed out force-stopping {name}",
    )


def _stop_port_processes(
    *,
    name: str,
    port: int,
    cwd: Path,
    command_markers: tuple[str, ...],
) -> None:
    if not port_open(port):
        return
    pids = _listener_pids(port)
    if not pids:
        raise DevControlError(f"Could not identify the process using {name} port {port}")
    if any(
        not _process_is_owned(pid, cwd=cwd, command_markers=command_markers)
        for pid in pids
    ):
        raise DevControlError(
            f"{name} port {port} is owned by a process outside this checkout"
        )
    _terminate_process_groups(pids, name=name)
    _wait_until(
        lambda: not port_open(port),
        timeout=10,
        message=f"{name} port {port} was not released",
    )


def _stop_server_processes() -> None:
    _stop_port_processes(
        name="Server",
        port=SERVER_PORT,
        cwd=ROOT / "server",
        command_markers=("uvicorn", "agent_server.app:create_app"),
    )


def _stop_web_processes() -> None:
    _stop_port_processes(
        name="Web",
        port=WEB_PORT,
        cwd=ROOT / "web-next",
        command_markers=("next",),
    )


def _connector_process_pids() -> set[int]:
    return _matching_process_pids("[a]nywhere-cli start|[c]onnector\\.cli start")


def connector_process_running() -> bool:
    return bool(_connector_process_pids())


def _health_ok() -> bool:
    try:
        with urlopen(f"{SERVER_URL}/api/v2/health", timeout=0.5) as response:
            return response.status == HTTPStatus.OK
    except OSError:
        return False


def stop_screen(name: str) -> None:
    if name not in screen_sessions():
        return
    _run(["screen", "-S", name, "-X", "quit"], check=False)
    _wait_until(
        lambda: name not in screen_sessions(),
        timeout=10,
        message=f"Timed out stopping {name}",
    )


def stop_server() -> None:
    _ensure_stack_not_owned_by_local_up("asking Dev Control to manage local services")
    stop_screen(SERVER_SESSION)
    _stop_server_processes()


def stop_web() -> None:
    _ensure_stack_not_owned_by_local_up("asking Dev Control to manage local services")
    stop_screen(WEB_SESSION)
    _stop_web_processes()


def stop_connector() -> None:
    _ensure_stack_not_owned_by_local_up("asking Dev Control to manage local services")
    stop_screen(LEGACY_CONNECTOR_SESSION)
    stop_screen(CONNECTOR_SESSION)

    candidates = _connector_process_pids()
    if not candidates:
        return
    connector_cwd = ROOT / "connector"
    owned = {
        pid
        for pid in candidates
        if _process_cwd(pid) == connector_cwd.resolve()
        and (
            "connector.cli start" in _process_command(pid)
            or "anywhere-cli start" in _process_command(pid)
        )
    }
    candidate_groups = _process_group_ids(candidates)
    owned_groups = _process_group_ids(owned)
    if candidate_groups - owned_groups:
        raise DevControlError(
            "A Connector process outside this checkout is still running"
        )
    _terminate_process_groups(owned, name="Connector")
    _wait_until(
        lambda: not _connector_process_pids(),
        timeout=10,
        message="Connector process was not released",
    )


def _screen_command(cwd: Path, command: list[str], log_path: Path) -> str:
    return (
        f"cd {shlex.quote(str(cwd))} && exec {shlex.join(command)} "
        f">> {shlex.quote(str(log_path))} 2>&1"
    )


def start_screen(
    name: str,
    *,
    cwd: Path,
    command: list[str],
    log_name: str,
) -> None:
    if name in screen_sessions():
        raise DevControlError(f"screen session already exists: {name}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / log_name
    log_path.write_text("", encoding="utf-8")
    shell_command = _screen_command(cwd, command, log_path)
    _run(["screen", "-dmS", name, "bash", "-c", shell_command])


def ensure_infrastructure() -> None:
    docker_status = _run(["docker", "info"], check=False)
    if docker_status.returncode != 0:
        raise DevControlError(
            "Docker is not running. Start Docker before starting local services"
        )
    environment = os.environ.copy()
    environment.update(
        {
            "AGENTS_ANYWHERE_POSTGRES_PORT": str(POSTGRES_PORT),
            "AGENTS_ANYWHERE_REDIS_PORT": str(REDIS_PORT),
            "POSTGRES_PASSWORD": POSTGRES_PASSWORD,
        }
    )
    _run(
        ["docker", "compose", "-f", str(COMPOSE_FILE), "up", "-d", "--wait"],
        env=environment,
    )


def _server_environment() -> dict[str, str]:
    return {
        "AGENT_SERVER_DB_BACKEND": "postgres",
        "AGENT_SERVER_DB_URL": DB_URL,
        "AGENT_SERVER_REDIS_URL": REDIS_URL,
        "AGENT_SERVER_FILES_LOCAL_ROOT": str(LOCAL_DIR / "files"),
        "AGENT_SERVER_PUBLIC_ORIGIN": WEB_URL,
        "AGENT_SERVER_CORS_ORIGINS": f"{WEB_URL},http://localhost:{WEB_PORT}",
    }


def run_migrations() -> None:
    environment = os.environ.copy()
    environment.update(_server_environment())
    _run(
        [
            str(ROOT / "server" / ".venv" / "bin" / "python"),
            "-m",
            "agent_server.infra.db.migrations",
            "upgrade",
        ],
        cwd=ROOT / "server",
        env=environment,
    )


def start_server() -> None:
    if port_open(SERVER_PORT):
        raise DevControlError(f"Server port {SERVER_PORT} is already in use")
    environment = _server_environment()
    command = ["env", *(f"{key}={value}" for key, value in environment.items())]
    command.extend(
        [
            str(ROOT / "server" / ".venv" / "bin" / "uvicorn"),
            "agent_server.app:create_app",
            "--factory",
            "--host",
            LISTEN_HOST,
            "--port",
            str(SERVER_PORT),
        ]
    )
    start_screen(
        SERVER_SESSION,
        cwd=ROOT / "server",
        command=command,
        log_name="server.log",
    )
    _wait_until(_health_ok, timeout=30, message="Server did not become healthy")


def start_web() -> None:
    if port_open(WEB_PORT):
        return
    start_screen(
        WEB_SESSION,
        cwd=ROOT / "web-next",
        command=[
            "env",
            f"AGENTS_ANYWHERE_API={SERVER_URL}",
            "corepack",
            "yarn",
            "exec",
            "next",
            "dev",
            "--hostname",
            LISTEN_HOST,
            "--port",
            str(WEB_PORT),
        ],
        log_name="web.log",
    )
    _wait_until(
        lambda: port_open(WEB_PORT),
        timeout=30,
        message="Web did not become ready",
    )


def start_connector() -> None:
    if not CONNECTOR_CONFIG.is_file():
        raise DevControlError("Paste a Connector credential before restarting")
    start_screen(
        CONNECTOR_SESSION,
        cwd=ROOT / "connector",
        command=[
            str(ROOT / "connector" / ".venv" / "bin" / "python"),
            "-m",
            "connector.cli",
            "start",
            "--config",
            str(CONNECTOR_CONFIG),
        ],
        log_name="connector.log",
    )

    def connector_ready() -> bool:
        if CONNECTOR_SESSION not in screen_sessions():
            return False
        log_path = LOG_DIR / "connector.log"
        if not log_path.is_file():
            return False
        return "connector startup complete" in log_path.read_text(
            encoding="utf-8", errors="replace"
        )

    _wait_until(
        connector_ready,
        timeout=30,
        message="Connector did not complete startup; check connector.log",
    )


def ensure_split_layout() -> bool:
    _ensure_stack_not_owned_by_local_up("asking Dev Control to manage local services")
    sessions = screen_sessions()
    legacy_stack = LEGACY_STACK_SESSION in sessions
    unmanaged_server = port_open(SERVER_PORT) and SERVER_SESSION not in sessions
    unmanaged_web = port_open(WEB_PORT) and WEB_SESSION not in sessions
    migrated = legacy_stack or unmanaged_server or unmanaged_web

    if legacy_stack:
        stop_screen(LEGACY_STACK_SESSION)
    if unmanaged_server:
        _stop_server_processes()
    if unmanaged_web:
        _stop_web_processes()

    ensure_infrastructure()
    if not _health_ok():
        stop_server()
        run_migrations()
        start_server()
    if not port_open(WEB_PORT):
        stop_web()
        start_web()
    return migrated


def restart_server() -> None:
    stop_server()
    ensure_infrastructure()
    run_migrations()
    start_server()
    if not port_open(WEB_PORT):
        start_web()


def restart_web() -> None:
    stop_web()
    start_web()


def restart_connector(credential: str | None = None) -> None:
    if credential:
        save_connector_credential(credential)
    stop_connector()
    start_connector()


def restart_all(credential: str | None = None) -> None:
    restart_server()
    if credential or CONNECTOR_CONFIG.is_file():
        restart_connector(credential)


def bootstrap() -> None:
    _ensure_stack_not_owned_by_local_up("starting the detached development stack")
    stop_screen(LEGACY_STACK_SESSION)
    stop_server()
    stop_web()
    ensure_infrastructure()
    run_migrations()
    start_server()
    start_web()


def stop_all() -> None:
    _ensure_stack_not_owned_by_local_up("stopping local services")
    stop_connector()
    stop_web()
    stop_server()


def status_payload() -> dict[str, Any]:
    sessions = screen_sessions()
    lan_ipv4 = discover_lan_ipv4()
    local_up = local_up_running()
    return {
        "server": _health_ok(),
        "web": port_open(WEB_PORT),
        "connector": connector_process_running(),
        "postgres": port_open(POSTGRES_PORT),
        "redis": port_open(REDIS_PORT),
        "legacy": LEGACY_STACK_SESSION in sessions,
        "localUp": local_up,
        "serverUrl": SERVER_URL,
        "webUrl": WEB_URL,
        "androidOauthLoginUrl": (
            f"http://{lan_ipv4}:{WEB_PORT}" if lan_ipv4 is not None else None
        ),
        "controlUrl": f"http://127.0.0.1:{CONTROL_PORT}",
    }


def discover_lan_ipv4() -> str | None:
    candidates: list[str] = []
    if os.uname().sysname == "Darwin":
        route_result = _run(["route", "-n", "get", "default"], check=False)
        default_interface = next(
            (
                line.split(":", 1)[1].strip()
                for line in route_result.stdout.splitlines()
                if line.strip().startswith("interface:")
            ),
            None,
        )
        if default_interface:
            address_result = _run(
                ["ipconfig", "getifaddr", default_interface],
                check=False,
            )
            if address_result.returncode == 0:
                candidates.append(address_result.stdout.strip())

    route_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        route_socket.connect(("192.0.2.1", 9))
        candidates.append(route_socket.getsockname()[0])
    except OSError:
        pass
    finally:
        route_socket.close()

    try:
        candidates.extend(
            address[4][0]
            for address in socket.getaddrinfo(
                socket.gethostname(),
                None,
                family=socket.AF_INET,
                type=socket.SOCK_DGRAM,
            )
        )
    except OSError:
        pass

    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if isinstance(address, ipaddress.IPv4Address) and not (
            address.is_loopback or address.is_unspecified or address.is_link_local
        ):
            return str(address)
    return None


def perform_restart(target: str, credential: str | None = None) -> None:
    with _RESTART_LOCK:
        if target == "server":
            restart_server()
        elif target == "web":
            restart_web()
        elif target == "connector":
            restart_connector(credential)
        elif target == "all":
            restart_all(credential)
        else:
            raise DevControlError(f"Unsupported restart target: {target}")


class DevControlHandler(BaseHTTPRequestHandler):
    server_version = "AgentsAnywhereDevControl/1"

    def do_GET(self) -> None:  # noqa: N802
        if not self._request_allowed():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if self.path == "/":
            self._send_bytes(HTML_FILE.read_bytes(), "text/html; charset=utf-8")
            return
        if self.path == "/api/status":
            self._send_json(status_payload())
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if not self._request_allowed(check_origin=True):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if self.path != "/api/restart":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 32_768:
                raise DevControlError("Invalid request size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise DevControlError("Invalid request payload")
            target = payload.get("target")
            credential = payload.get("credential")
            if not isinstance(target, str):
                raise DevControlError("Missing restart target")
            if credential is not None and not isinstance(credential, str):
                raise DevControlError("Invalid Connector credential")
            perform_restart(target, credential.strip() if credential else None)
            self._send_json({"ok": True, "status": status_payload()})
        except (DevControlError, json.JSONDecodeError) as exc:
            self._send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception:
            self._send_json(
                {"ok": False, "error": "Unexpected development control error"},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _request_allowed(self, *, check_origin: bool = False) -> bool:
        host = self.headers.get("Host", "")
        hostname = urlsplit(f"//{host}").hostname
        if hostname not in {"127.0.0.1", "localhost"}:
            return False
        if not check_origin:
            return True
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).hostname in {"127.0.0.1", "localhost"}

    def _send_json(
        self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK
    ) -> None:
        self._send_bytes(
            json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
        )

    def _send_bytes(
        self,
        payload: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        )
        self.end_headers()
        self.wfile.write(payload)


def serve(host: str, port: int) -> None:
    if host not in {"127.0.0.1", "localhost"}:
        raise DevControlError("Dev Control may only listen on localhost")
    server = ThreadingHTTPServer((host, port), DevControlHandler)
    print(f"Agents Anywhere Dev Control: http://{host}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agents Anywhere dev process control")
    subparsers = parser.add_subparsers(dest="command")
    serve_parser = subparsers.add_parser("serve")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=CONTROL_PORT)
    subparsers.add_parser("bootstrap")
    restart_parser = subparsers.add_parser("restart")
    restart_parser.add_argument(
        "target", choices=("server", "web", "connector", "all")
    )
    stop_parser = subparsers.add_parser("stop")
    stop_parser.add_argument("target", choices=("server", "web", "connector", "all"))
    subparsers.add_parser("status")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command in {None, "serve"}:
        serve(
            getattr(args, "host", "127.0.0.1"),
            getattr(args, "port", CONTROL_PORT),
        )
    elif args.command == "bootstrap":
        bootstrap()
    elif args.command == "restart":
        perform_restart(args.target)
        print(json.dumps(status_payload(), ensure_ascii=False))
    elif args.command == "stop":
        if args.target == "server":
            stop_server()
        elif args.target == "web":
            stop_web()
        elif args.target == "connector":
            stop_connector()
        else:
            stop_all()
    elif args.command == "status":
        print(json.dumps(status_payload(), ensure_ascii=False))


def run_cli() -> None:
    try:
        main()
    except DevControlError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    run_cli()
