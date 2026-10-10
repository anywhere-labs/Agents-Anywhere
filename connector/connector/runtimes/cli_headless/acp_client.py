"""Persistent ACP transport for headless CLI kernels.

The one-shot kernel spawns the CLI for every turn, which makes each message pay
the CLI's own start-up again: measured on this machine, `codebuddy --version`
takes 0.06s but a real turn spends ~3.2s before the first byte, and MiniMax Code
spends ~11s. Claude and Codex avoid that by keeping a long-lived connection
(`ClaudeSDKClient`, `codex app-server --listen stdio://`).

MiniMax Code can be driven the same way: `mcode acp` speaks the Agent Client
Protocol over ndJSON JSON-RPC on stdio. Measured on mcode 0.6.5, the second
prompt on one persistent process took 4.85s where a fresh process took 23.09s.

Protocol facts this client relies on, all observed against mcode 0.6.5 rather
than assumed:

* ``initialize`` -> ``protocolVersion: 1``, ``agentCapabilities.loadSession``
  true, ``agentInfo`` = minimax-code.
* ``session/new`` -> ``sessionId`` (``mvs_...``), plus ``modes`` and
  ``configOptions`` (permission mode, model list, thinking effort).
* ``session/prompt`` streams ``session/update`` notifications carrying
  ``agent_message_chunk`` / ``agent_thought_chunk`` / ``tool_call`` /
  ``tool_call_update``, then answers with ``stopReason``.
* ``session/load`` restores a session after the child process died, so
  continuity survives a connector restart.
* ``session/cancel`` stops a running turn and yields
  ``stopReason: "cancelled"``.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import AsyncIterator, Mapping
from contextlib import suppress
from typing import Any

from connector.logging import logger

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
ACP_PROTOCOL_VERSION = 1
START_TIMEOUT_SECONDS = 120.0
PROMPT_TIMEOUT_SECONDS = 1800.0
UPDATE_QUEUE_MAX = 4096

# ACP content chunk kinds that carry assistant text.
_TEXT_CHUNKS = ("agent_message_chunk", "agent_thought_chunk")


class AcpError(RuntimeError):
    """Any failure that makes the ACP transport unusable."""


def acp_argv(cli: str) -> list[str]:
    """Command line for the CLI's ACP server mode.

    ``mcode`` resolves to a ``.cmd`` shim on Windows, so the launcher is wrapped
    exactly like the one-shot argv builder wraps it.
    """

    lowered = cli.lower()
    if lowered.endswith(".js"):
        node = shutil.which("node")
        if node is None:
            raise AcpError("node was not found for the MiniMax CLI entrypoint")
        head = [node, cli]
    elif lowered.endswith((".cmd", ".bat")):
        head = ["cmd", "/d", "/c", cli]
    else:
        head = [cli]
    return [*head, "acp"]


class AcpClient:
    """One persistent ``<cli> acp`` process, shared by every turn."""

    def __init__(self, argv: list[str], cwd: str | None) -> None:
        self._argv = argv
        self._cwd = cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._stderr: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._updates: dict[str, asyncio.Queue[dict[str, Any] | None]] = {}
        self._next_id = 1
        self._closed = False

    # ------------------------------------------------------------- lifecycle

    @property
    def alive(self) -> bool:
        return (
            not self._closed
            and self._proc is not None
            and self._proc.returncode is None
        )

    async def start(self) -> None:
        if self.alive:
            return
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._argv,
                cwd=self._cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW,
            )
        except OSError as exc:
            raise AcpError(f"could not start ACP process {self._argv!r}: {exc}") from exc
        self._closed = False
        self._reader = asyncio.create_task(self._read_loop(), name="acp-reader")
        self._stderr = asyncio.create_task(self._drain_stderr(), name="acp-stderr")

    async def close(self) -> None:
        self._closed = True
        proc = self._proc
        self._proc = None
        if proc is not None:
            if proc.stdin is not None:
                with suppress(Exception):
                    proc.stdin.close()
            if proc.returncode is None:
                await self._terminate(proc)
        for task in (self._reader, self._stderr):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(t for t in (self._reader, self._stderr) if t is not None),
            return_exceptions=True,
        )
        self._fail_pending(AcpError("ACP process closed"))

    async def _terminate(self, proc: asyncio.subprocess.Process) -> None:
        """Stop the CLI and everything it spawned.

        On Windows the process is ``cmd /c mcode.CMD acp``, so killing the child
        handle leaves the real Node process running; kill the whole tree.
        """

        if os.name == "nt":
            with suppress(Exception):
                killer = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/F",
                    "/T",
                    "/PID",
                    str(proc.pid),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=CREATE_NO_WINDOW,
                )
                await asyncio.wait_for(killer.wait(), timeout=20)
        else:
            with suppress(ProcessLookupError):
                proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=20)
        except TimeoutError:  # pragma: no cover - defensive
            logger.warning("acp process {} did not exit after kill", proc.pid)

    async def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                logger.debug("acp stderr: {}", line.decode("utf-8", "replace").rstrip())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - stderr is diagnostics only
            return

    async def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    logger.debug("acp emitted a non-JSON line: {}", line[:200])
                    continue
                if isinstance(message, dict):
                    self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the turn must fail, not hang
            logger.warning("acp reader stopped: {!r}", exc)
        finally:
            self._fail_pending(AcpError("ACP process exited"))

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if isinstance(method, str):
            if message.get("id") is not None:
                # Server -> client request. Nothing is advertised, so answer
                # politely instead of leaving the agent waiting forever.
                self._reply_unsupported(message)
                return
            self._dispatch_notification(method, message.get("params"))
            return
        message_id = message.get("id")
        future = self._pending.pop(message_id, None) if isinstance(message_id, int) else None
        if future is not None and not future.done():
            future.set_result(message)

    def _dispatch_notification(self, method: str, params: Any) -> None:
        if method != "session/update" or not isinstance(params, dict):
            return
        session_id = params.get("sessionId")
        update = params.get("update")
        if not isinstance(session_id, str) or not isinstance(update, dict):
            return
        queue = self._updates.get(session_id)
        if queue is None:
            return
        try:
            queue.put_nowait(update)
        except asyncio.QueueFull:  # pragma: no cover - defensive
            logger.warning("acp update queue full for session={}", session_id)

    def _reply_unsupported(self, message: dict[str, Any]) -> None:
        method = str(message.get("method"))
        if method == "session/request_permission":
            # The session runs with permissionMode=bypassPermissions, so this
            # should not arrive; allow it rather than stalling the turn.
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {"outcome": {"outcome": "selected", "optionId": "allow"}},
                }
            )
            return
        self._send(
            {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {"code": -32601, "message": f"unsupported client method {method}"},
            }
        )

    def _send(self, payload: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise AcpError("ACP process is not running")
        data = json.dumps(payload, ensure_ascii=False) + "\n"
        proc.stdin.write(data.encode("utf-8"))

    async def _drain_stdin(self) -> None:
        proc = self._proc
        if proc is not None and proc.stdin is not None:
            try:
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise AcpError("ACP process closed its input") from exc

    async def _request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        if not self.alive:
            raise AcpError("ACP process is not running")
        message_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        try:
            self._send({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params})
            await self._drain_stdin()
            response = await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError as exc:
            raise AcpError(f"ACP {method} timed out after {timeout:.0f}s") from exc
        finally:
            self._pending.pop(message_id, None)
        error = response.get("error")
        if isinstance(error, dict):
            raise AcpError(f"ACP {method} failed: {error.get('message') or error}")
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    def _fail_pending(self, error: Exception) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
        for queue in list(self._updates.values()):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:  # pragma: no cover - defensive
                pass

    # -------------------------------------------------------------- protocol

    async def initialize(self) -> dict[str, Any]:
        return await self._request(
            "initialize",
            {
                "protocolVersion": ACP_PROTOCOL_VERSION,
                # Nothing is advertised: the agent uses its own filesystem and
                # shell tools, exactly like the one-shot kernel.
                "clientCapabilities": {},
            },
            timeout=START_TIMEOUT_SECONDS,
        )

    async def new_session(self, cwd: str | None, mcp_servers: list[Any] | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"mcpServers": list(mcp_servers or [])}
        if cwd:
            params["cwd"] = cwd
        return await self._request("session/new", params, timeout=START_TIMEOUT_SECONDS)

    async def load_session(
        self,
        session_id: str,
        cwd: str | None,
        mcp_servers: list[Any] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "sessionId": session_id,
            "mcpServers": list(mcp_servers or []),
        }
        if cwd:
            params["cwd"] = cwd
        return await self._request("session/load", params, timeout=START_TIMEOUT_SECONDS)

    async def set_config_option(
        self,
        session_id: str,
        config_id: str,
        value: str,
    ) -> dict[str, Any]:
        return await self._request(
            "session/set_config_option",
            {"sessionId": session_id, "configId": config_id, "value": value},
            timeout=START_TIMEOUT_SECONDS,
        )

    async def cancel(self, session_id: str) -> None:
        """Ask the agent to stop the running turn (``session/cancel``)."""

        if not self.alive:
            return
        self._send(
            {
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": {"sessionId": session_id},
            }
        )
        await self._drain_stdin()

    async def prompt(
        self,
        session_id: str,
        text: str,
        *,
        timeout: float = PROMPT_TIMEOUT_SECONDS,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream one turn's updates, finishing when the agent answers.

        Yields each ``session/update`` payload, then one final
        ``{"__stopReason": ...}`` mapping. Raises :class:`AcpError` on protocol
        failure so the caller can fall back to the one-shot path.
        """

        if not self.alive:
            raise AcpError("ACP process is not running")
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=UPDATE_QUEUE_MAX)
        self._updates[session_id] = queue
        message_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        try:
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": message_id,
                    "method": "session/prompt",
                    "params": {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": text}],
                    },
                }
            )
            await self._drain_stdin()
            loop = asyncio.get_running_loop()
            deadline = loop.time() + timeout
            while True:
                if future.done():
                    break
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise AcpError(f"ACP prompt timed out after {timeout:.0f}s")
                updated = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait(
                    {updated, future},
                    timeout=remaining,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if future in done:
                    updated.cancel()
                    # Drain anything that arrived with the response.
                    while not queue.empty():
                        item = queue.get_nowait()
                        if item is not None:
                            yield item
                    break
                if updated in done:
                    item = updated.result()
                    if item is None:
                        raise AcpError("ACP process exited during the turn")
                    yield item
            response = future.result()
        except TimeoutError as exc:  # pragma: no cover - defensive
            raise AcpError("ACP prompt timed out") from exc
        finally:
            self._pending.pop(message_id, None)
            self._updates.pop(session_id, None)
        error = response.get("error")
        if isinstance(error, dict):
            raise AcpError(f"ACP prompt failed: {error.get('message') or error}")
        result = response.get("result")
        stop_reason = result.get("stopReason") if isinstance(result, dict) else None
        yield {"__stopReason": stop_reason if isinstance(stop_reason, str) else "end_turn"}


def chunk_text(update: Mapping[str, Any]) -> str | None:
    """Assistant text carried by a ``session/update`` payload, if any."""

    if update.get("sessionUpdate") not in _TEXT_CHUNKS:
        return None
    content = update.get("content")
    if not isinstance(content, dict):
        return None
    text = content.get("text")
    return text if isinstance(text, str) and text else None


def thought_flag(update: Mapping[str, Any]) -> bool:
    return update.get("sessionUpdate") == "agent_thought_chunk"
