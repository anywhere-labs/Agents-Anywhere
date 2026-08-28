from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shlex
import socket
import subprocess
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
LOCAL_DIR = ROOT / ".local-dev"
LOG_DIR = LOCAL_DIR / "logs"
CONNECTOR_CONFIG = LOCAL_DIR / "connector-source.json"
COMPOSE_FILE = ROOT / "docker" / "docker-compose.local.yml"
HTML_FILE = Path(__file__).with_name("index.html")

LEGACY_STACK_SESSION = "aa-local-stack"
LEGACY_CONNECTOR_SESSION = "aa-source-connector"
SERVER_SESSION = "aa-dev-server"
WEB_SESSION = "aa-dev-web"
CONNECTOR_SESSION = "aa-dev-connector"

SERVER_PORT = int(os.environ.get("SERVER_PORT", "8001"))
WEB_PORT = int(os.environ.get("WEB_PORT", "5175"))
POSTGRES_PORT = int(os.environ.get("AGENTS_ANYWHERE_POSTGRES_PORT", "55432"))
REDIS_PORT = int(os.environ.get("AGENTS_ANYWHERE_REDIS_PORT", "56379"))

SERVER_URL = f"http://127.0.0.1:{SERVER_PORT}"
WEB_URL = f"http://127.0.0.1:{WEB_PORT}"
DB_URL = (
    "postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password"
    f"@127.0.0.1:{POSTGRES_PORT}/agents_anywhere"
)
REDIS_URL = f"redis://127.0.0.1:{REDIS_PORT}/0"

_SCREEN_RE = re.compile(r"\s*\d+\.([^\s]+)")
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
        detail = result.stdout.strip().splitlines()[-1:] or ["command failed"]
        raise DevControlError(detail[0])
    return result


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


def connector_process_running() -> bool:
    result = _run(
        ["pgrep", "-f", "[a]nywhere-cli start|[c]onnector\\.cli start"],
        check=False,
    )
    return result.returncode == 0


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
    _run(["screen", "-dmS", name, "zsh", "-lc", shell_command])


def ensure_infrastructure() -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "AGENTS_ANYWHERE_POSTGRES_PORT": str(POSTGRES_PORT),
            "AGENTS_ANYWHERE_REDIS_PORT": str(REDIS_PORT),
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
            "0.0.0.0",
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
            "0.0.0.0",
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
    migrated = LEGACY_STACK_SESSION in screen_sessions()
    if migrated:
        stop_screen(LEGACY_STACK_SESSION)
        _wait_until(
            lambda: not port_open(SERVER_PORT) and not port_open(WEB_PORT),
            timeout=15,
            message="Legacy stack did not release its ports",
        )
    ensure_infrastructure()
    if not _health_ok():
        stop_screen(SERVER_SESSION)
        run_migrations()
        start_server()
    if not port_open(WEB_PORT):
        stop_screen(WEB_SESSION)
        start_web()
    return migrated


def restart_server() -> None:
    migrated = ensure_split_layout()
    if migrated:
        return
    stop_screen(SERVER_SESSION)
    _wait_until(
        lambda: not port_open(SERVER_PORT),
        timeout=10,
        message="Server port was not released",
    )
    ensure_infrastructure()
    run_migrations()
    start_server()


def restart_connector(credential: str | None = None) -> None:
    ensure_split_layout()
    if credential:
        save_connector_credential(credential)
    stop_screen(LEGACY_CONNECTOR_SESSION)
    stop_screen(CONNECTOR_SESSION)
    start_connector()


def restart_all(credential: str | None = None) -> None:
    ensure_split_layout()
    stop_screen(SERVER_SESSION)
    _wait_until(
        lambda: not port_open(SERVER_PORT),
        timeout=10,
        message="Server port was not released",
    )
    run_migrations()
    start_server()
    if credential:
        save_connector_credential(credential)
    stop_screen(LEGACY_CONNECTOR_SESSION)
    stop_screen(CONNECTOR_SESSION)
    start_connector()


def status_payload() -> dict[str, Any]:
    sessions = screen_sessions()
    return {
        "server": _health_ok(),
        "web": port_open(WEB_PORT),
        "connector": connector_process_running(),
        "legacy": LEGACY_STACK_SESSION in sessions,
        "serverUrl": SERVER_URL,
        "webUrl": WEB_URL,
    }


def perform_restart(target: str, credential: str | None = None) -> None:
    with _RESTART_LOCK:
        if target == "server":
            restart_server()
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
    serve_parser.add_argument("--port", type=int, default=8765)
    restart_parser = subparsers.add_parser("restart")
    restart_parser.add_argument("target", choices=("server", "connector", "all"))
    subparsers.add_parser("status")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command in {None, "serve"}:
        serve(getattr(args, "host", "127.0.0.1"), getattr(args, "port", 8765))
    elif args.command == "restart":
        perform_restart(args.target)
        print(json.dumps(status_payload(), ensure_ascii=False))
    elif args.command == "status":
        print(json.dumps(status_payload(), ensure_ascii=False))


if __name__ == "__main__":
    main()
