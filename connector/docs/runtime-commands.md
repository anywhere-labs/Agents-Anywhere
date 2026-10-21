# Runtime slash commands

Enter `/` in a connected session to load that runtime's command catalog. Commands
run through the session command API. Their input is never sent as a normal model
message when lookup, validation or execution fails.

Selecting a command that accepts arguments inserts an editable draft. Submit the
draft to execute it. The request preserves its original text, including whitespace
and newlines; attachments remain in the draft and are not sent with commands.

## Codex

AA exposes only `/compact` for Codex. It takes no arguments and requests native
context compaction in the SDK session owned by AA. `/compact-thread` remains an
alias of the same command, not a separate menu entry. Other Codex slash commands
are absent from the catalog and rejected by the command API. Model, reasoning
and permission settings remain available through the session selection controls.

Compaction requires an idle or failed turn and respects known archived, missing,
deleted and unavailable source states. The SDK adapter resumes the native thread
before compacting. A writer lock held by another Codex client produces a rejection;
this integration does not take over the Codex App or IDE.

Native acceptance starts asynchronous work; compaction uses normal runtime
notifications for session status and interruptions. Unsupported native methods
return an error.
The notification adapter is tested with SDK 0.144.4 and 0.158.0. Ordinary turns
reuse the SDK's existing event consumer; command turn controls do not create an
additional subscription that could retain events or miss an early completion.

Compaction publishes a running timeline marker as soon as the native item starts,
including when this arrives before the command acknowledgement. The same native
item becomes a completed marker when compaction finishes. A failed or interrupted
turn settles an unfinished marker as unsuccessful; Web and Desktop show that it
did not complete. An acknowledgement alone does not mark compaction complete.
History refreshes keep the same item identity and preserve an observed running
status when the native snapshot omits item status.

## DeepSeek Harness

AA exposes only `/compact` for DSH. The bridge filters the current session
Agent's native registry before applying search and limits. If that Agent has no
registered `compact` command, the catalog is empty. Both the bridge and Python
connector reject other command names, including commands that depend on DSH's
client UI. The connector also filters catalogs returned by older bridges.

Compaction still runs through the native registry's parser and handler, preserving
the exact submitted line and native result text. The shipped DSH command takes
no arguments; its handler owns validation and busy-state rejection. Model and
permission selection continue through the existing session controls.

The bridge emits a new catalog revision when the registry changes. The connector,
server and Web client preserve it so the menu refreshes without reconnecting.
The bridge also checks the session source and Agent identity before execution.

The DSH bridge host and Python connector must both include this command support.
An older bridge that does not advertise it reports commands as unavailable with
an upgrade reason. Existing published packages are not changed by checking out
this source branch.

## Results and refresh

`result.executionState` distinguishes these outcomes:

- `accepted`: the native runtime accepted asynchronous work. It may still be running.
- `completed`: a synchronous command finished, or the runtime explicitly rejected it.
- `unknown`: a timeout, disconnection or malformed acknowledgement prevents a
  trustworthy conclusion after dispatch. `retryable: false` prevents automatic
  retry; inspect refreshed session state before choosing a further action.

An HTTP 200 response with `ok: false` is a failure. Web shows the native message or
text and keeps the draft after failure or uncertainty. A late response cannot
erase newer input or update a different session. Commands refresh when the menu
reopens, the connection recovers, runtime availability/status changes or the
catalog revision changes.

The shared UI contract is documented in
[connector-to-runtime](../../docs/runtime-protocol/connector-to-runtime.md#commands)
and [Web behavior](../../docs/runtime-protocol/web-behavior.md#commands).

## Headless verification

From `connector/`:

```bash
uv run pytest -q tests/test_codex_commands.py tests/test_codex_sdk_commands.py \
  tests/test_codex_compaction.py tests/test_codex_runtime.py \
  tests/test_dsh_commands.py tests/test_runtime_rpc_params.py
```

From `server/`:

```bash
uv run pytest -q tests/test_session_commands_contract.py
```

From `web-next/`:

```bash
corepack yarn test
corepack yarn typecheck
```

The DSH integration test uses the native registry and a compiled host-to-Python
transport fixture. From `dsh-bridge-next/`, after a host build:

```bash
corepack yarn tsx --test tests/integration/runtime-commands.test.ts
```

These checks do not start an interactive development server or prove an installed
desktop client's behavior. Manual smoke testing requires a connected session and
the matching connector/bridge build.
