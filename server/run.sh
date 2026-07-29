#!/usr/bin/env sh
set -eu

AGENT_SERVER_DB="${AGENT_SERVER_DB:-agent-server.sqlite3}"
export AGENT_SERVER_DB

uv run python -m agent_server.infra.db.migrations upgrade
exec uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
