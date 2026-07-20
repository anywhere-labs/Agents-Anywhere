# Anywhere CLI

Local runtime connector for Agents Anywhere. It runs on the machine that owns
the workspace and agent runtimes, connects to the server over HTTP/WebSocket,
executes connector RPC locally, and uploads normalized runtime/session state
back to the backend.

## Layout

```text
connector/
  claude/       Claude Code discovery, adapter, reducer, and transcript logic
  codex/        Codex app-server discovery, RPC, adapter, and reducer logic
  local/        Local filesystem, shell, and terminal backends
  cli.py        anywhere-cli CLI
  runtime.py    Connector config, auth, WebSocket loop, and RPC dispatch
tests/          Connector tests
pyproject.toml  Connector dependencies and console script
run.sh          Local helper for saved-config startup
```

## Run

Install dependencies:

```bash
uv sync
```

Start with explicit credentials from the web pairing flow:

```bash
uvx anywhere-cli start \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

Or save the config locally and start without arguments:

```bash
uvx anywhere-cli configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx

uvx anywhere-cli start
```

The default config path is `~/.agent-server/connector.json`. Override it with
`--config` or `AGENT_CONNECTOR_CONFIG`.

## Runtime Discovery

The connector discovers Codex and Claude locally and reports attached runtime
capabilities to the server. If a runtime is not on `PATH`, set one of:

```bash
CODEX_BIN=/path/to/codex
CLAUDE_BIN=/path/to/claude
```

The connector uses local runtime credentials and local filesystem permissions.
Agents Anywhere does not proxy Claude or Codex account credentials.

## API Namespace

Connector configuration stores the server origin, for example
`http://127.0.0.1:8000`; do not include `/api/v2` in `--server-url`.

The connector adds the v2 namespace internally and talks to `/api/v2/connector/*`
and `/api/v2/health`. See `../docs/api-v2-migration.md` for the migration
rules.

## Local Operations

The server can ask an online connector to perform local work:

- read/list/write files inside workspace-safe roots
- upload/download file content through the server
- run one-shot shell commands
- start and wait for shell tasks
- create, write, resize, stream, list, and close interactive terminals
- start, interrupt, sync, and approve runtime turns

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_CONNECTOR_CONFIG` | Connector config path. |
| `AGENT_SERVER_URL` | Server URL used when `--server-url` is omitted. |
| `AGENT_CONNECTOR_ID` | Connector id used when `--connector-id` is omitted. |
| `AGENT_CONNECTOR_TOKEN` | Connector token used when `--connector-token` is omitted. |
| `AGENT_CONNECTOR_ATTACHMENTS_ROOT` | Runtime attachment download directory. Defaults to `~/.agents-anywhere/attachments`. |
| `CODEX_BIN` | Explicit Codex CLI/app-server path. |
| `CLAUDE_BIN` | Explicit Claude Code CLI path. |

## Verify

```bash
uv run ruff check connector tests
uv run pytest -q
```
