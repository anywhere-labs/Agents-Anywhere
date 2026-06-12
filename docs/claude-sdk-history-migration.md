# Claude Code SDK History Migration

## Goal

Claude Code has two supported run paths:

- Chat Mode: use the Claude Agent SDK stream and emit timeline items.
- Terminal Mode: start a real terminal, forward PTY bytes, and let the frontend render the terminal.

History scanning should also use the Claude Agent SDK. It should not read JSONL
files directly, and it should not drive Claude Code through a hidden PTY.

## Current Problem

The connector still contains an older Claude path that does three jobs at once:

- starts Claude Code in a PTY,
- tails the local JSONL transcript,
- reduces JSONL entries into timeline items.

That path is now legacy. Terminal Mode already has its own terminal-byte path,
and Chat Mode already has a SDK stream path. Keeping the old path makes the
Claude connector harder to reason about and creates duplicate ways to produce
timeline state.

## Target Shape

Claude timeline data should have only two sources:

- Live chat: SDK stream messages from `ClaudeSdkAdapter.start_turn()`.
- History: SDK session APIs, `list_sessions()` and `get_session_messages()`.

Terminal data should have one source:

- Generic terminal RPC, `terminal.create` / `terminal.output`, with raw bytes
  rendered by the frontend terminal.

## Migration Steps

### Step 1: Add SDK History Scanner

Status: complete.

Create a new history adapter that uses the installed `claude_agent_sdk` package:

- call `list_sessions(limit=...)` to discover local Claude Code sessions,
- call `get_session_messages(session_id, directory=session.cwd)` to read a
  session's visible user/assistant messages,
- convert each SDK `SessionMessage` into the existing raw shape,
- normalize with `ClaudeTranscriptNormalizer`,
- reduce with `ClaudeTimelineReducer`,
- emit `session.updated` and `timeline.sync`.

This step should leave old JSONL files in place but stop `ClaudeSdkAdapter` from
delegating history sync to the legacy JSONL adapter.

Acceptance:

- Claude Chat Mode still streams live timeline items.
- `ClaudeSdkAdapter.sync_existing_sessions()` uses SDK history APIs.
- Live SDK chat sessions are skipped during scanner sync.
- Existing focused connector tests pass after updates.

### Step 2: Move Capability History Checks To SDK

Status: complete.

Change Claude capability discovery so history availability and session count come
from `list_sessions()` rather than `~/.claude/projects/**/*.jsonl`.

Implementation:

- `discover_claude_capability()` calls `_check_claude_history()` directly.
- `_check_claude_history()` calls `_list_claude_sdk_sessions()`.
- `_list_claude_sdk_sessions()` imports `claude_agent_sdk` and calls
  `list_sessions()`.
- Capability reports keep `historyCheck.sessionCount`, but now mark the source
  as `claude-agent-sdk` and the API as `list_sessions`.

Acceptance:

- Device capability reports still show Claude history status.
- No capability code imports `connector.claude.watcher`.

### Step 3: Delete Legacy JSONL/PTy Timeline Path

Status: complete.

Remove code that is no longer a supported Claude path:

- `connector/claude/adapter.py` legacy PTY-tail adapter,
- `connector/claude/watcher.py`,
- `connector/claude/reducer.py`,
- old TUI approval and PTY helper tests,
- imports that existed only for JSONL scanning or hidden PTY driving.

Do not remove generic terminal code. Terminal Mode uses the shared terminal
backend and is still required.

Implementation:

- removed the legacy Claude adapter, JSONL watcher, JSONL reducer, Claude-only
  PTY wrapper, and Claude TUI approval parser,
- removed tests that existed only for that legacy path,
- kept the shared terminal backend used by Terminal Mode,
- kept the SDK/live normalizer and timeline reducer used by Chat Mode and SDK
  history scanning.

Acceptance:

- No production code imports `ClaudeAdapter`, `ClaudeJsonlReducer`, or
  `watcher.py`.
- Terminal Mode still opens Claude through `terminal.create`.
- Chat Mode still sends messages through SDK `turn.start`.

### Step 4: Clean Up Cursor Naming And Backend Handling

Status: complete.

The old cursor event was named for transcript offsets. SDK history scanning does
not expose file offsets, so replace that with SDK-history sync state if needed.

Current state:

- external session id,
- last modified time,
- file size,
- message count,
- last message uuid.

Implementation:

- removed the backend `claude.transcriptCursorAdvanced` ingest branch,
- removed the `/connector/claude/transcript-cursors` endpoint,
- removed the `claude_transcript_cursors` table and repository wrappers,
- removed connector-side refresh of transcript cursors before Claude sync,
- kept SDK history state local to `ClaudeHistoryAdapter`,
- after a live SDK turn completes, `ClaudeSdkAdapter._mark_history_consumed()`
  lets the history adapter observe the latest SDK messages so unchanged
  sessions can be skipped,
- history scans are allowed to run during live SDK streams; duplicate or stale
  snapshot items are handled by the same `timeline.sync` merge rules used by
  Codex.

Acceptance:

- Live SDK streams do not block history scans.
- Repeated history scans rely on stable item ids and backend merge rules rather
  than a JSONL offset cursor.
- Repeated scans with no history changes do not re-arm unread state.
- Backend naming no longer implies JSONL offsets.

## Notes

The SDK history API still reads Claude Code's local storage internally, but that
is now the SDK's responsibility. The connector should treat it as a public API
that returns sessions and messages, not as files to parse.

`get_session_messages()` returns visible user and assistant messages in
chronological order. Assistant messages can contain text, thinking, tool use,
and some server-tool blocks. For history scanning, exact parity with live tool
streaming is not required; the scanner's job is to reconstruct readable history,
not to mirror every terminal event.
