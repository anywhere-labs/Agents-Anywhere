from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

import httpx

from connector.runtime import BackendRpcClient, ConnectorConfig


def main(argv: list[str] | None = None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "login":
            asyncio.run(_login(args))
        elif args.command == "configure":
            _configure(args)
        elif args.command == "start":
            asyncio.run(_start(args))
        else:
            parser.print_help()
    except KeyboardInterrupt:
        raise SystemExit(130) from None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-connector", description="Agent Server Codex connector CLI")
    subparsers = parser.add_subparsers(dest="command")

    start = subparsers.add_parser("start", help="start the connector")
    _add_config_args(start)
    start.add_argument("--server-url", help="backend server URL")
    start.add_argument("--connector-id", help="connector id")
    start.add_argument("--connector-token", help="connector token")

    login = subparsers.add_parser("login", help="pair with a backend, save credentials, and start the connector")
    _add_config_args(login)
    login.add_argument("--server-url", required=True, help="backend server URL")
    login.add_argument("--poll-interval", type=float, default=2, help="seconds between pairing polls")
    login.add_argument("--timeout", type=float, default=600, help="pairing timeout in seconds")
    login.add_argument("--no-start", action="store_true", help="save credentials without starting the connector")

    configure = subparsers.add_parser("configure", help="save connector credentials to local JSON")
    _add_config_args(configure)
    configure.add_argument("--server-url", required=True, help="backend server URL")
    configure.add_argument("--connector-id", required=True, help="connector id")
    configure.add_argument("--connector-token", required=True, help="connector token")
    return parser


def _add_config_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--config",
        default=str(ConnectorConfig.default_path()),
        help="local connector config JSON path",
    )


async def _start(args: argparse.Namespace) -> None:
    config = _resolve_config(args)
    await BackendRpcClient(config).run_forever()


async def _login(args: argparse.Namespace) -> None:
    server_url = args.server_url.rstrip("/")
    async with httpx.AsyncClient(timeout=30) as client:
        start_response = await client.post(
            f"{server_url}/pairing/start",
            json={"serverUrl": server_url, "ttlSeconds": int(args.timeout)},
        )
        start_response.raise_for_status()
        pairing = start_response.json()
        pairing_id = pairing["pairingId"]
        code = pairing["code"]

        print(f"Pairing code: {code}")
        print("Claim it from the web UI")
        # print(
        #     "curl -s "
        #     f"{server_url}/pairing/claim "
        #     "-H 'content-type: application/json' "
        #     f"-d '{{\"code\":\"{code}\",\"name\":\"local-codex\",\"userId\":\"local\",\"serverUrl\":\"{server_url}\"}}'"
        # )
        print("Waiting for credentials...")

        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            poll_response = await client.post(f"{server_url}/pairing/poll", json={"pairingId": pairing_id})
            poll_response.raise_for_status()
            payload = poll_response.json()
            if payload["status"] == "claimed" and payload.get("config"):
                config = ConnectorConfig.from_mapping(payload["config"])
                path = config.save(args.config)
                print(f"Saved connector config: {path}")
                if args.no_start:
                    return
                print("Starting connector...")
                await BackendRpcClient(config).run_forever()
                return
            if payload["status"] in {"expired", "consumed"}:
                raise RuntimeError(f"pairing ended with status: {payload['status']}")
            await asyncio.sleep(args.poll_interval)

    raise TimeoutError("pairing timed out")


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
    raise SystemExit("missing connector credentials: " + ", ".join(missing))


if __name__ == "__main__":
    main(sys.argv[1:])
