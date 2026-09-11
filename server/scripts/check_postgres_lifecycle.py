"""Run lifecycle and row-lock regressions in an explicit disposable local PG DB.

Application tables are truncated between tests. This adapter uses NullPool only
because the existing sync test helpers open multiple event loops. Use the separate
benchmark script for timings with the normal production pool.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-url", required=True)
    args = parser.parse_args()
    parsed = urlsplit(args.postgres_url)
    if (
        parsed.scheme != "postgresql+asyncpg"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or not parsed.path.startswith("/aa_lifecycle_test")
        or parsed.query
        or parsed.fragment
    ):
        parser.error(
            "Use a loopback postgresql+asyncpg URL and disposable database aa_lifecycle_test*"
        )
    for key in tuple(os.environ):
        if key.startswith(("AGENT_SERVER_", "AGENT_CONNECTOR_")):
            os.environ.pop(key)
    os.environ["AGENT_SERVER_DB_URL"] = args.postgres_url
    sys.path[:0] = [str(REPO / "server"), str(REPO / "server/tests")]
    os.chdir(REPO / "server")

    from agent_server.infra.db import engine
    from sqlalchemy.pool import NullPool

    original_engine = engine.create_async_engine

    def test_engine(url, **kwargs):
        for key in ("pool_size", "max_overflow", "pool_timeout", "pool_recycle"):
            kwargs.pop(key, None)
        kwargs["poolclass"] = NullPool
        return original_engine(url, **kwargs)

    engine.create_async_engine = test_engine
    import conftest
    import pytest
    from agent_server.app import create_app

    def pg_client(destination):
        return conftest.ApiV2TestClient(create_app(destination))

    class PostgresHarness:
        def pytest_collection_modifyitems(self, items):
            # Pytest may reload conftest during discovery, so adapt the collected
            # test modules too, without changing the normal SQLite fixtures.
            for module in tuple(sys.modules.values()):
                path = getattr(module, "__file__", "") or ""
                if path.startswith(str(REPO / "server/tests")) and hasattr(
                    module, "make_test_client"
                ):
                    module.make_test_client = pg_client

    return pytest.main(
        [
            "-q",
            "-p",
            "no:cacheprovider",
            "--tb=short",
            "tests/test_connector_lifecycle.py",
            "tests/test_announcements.py",
            "tests/test_connector_deletion.py",
            "tests/test_session_inventory.py",
            "tests/test_session_source_postgres.py",
        ],
        plugins=[PostgresHarness()],
    )


if __name__ == "__main__":
    raise SystemExit(main())
