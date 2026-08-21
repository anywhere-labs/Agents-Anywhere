from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

import httpx

from connector.control import ConnectorController
from connector.core.config import ConnectorConfig
from connector.core.json_rpc import JsonRpcStdioServer, open_stdio_server
from connector.core.runtime_owner import (
    assert_can_start,
    clear_runtime,
    runtime_path,
    write_runtime,
)
from connector.logging import configure_connector_logging, install_rpc_log_sink
from connector.server.client import BackendRpcClient
from connector.server.pairing import (
    poll_pairing,
    resolve_pair_server_url,
    start_pairing,
)

SHELL_LIFETIME_WARNING = (
    "Note: this connector runs in the current shell session. "
    "If you do not run it with a tool such as systemd, tmux, screen, "
    "or a background service, the connection will stop when this shell session ends."
)


def main(argv: list[str] | None = None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)
    configure_connector_logging(debug=bool(getattr(args, "debug", False)))
    try:
        if args.command in {"pair", "login"}:
            asyncio.run(_pair(args))
        elif args.command == "configure":
            _configure(args)
        elif args.command == "start":
            asyncio.run(_start(args))
        elif args.command == "rpc":
            asyncio.run(_rpc(args))
        else:
            parser.print_help()
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
    except httpx.TimeoutException as exc:
        print(
            f"error: request timed out: {exc.request.url if exc.request else exc}",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    except httpx.HTTPStatusError as exc:
        detail = _response_detail(exc.response)
        print(
            f"error: server returned HTTP {exc.response.status_code}: {detail}",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    except httpx.RequestError as exc:
        print(f"error: cannot reach server: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
    except (TimeoutError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None


class CliError(RuntimeError):
    pass


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="anywhere-cli", description="Agent Server Codex connector CLI"
    )
    subparsers = parser.add_subparsers(
        dest="command", metavar="{start,pair,configure,rpc}"
    )

    start = subparsers.add_parser("start", help="start the connector")
    _add_config_args(start)
    start.add_argument("--server-url", help="backend server URL")
    start.add_argument("--connector-id", help="connector id")
    start.add_argument("--connector-token", help="connector token")
    _add_debug_arg(start)

    pair = subparsers.add_parser(
        "pair",
        help="pair with a backend, save credentials, and start the connector",
    )
    _add_pair_args(pair)

    configure = subparsers.add_parser(
        "configure", help="save connector credentials to local JSON"
    )
    _add_config_args(configure)
    configure.add_argument("--server-url", required=True, help="backend server URL")
    configure.add_argument("--connector-id", required=True, help="connector id")
    configure.add_argument("--connector-token", required=True, help="connector token")

    rpc = subparsers.add_parser(
        "rpc", help="serve the desktop connector JSON-RPC API over stdio"
    )
    _add_config_args(rpc)
    _add_debug_arg(rpc)
    return parser


def _add_config_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--config",
        default=str(ConnectorConfig.default_path()),
        help="local connector config JSON path",
    )


def _add_debug_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--debug",
        action="store_true",
        help="show debug-level connector logs",
    )


def _add_pair_args(parser: argparse.ArgumentParser) -> None:
    _add_config_args(parser)
    _add_debug_arg(parser)
    parser.add_argument(
        "server",
        nargs="?",
        help="backend server URL, for example anywhere.com or https://api.anywhere.com",
    )
    parser.add_argument(
        "--poll-interval", type=float, default=2, help="seconds between pairing polls"
    )
    parser.add_argument(
        "--timeout", type=float, default=600, help="pairing timeout in seconds"
    )
    parser.add_argument(
        "--no-start",
        action="store_true",
        help="save credentials without starting the connector",
    )


async def _start(args: argparse.Namespace) -> None:
    config = _resolve_config(args)
    await _run_cli_connector(config, config_path=args.config)


async def _rpc(args: argparse.Namespace) -> None:
    server: JsonRpcStdioServer | None = None

    async def notify(method: str, params: object) -> None:
        if server is not None:
            await server.notify(method, params)

    controller = ConnectorController(config_path=args.config, notifier=notify)
    handlers = {
        "connector.getState": controller.get_state,
        "connector.getPaths": controller.get_paths,
        "connector.getConfig": controller.get_config,
        "connector.saveConfig": controller.save_config,
        "connector.start": controller.start,
        "connector.stop": controller.stop,
        "connector.restart": controller.restart,
        "connector.startPairing": controller.start_pairing,
        "connector.cancelPairing": controller.cancel_pairing,
    }
    log_level = "DEBUG" if args.debug else "INFO"
    log_sink = install_rpc_log_sink(
        notify,
        level=log_level,
        remove_default_sink=True,
    )
    server = await open_stdio_server(handlers)
    try:
        await server.serve_forever()
    finally:
        await controller.shutdown()
        await log_sink.close()


async def _pair(args: argparse.Namespace) -> None:
    server_url = await _resolve_server_url_for_pair(args.server, timeout=10)
    async with httpx.AsyncClient(timeout=30) as client:
        pairing = await start_pairing(client, server_url, args.timeout)
        pairing_id = pairing["pairingId"]
        code = pairing["code"]

        print(f"Pairing code: {code}")
        print("Claim it from the web UI")
        # print(
        #     "curl -s "
        #     f"{api_v2_url(server_url, '/pairing/claim')} "
        #     "-H 'content-type: application/json' "
        #     f"-d '{{\"code\":\"{code}\",\"name\":\"local-codex\",\"userId\":\"local\",\"serverUrl\":\"{server_url}\"}}'"
        # )
        print("Waiting for credentials...")

        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            payload = await poll_pairing(client, server_url, str(pairing_id))
            if payload["status"] == "claimed" and payload.get("config"):
                config = ConnectorConfig.from_mapping(payload["config"])
                path = config.save(args.config)
                print(f"Saved connector config: {path}")
                if args.no_start:
                    return
                print("Starting connector...")
                await _run_cli_connector(config, config_path=args.config)
                return
            if payload["status"] in {"expired", "consumed"}:
                raise RuntimeError(f"pairing ended with status: {payload['status']}")
            await asyncio.sleep(args.poll_interval)

    raise TimeoutError("pairing timed out")


async def _run_cli_connector(
    config: ConnectorConfig, *, config_path: str | Path | None
) -> None:
    runtime_file = runtime_path(config_path)
    assert_can_start(runtime_file, config)
    write_runtime(runtime_file, config, kind="cli")
    print(SHELL_LIFETIME_WARNING)
    try:
        await BackendRpcClient(config).run_forever()
    finally:
        clear_runtime(runtime_file)


async def _resolve_server_url_for_pair(
    value: str | None, *, timeout: float = 10
) -> str:
    try:
        return await resolve_pair_server_url(
            value,
            timeout=timeout,
            missing_message="missing server address. Usage: anywhere-cli pair <server>",
        )
    except ValueError as exc:
        raise CliError(str(exc)) from exc


def _configure(args: argparse.Namespace) -> None:
    config = ConnectorConfig(
        server_url=args.server_url.rstrip("/"),
        connector_id=args.connector_id,
        connector_token=args.connector_token,
    )
    path = config.save(args.config)
    print(f"Saved connector config: {path}")


def _resolve_config(args: argparse.Namespace) -> ConnectorConfig:
    server_url = args.server_url or os.environ.get("AGENT_SERVER_URL")
    connector_id = args.connector_id or os.environ.get("AGENT_CONNECTOR_ID")
    connector_token = args.connector_token or os.environ.get("AGENT_CONNECTOR_TOKEN")
    if server_url and connector_id and connector_token:
        return ConnectorConfig(
            server_url=server_url.rstrip("/"),
            connector_id=connector_id,
            connector_token=connector_token,
        )

    config_path = Path(args.config)
    if config_path.exists():
        return ConnectorConfig.load(config_path)

    missing = []
    if not server_url:
        missing.append("--server-url")
    if not connector_id:
        missing.append("--connector-id")
    if not connector_token:
        missing.append("--connector-token")
    missing.append(f"or config file {config_path}")
    raise CliError("missing connector credentials: " + ", ".join(missing))


def _response_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        text = response.text.strip()
        return text[:300] if text else response.reason_phrase
    if isinstance(payload, dict):
        detail = payload.get("detail") or payload.get("message") or payload
        return str(detail)
    return str(payload)


if __name__ == "__main__":
    main(sys.argv[1:])
