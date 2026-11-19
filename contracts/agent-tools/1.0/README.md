# agent-tools 1.0

The tools an Agent gets when its Agents Anywhere session has collaboration on (docs/agent-collaboration.md). The
Connector injects a stdio MCP server named `aa` (`anywhere-cli agent-tools`) into the Agent's ACP session
(`session/new`, `session/load`, `session/resume` → `mcpServers`); the server forwards each tool call to the
Connector's local agent-tools socket, which checks the session's collaboration grant and runs it.

- `tools.json`: every tool's name, the grant verb it needs, its description and its input JSON Schema. Tool results are
  one MCP text content block holding JSON; a failure is an MCP error result whose text is `{"error": {"code", "message"}}`.
- `errors.json`: the error codes a tool returns, plus the client API codes passed through unchanged.

`aa_review` starts or advances a persisted implementation and independent review in the calling session. Saved
handoffs identify the source session, timeline item, round and complete Git commit. The main session calls
`advance` after a supervision wake and can call `status` to recover the current state. Target Git data travels
through the selected projects' shared remote and their existing Git authorization.

Rules that hold for every tool:

1. The grant decides (`domain/collab/grant.ts`): authority never exceeds the user's setting nor the supervisor's own
   permission level; `close` and Agent-created supervisions apply only to sessions the supervisor created.
2. Every state-changing call has an `actionId`, used as the downstream command id / `clientMessageId`; an unknown
   outcome is reported as `command_outcome_unknown` and never retried.
3. `aa_wait` waits at most 50 seconds (Pi and DSH time an MCP call out at 60 seconds); longer waits are supervision
   wake-ups.
4. Targets are reached through the client API: in-process on the same device, through the Server with a delegation
   token in normal mode, through a Noise channel as an `agent` client in encrypted mode (never downgraded).
