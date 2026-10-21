"""Codex IDE/desktop IPC router client.

The Codex VS Code extension and the Codex desktop app share one app-server per
window and coordinate through a Unix socket router at ``$CODEX_HOME/ipc/ipc.sock``
(a named pipe on Windows). On top of that router they run a thread
owner/follower protocol: the window that loaded a thread into its app-server is
the owner, every other client can discover it, follow its state stream and ask
it to execute turns on their behalf.

This package implements the transport half of that protocol for the Connector:
frame codec, method version table, socket path rules, a minimal router (used
when no IDE or desktop app is running) and the asyncio client. Thread
following and projection live in higher layers.

The wire behaviour mirrors the ``IpcRouter`` / ``IpcClient`` implementation
shipped in the Codex extension bundle (``out/extension.js``) and is documented
in ``docs/codex-ipc-takeover.md``.
"""

from connector.runtimes.codex.ipc import deeplink
from connector.runtimes.codex.ipc.candidates import candidate_thread_ids
from connector.runtimes.codex.ipc.client import (
    CodexIpcClient,
    IpcBroadcast,
    IpcClientError,
    IpcNotConnectedError,
    IpcNotInitializedError,
    IpcRequest,
    IpcRequestTimeoutError,
    IpcResponse,
)
from connector.runtimes.codex.ipc.control import CodexIpcTurnController
from connector.runtimes.codex.ipc.follower import (
    FollowedThread,
    FollowerEvent,
    ThreadFollower,
)
from connector.runtimes.codex.ipc.framing import (
    MAX_FRAME_BYTES,
    FrameDecoder,
    IpcFrameError,
    encode_frame,
)
from connector.runtimes.codex.ipc.jsonpatch import JsonPatchError, apply_patches
from connector.runtimes.codex.ipc.owner import (
    CodexIpcOwnerService,
    conversation_state_from_thread,
)
from connector.runtimes.codex.ipc.paths import ipc_socket_path
from connector.runtimes.codex.ipc.projection import CodexIpcSessionProjector
from connector.runtimes.codex.ipc.router import IpcRouter
from connector.runtimes.codex.ipc.service import CodexIpcService
from connector.runtimes.codex.ipc.timeline import (
    active_turn_id,
    thread_snapshot_from_conversation_state,
)
from connector.runtimes.codex.ipc.versions import (
    METHOD_VERSIONS,
    accepts_version,
    version_for,
)

__all__ = [
    "MAX_FRAME_BYTES",
    "METHOD_VERSIONS",
    "CodexIpcClient",
    "CodexIpcOwnerService",
    "CodexIpcService",
    "CodexIpcSessionProjector",
    "CodexIpcTurnController",
    "FollowedThread",
    "FollowerEvent",
    "FrameDecoder",
    "IpcBroadcast",
    "IpcClientError",
    "IpcFrameError",
    "IpcNotConnectedError",
    "IpcNotInitializedError",
    "IpcRequest",
    "IpcRequestTimeoutError",
    "IpcResponse",
    "IpcRouter",
    "JsonPatchError",
    "ThreadFollower",
    "accepts_version",
    "active_turn_id",
    "apply_patches",
    "candidate_thread_ids",
    "conversation_state_from_thread",
    "deeplink",
    "encode_frame",
    "ipc_socket_path",
    "thread_snapshot_from_conversation_state",
    "version_for",
]
