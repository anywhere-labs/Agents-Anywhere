# Headless CLI runtimes (MiniMax Code / CodeBuddy)

The connector ships two runtimes that drive a locally installed coding CLI
instead of an SDK:

| runtime key | CLI | one-shot command | persistent transport |
| --- | --- | --- | --- |
| `minimax` | MiniMax Code (`mcode`) | `mcode exec --prompt-mode work --output-format stream-json` | `mcode acp` (Agent Client Protocol) |
| `codebuddy` | CodeBuddy (`codebuddy`) | `codebuddy -p -y --output-format stream-json --include-partial-messages --verbose` | not used |

Both are `RuntimeProvider` / `AgentRuntime` packages under
`connector/connector/runtimes/cli_headless/`.

## Requirements

- The CLI must be on `PATH`. `MINIMAX_CLI_JS` may point at a specific MiniMax
  `cli.js` entrypoint instead.
- CodeBuddy needs a one-time interactive `codebuddy /login`, and folder trust
  for the workspace. Without it every turn fails at the CLI.
- A runtime whose CLI is missing reports itself unavailable, is omitted from the
  capability set, and never appears as a usable agent.

## Configuration

Both kernels share one config schema:

- `workspaceDir` — default working directory for new sessions.
- `defaultModel` — used when a session has no selection of its own. Only present
  when the kernel reports a model catalog.

## Turns

- **Streaming.** stdout is parsed as NDJSON. CodeBuddy's Claude-fork
  `stream_event` schema and MiniMax's `item.*` schema are both understood, and a
  line that is not JSON falls back to raw text. Assistant text is published on a
  200-character or 0.5-second threshold; the first delta is published immediately,
  so the connector adds no first-paint delay.
- **Reasoning.** `thinking` blocks become `ReasoningSystemContent` items, so the
  transcript is visible while the turn is still running.
- **Tool calls.** Become `ToolTimelineItem` items upserted by their native id, so
  a later sparse update refines the existing item instead of adding another.
- **Multi-turn context.** The native CLI session id is captured from the stream
  and persisted, then reused (`--session <id>`, or
  `--resume <id> --resume-create-missing`). Sessions stay continuable across
  connector restarts; the registry lives in the runtime KV store under
  `cli_headless:<runtime>:sessions`.
- **Attachments.** Materialized to disk the way the Claude runtime does:
  MiniMax receives `--file <path>`, CodeBuddy receives a prompt note listing the
  staged files. `runtime.attachment` is advertised.

## Persistent session (MiniMax Code)

A fresh CLI process per turn pays the CLI's own session setup on every message.
Measured on Windows 11 against `mcode 0.6.5`, same prompts, through this kernel:

| | one-shot | persistent ACP |
| --- | --- | --- |
| turn 1 (includes setup) | 35.23 s | 17.29 s |
| turn 2 (setup already paid) | 20.80 s | 5.03 s |

`mcode --version` returns in 0.14 s, so that ~11 s is authentication and model
session setup, not process launch, and launch flags do not remove it.

MiniMax Code exposes the same capability through `mcode acp`, so one long-lived
process serves every turn:

- `initialize` reports `protocolVersion: 1`, `agentInfo` `minimax-code`, and
  `loadSession: true` (also `sessionCapabilities.list/fork/resume/close`, plus
  `mcode/session/*` extensions such as `mcode/session/steer`).
- `session/new` returns the session id together with `modes` and
  `configOptions`; permission mode defaults to `bypassPermissions`, which is what
  makes full-auto turns possible.
- `session/prompt` streams `session/update` notifications
  (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
  `tool_call_update`, `available_commands_update`, `session_info_update`,
  `usage_update`) and finishes with a `stopReason`.
- `session/load` restores a session after the child process died, so a restarted
  connector resumes the same conversation instead of starting a new one.
- `session/cancel` interrupts the running turn; it reports
  `stopReason: "cancelled"` rather than the process simply dying.

Behaviour worth knowing:

- **Fallback.** If the ACP process cannot be started, fails to initialise, or
  errors mid-turn, the kernel logs it and runs that turn through the one-shot
  path. Slow is preferred over broken.
- **Attachments** always use the one-shot path, where `--file` is verified. Both
  transports share one session store, so the session id is portable between them.
- **Teardown.** On Windows the process is `cmd /c mcode.CMD acp`, so the kernel
  kills the whole process tree; otherwise the Node child survives the kill.
- **Serialization.** Prompts on the shared process are serialized, so two
  sessions on one runtime queue rather than interleaving.

## Capabilities

Advertised at both runtime and session scope: `session.send_message`,
`session.interrupt`, `catalog.model`, `runtime.attachment`.

Declared unsupported: `permissionCatalog`, `sessionDiscovery`, `sessionNotices`,
`steerTurn`, `commands`, `interactions`, `ipc`. Both kernels run full-auto
(`-y`, `--prompt-mode work`), so approvals and input requests cannot be answered
from a client.

## Measured performance notes

Per-turn time is dominated by the model and by the CLI's session setup, not by
the connector. On the same prompt: CodeBuddy `hy4-preview` (its own default)
20.9 s total / 19.0 s to first text; `glm-5.3-flashx` 11.5 s / 9.3 s;
`glm-5.3-flash` 10.8 s / 8.8 s. Per-turn time for one model and one prompt was
observed to vary between 7.5 s and 17 s, so single samples are not evidence.

Launch flags were measured and did **not** help: `--verbose` removal,
`--strict-mcp-config`, `--setting-sources user`, every CodeBuddy `--effort`
level (alternated A/B, no reliable ordering), and `mcode --prompt-mode coding`.
Only `mcode --mode lightweight` was consistently faster, by 2-4 s, at the cost
of a smaller context, so it is not used by default. Keeping the process alive is
the only structural lever, which is why MiniMax Code uses ACP and CodeBuddy still
pays setup per turn.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Runtime missing from the agent list | CLI not on `PATH` (or `MINIMAX_CLI_JS` invalid). |
| Every turn fails with a CLI error | CodeBuddy not logged in (`codebuddy /login`). |
| Only the first turn of a session is slow | Expected: that turn pays the CLI's session setup. |
| Follow-up turns slow a second time | The ACP process died and the turn fell back; the connector log records `persistent transport unavailable` or `could not restore ACP session`. |
| `runtime capability is unavailable: session.send_message` | The runtime is missing from `KNOWN_RUNTIME_CAPABILITY_IDS` in `connector/server/capabilities.py`, so it publishes no capabilities at all. |

## Limitations

MiniMax Code's catalog still reports a single synthetic `default` entry even
though its ACP `configOptions` carry a real model list and thinking-effort
levels; wiring those, plus `mcode/session/steer`, is the natural next step. No
slash commands, no approvals, and no session discovery (sessions started outside
Agents Anywhere are invisible). `~/.codebuddy/models.json` is read directly
rather than through `custom_models.py` / `model_gateway.py`, and CodeBuddy's
built-in model list is a snapshot of `codebuddy --help`. Because the prompt
travels as an argv element, very long prompts can hit Windows `cmd` quoting
limits; the child always gets `stdin=DEVNULL` so a console-less process cannot
hang waiting on stdin.
