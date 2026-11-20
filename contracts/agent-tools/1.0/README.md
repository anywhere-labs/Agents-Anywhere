# Agent tools 1.0

The Connector injects a stdio MCP server named `aa` into supported ACP sessions at startup and resume. Each tool call is authenticated with a session-scoped grant and routed to the Connector that owns the child. Normal-mode cross-device calls use a short-lived Server delegation.

- `tools.json` defines the tools and input schemas. A successful result is one MCP text block containing JSON. A failure sets `isError` and returns an `error` object with a code and message.
- `errors.json` defines collaboration errors. Runtime and client API error codes are also passed through.
- [Agent 协作](../../../docs/agent-collaboration.md) describes configuration, permissions and the supervision lifecycle.
