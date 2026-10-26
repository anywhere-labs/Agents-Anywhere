"""Supported Server entry point, owning shared children outside API workers."""

import argparse
import os

import uvicorn

from agent_server.core.process_settings import ProcessSettings
from agent_server.infra.mesh_router import ManagedRouter


def main(argv: list[str] | None = None) -> None:
    settings = ProcessSettings.from_environment()
    settings.validate_shared_state(
        redis_configured=bool(os.environ.get("AGENT_SERVER_REDIS_URL"))
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--no-access-log", action="store_true")
    args = parser.parse_args(argv)
    with ManagedRouter():
        uvicorn.run(
            "agent_server.app:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            workers=settings.workers,
            reload=args.reload,
            access_log=not args.no_access_log,
        )


if __name__ == "__main__":
    main()
