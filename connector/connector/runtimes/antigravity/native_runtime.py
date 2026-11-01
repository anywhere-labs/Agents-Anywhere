"""Native Antigravity history browsing and cross-client continuation.

Reuses the zcode native-history runtime (scan/publish/recover orchestration)
with Antigravity's summaries index and per-conversation transcript reader.
Continuing attaches the bridge to the desktop conversation via
``--conversation <id>`` (the bridge maps ``ag-<id>`` session identities).
"""

from __future__ import annotations

from pathlib import Path

from .native_history import discover_sessions, read_history, timeline
from ..zcode.native_runtime import NativeZcodeRuntime


class NativeAntigravityRuntime(NativeZcodeRuntime):
    def __init__(self, *args, history_db_path, conversations_dir, **kwargs):
        super().__init__(*args, history_db_path=history_db_path, **kwargs)
        self.conversations_dir = Path(conversations_dir)

    def discover_native_sessions(self):
        return discover_sessions(self.history_db_path)

    def read_native_history(self, native_id):
        return read_history(self.history_db_path, self.conversations_dir, native_id)

    def agent_session_id(self, native_id: str) -> str:
        # The bridge resumes desktop conversations by id: "ag-<conversation>".
        return "ag-" + native_id

    def native_timeline(self, history, session_id: str) -> list[dict]:
        return timeline(history, session_id, self.config.runtime)
