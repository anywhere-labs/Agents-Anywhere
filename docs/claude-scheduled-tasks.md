# Claude scheduled tasks in AA

AA previously disconnected Claude after each reply. A successful `CronCreate`
could therefore be followed by the process exiting before the reminder fired.
AA now keeps connections with observed scheduled tasks open and continuously
receives subsequent replies. Ordinary conversations without observed tasks still
disconnect after their reply.

## Ownership and recovery

Claude owns scheduling, task cancellation, expiration and persistence. AA records
connection hints in the existing host sync state under `claude/scheduled/sessions`:
the AA and native session IDs, working directory, selections and observed task IDs.
It does not maintain another task table containing prompts or cron expressions.

On runtime startup, AA resumes only registered sessions. Eligible session-only
tasks can be reconstructed by Claude from their session transcript; durable tasks
use Claude's `.claude/scheduled_tasks.json`. Recovery remains subject to the native
Claude version and its deadline/expiration rules. AA does not scan unrelated
history or send hidden model requests to enumerate tasks.

## Replies, approvals and stopping

- Scheduled replies get their own AA turn without an empty user message.
- On retained connections, user prompts carry a UUID and `priority: later`.
  Their native replay identifies the matching response even when a scheduled
  reply starts just before the user submission. Each response has its own queue.
- Approvals belong to the active execution. A user execution waiting behind a
  scheduled reply remains pending until its own response finishes.
- Stopping a session handles both executions in a collision. A queued native
  prompt cannot be individually retracted, so this case may close the connection.
  Runtime shutdown closes all owned connections.
- Model/permission changes refresh an idle connection with the same native session
  ID; changes during a reply take effect after pending work finishes.
- Process failures are reported. AA does not automatically retry potentially
  side-effecting work or promise exactly-once execution after a crash.

## Resource limits

Successful `CronCreate`, `CronDelete` and `CronList` results update AA's observed
task IDs. When the set becomes empty, the connection can close after its response.
After a scheduled turn completes, AA sends one maintenance request asking Claude
to call `CronList`. The maintenance request is restricted by a pre-tool hook to
`CronList` (and `ToolSearch` when needed). An empty, valid list closes the idle
connection; a non-empty list updates the observed IDs and keeps it open. If the
check fails or returns an invalid list, AA keeps the connection rather than risk
dropping a task. These hints also do not discover all tasks in a previously
unregistered, externally imported Claude session.

## Validation

Automated coverage includes ordinary chat, separate scheduled turns, cancellation,
runtime restoration, same-project session isolation, selection changes, approval
ownership, simultaneous user submission, interruption, transport failure and
connection-registry write failure. Run from `connector/`:

```sh
uv run pytest tests/test_runtime_protocol.py tests/test_runtime_protocol_supervisor.py \
  tests/test_connector_runtime_host.py tests/test_connector_architecture.py \
  tests/test_claude_runtime.py tests/test_claude_sdk_client.py \
  tests/test_claude_provider.py -q
```

Local integration experiments used Claude Agent SDK 0.2.152 with bundled Claude
2.1.259 and an isolated mock model endpoint. They verified future session-only
reminders, cancellation, permission-change resume, a busy conversation crossing a
deadline, runtime-object restart, and simultaneous scheduled/user replies.
Long-running expiration, multi-process durable
task ownership and mobile notification delivery are not established by these tests.
