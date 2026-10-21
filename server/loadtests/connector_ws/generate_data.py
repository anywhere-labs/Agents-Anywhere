#!/usr/bin/env python3
"""Prepare and remove local data for the Connector WebSocket k6 workload."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_EMAIL = "agents-anywhere-loadtest@local.invalid"
DEFAULT_PASSWORD = "AgentsAnywhere-LoadTest-Local-Only"
DEFAULT_OUTPUT = Path(".local-dev/loadtest/connector-ws/data.json")
DEFAULT_SETUP_LOG = Path(".local-dev/logs/server.log")
SETUP_TOKEN_PATTERN = re.compile(r"setup-token:\s+(\S+)")


class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, body: str) -> None:
        detail = body[:500].strip() or "empty response"
        super().__init__(f"{method} {path} returned HTTP {status}: {detail}")
        self.status = status
        self.body = body


@dataclass(slots=True)
class ApiClient:
    base_url: str
    timeout: float = 30.0

    def request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> Any:
        body = None
        request_headers = {"Accept": "application/json", **(headers or {})}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        url = f"{self.base_url.rstrip('/')}{path}"
        request = Request(url, data=body, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                status = response.status
                response_body = response.read().decode("utf-8")
        except HTTPError as exc:
            status = exc.code
            response_body = exc.read().decode("utf-8", errors="replace")
        except URLError as exc:
            raise RuntimeError(f"cannot reach {url}: {exc.reason}") from exc
        if status not in expected:
            raise ApiError(method, path, status, response_body)
        if not response_body:
            return None
        try:
            return json.loads(response_body)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{method} {path} returned invalid JSON") from exc


def latest_setup_token(log_path: Path) -> str:
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"setup token log not found: {log_path}; start ./local-up.sh first"
        ) from exc
    matches = SETUP_TOKEN_PATTERN.findall(text)
    if not matches:
        raise RuntimeError(f"no setup-token entry found in {log_path}")
    return matches[-1]


def atomic_write_private(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def login_or_bootstrap(
    api: ApiClient,
    *,
    email: str,
    password: str,
    setup_log: Path,
    setup_token: str | None = None,
) -> dict[str, Any]:
    try:
        return api.request(
            "POST",
            "/api/v2/auth/login",
            payload={"email": email, "password": password},
        )
    except ApiError as exc:
        if exc.status != 401:
            raise

    config = api.request("GET", "/api/v2/auth/config")
    if not config.get("needsBootstrap"):
        raise RuntimeError(
            "load-test login failed and registration is not in bootstrap mode; "
            "set LOADTEST_EMAIL and LOADTEST_PASSWORD to an existing local user"
        )
    return api.request(
        "POST",
        "/api/v2/auth/register",
        payload={
            "email": email,
            "displayName": "Agents Anywhere Load Test",
            "password": password,
            "setupToken": setup_token or latest_setup_token(setup_log),
        },
    )


def connector_access_token(
    api: ApiClient, connector_id: str, connector_token: str
) -> str:
    response = api.request(
        "POST",
        "/api/v2/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    return str(response["accessToken"])


def session_meta_notification(
    *, connector_index: int, session_index: int, prefix: str
) -> dict[str, Any]:
    session_id = f"{prefix}-c{connector_index:03d}-s{session_index:05d}"
    return {
        "method": "session.meta.upsert",
        "params": {
            "sessionId": session_id,
            "externalSessionId": f"thr-{session_id}",
            "runtime": "codex",
            "runtimeId": "codex",
            "title": f"Load test session {connector_index}-{session_index}",
            "cwd": f"/loadtest/{prefix}/connector-{connector_index:03d}",
            "sourceState": {
                "availability": "available",
                "reason": "load-test fixture",
                "observedAt": "2026-01-01T00:00:00Z",
                "observationOrigin": "inventory",
            },
        },
    }


def prepare(args: argparse.Namespace) -> None:
    output = args.output.resolve()
    if output.exists():
        raise RuntimeError(
            f"manifest already exists: {output}; reuse it or run cleanup first"
        )
    api = ApiClient(args.base_url)
    api.request("GET", "/api/v2/health/ready")
    auth = login_or_bootstrap(
        api,
        email=args.email,
        password=args.password,
        setup_log=args.setup_token_log.resolve(),
        setup_token=args.setup_token,
    )
    user_headers = {"Authorization": f"Bearer {auth['accessToken']}"}
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    prefix = args.prefix or f"k6ws-{int(time.time())}"
    manifest: dict[str, Any] = {
        "version": 1,
        "baseUrl": args.base_url.rstrip("/"),
        "createdAt": created_at,
        "prefix": prefix,
        "user": {
            "email": args.email,
            "accessToken": auth["accessToken"],
        },
        "connectors": [],
    }
    atomic_write_private(output, manifest)

    for connector_index in range(1, args.connectors + 1):
        created = api.request(
            "POST",
            "/api/v2/connectors",
            headers=user_headers,
            payload={"name": f"{prefix} connector {connector_index:03d}"},
        )
        connector_id = str(created["connector"]["id"])
        connector_token = str(created["connectorToken"])
        access_token = connector_access_token(api, connector_id, connector_token)
        notifications = [
            session_meta_notification(
                connector_index=connector_index,
                session_index=session_index,
                prefix=prefix,
            )
            for session_index in range(1, args.sessions_per_connector + 1)
        ]
        for start in range(0, len(notifications), args.batch_size):
            batch = notifications[start : start + args.batch_size]
            response = api.request(
                "POST",
                "/api/v2/connector/ingest",
                headers={"Authorization": f"Bearer {access_token}"},
                payload={"notifications": batch},
            )
            if response.get("rejected"):
                raise RuntimeError(
                    f"connector {connector_id} rejected fixture notifications: "
                    f"{response['rejected'][:3]}"
                )
        connector_document = {
            "id": connector_id,
            "token": connector_token,
            "sessions": [
                {
                    "id": item["params"]["sessionId"],
                    "externalSessionId": item["params"]["externalSessionId"],
                }
                for item in notifications
            ],
        }
        manifest["connectors"].append(connector_document)
        atomic_write_private(output, manifest)
        print(
            f"prepared connector {connector_index}/{args.connectors}: "
            f"{connector_id} ({len(notifications)} sessions)",
            flush=True,
        )

    projects = api.request("GET", "/api/v2/projects", headers=user_headers)[
        "projects"
    ]
    loadtest_projects = [
        project
        for project in projects
        if str(project.get("workspacePath", "")).startswith(f"/loadtest/{prefix}/")
    ]
    manifest["projectIds"] = [project["id"] for project in loadtest_projects]
    atomic_write_private(output, manifest)
    print(
        f"manifest: {output}\n"
        f"created: {len(manifest['connectors'])} connectors, "
        f"{args.connectors * args.sessions_per_connector} sessions, "
        f"{len(loadtest_projects)} projects",
        flush=True,
    )


def cleanup(args: argparse.Namespace) -> None:
    manifest_path = args.output.resolve()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"manifest not found: {manifest_path}") from exc
    api = ApiClient(args.base_url or manifest["baseUrl"])
    token = manifest["user"]["accessToken"]
    headers = {"Authorization": f"Bearer {token}"}
    try:
        api.request("GET", "/api/v2/auth/me", headers=headers)
    except ApiError as exc:
        if exc.status != 401:
            raise
        auth = api.request(
            "POST",
            "/api/v2/auth/login",
            payload={"email": manifest["user"]["email"], "password": args.password},
        )
        headers = {"Authorization": f"Bearer {auth['accessToken']}"}

    failures: list[str] = []
    for connector in reversed(manifest.get("connectors", [])):
        connector_id = connector["id"]
        try:
            api.request(
                "DELETE",
                f"/api/v2/connectors/{connector_id}",
                headers=headers,
                expected=(204, 404),
            )
            print(f"deleted connector: {connector_id}")
        except Exception as exc:  # noqa: BLE001 - report every cleanup failure
            failures.append(f"{connector_id}: {exc}")
    if failures:
        raise RuntimeError("cleanup incomplete:\n" + "\n".join(failures))
    manifest_path.unlink()
    print(f"removed manifest: {manifest_path}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", default=DEFAULT_BASE_URL)
    common.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    common.add_argument(
        "--password",
        default=os.environ.get("LOADTEST_PASSWORD", DEFAULT_PASSWORD),
        help="test user password; prefer LOADTEST_PASSWORD",
    )

    prepare_parser = subparsers.add_parser("prepare", parents=[common])
    prepare_parser.add_argument(
        "--email", default=os.environ.get("LOADTEST_EMAIL", DEFAULT_EMAIL)
    )
    prepare_parser.add_argument("--connectors", type=int, default=8)
    prepare_parser.add_argument("--sessions-per-connector", type=int, default=25)
    prepare_parser.add_argument("--batch-size", type=int, default=50)
    prepare_parser.add_argument("--prefix")
    prepare_parser.add_argument(
        "--setup-token-log", type=Path, default=DEFAULT_SETUP_LOG
    )
    prepare_parser.add_argument(
        "--setup-token",
        default=os.environ.get("LOADTEST_SETUP_TOKEN"),
        help="explicit first-run setup token; prefer LOADTEST_SETUP_TOKEN",
    )
    prepare_parser.set_defaults(func=prepare)

    cleanup_parser = subparsers.add_parser("cleanup", parents=[common])
    cleanup_parser.set_defaults(func=cleanup)
    return result


def main() -> int:
    args = parser().parse_args()
    for name in ("connectors", "sessions_per_connector", "batch_size"):
        value = getattr(args, name, 1)
        if value < 1:
            raise RuntimeError(f"--{name.replace('_', '-')} must be at least 1")
    args.func(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ApiError, RuntimeError, KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
