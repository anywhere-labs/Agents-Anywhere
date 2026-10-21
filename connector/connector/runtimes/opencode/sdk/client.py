"""Async HTTP + SSE client for a local ``opencode serve`` (V2 API) instance.

Endpoint map (verified against opencode 2.0.27 by live probe on this machine:
a password-protected serve, a real turn with a real model, and the bundled
``/openapi.json``). Everything moved to ``/api/*``; the 1.x routes (including
``/global/health`` and ``/session/status``) are gone. Two traps shape the code:

- **HTTP Basic is mandatory.** ``/api/*`` answers 401 unless
  ``OPENCODE_SERVER_PASSWORD`` matches (username defaults to ``opencode``,
  ``OPENCODE_SERVER_USERNAME`` overrides); there is no unauthenticated mode, so
  the runtime injects a generated password when it auto-starts a serve.
- **Unknown routes answer 200 + the web UI.** A mistyped path looks like a
  successful call unless the body is inspected, so every JSON response is
  checked (``_is_html``) and the HTML fallback is rejected.

Routes used here:

- ``GET  /api/info``                      health/identity (flat ``ServerInfo``)
- ``GET  /api/session``                   list sessions (``{data, cursor}``)
- ``POST /api/session``                   create session (``{title, location:{directory}}``)
- ``GET  /api/session/{id}``              session info (``{data}``; ``location.directory``)
- ``GET  /api/session/active``            busy map ``{ses_x: {type: "running"}}`` (global)
- ``GET  /api/session/{id}/message``       message list (``{data, cursor}``, newest first)
- ``POST /api/session/{id}/prompt``       admit a prompt (``{text, delivery}``)
- ``POST /api/session/{id}/interrupt``    abort the turn
- ``POST /api/session/{id}/model``        switch model (``{model: Model.Ref}``)
- ``POST /api/session/{id}/agent``        switch agent (``{agent}``)
- ``GET  /api/session/{id}/permission``   pending permission requests
- ``POST /api/session/{id}/permission/{pid}/reply`` ``{decision: once|always|reject}``
- ``GET  /api/session/{id}/form``         pending forms (opencode's "questions")
- ``POST /api/session/{id}/form/{fid}/reply`` ``{answer: {fieldId: value}}``
- ``DELETE /api/session/{id}/form/{fid}`` dismiss a form
- ``POST /api/session/{id}/command``       run a user command
- ``POST /api/session/{id}/compact``      compact the conversation
- ``POST /api/session/{id}/fork``          fork the session
- ``GET  /api/agent`` / ``/api/command``  catalogs (``{location, data}``)
- ``GET  /api/model`` + ``/api/provider`` model catalog
- ``GET  /api/event``                     live-only SSE (no replay)

Shape adaptation lives here, not in the runtime, so the timeline projection
(``timeline.py``) keeps the ``{info, parts}`` message contract:

- message list: V2 flat ``Session.Message.Info`` union -> ``{info, parts}``,
  chronological order, ``idle``/``model-switched``/... dropped;
- busy map: ``{"type": "running"}`` -> ``{"type": "busy"}``;
- event stream: V2 frames -> the ``{type, properties}`` events the runtime's
  ``_handle_event`` dispatches on.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any
from urllib.parse import quote, urlencode

import httpx

# Read budget for the auto-start "is a serve already there?" precheck. The
# client's default connect timeout is generous on purpose (a busy serve can be
# slow to answer), but paying it while nothing is listening only delays the spawn.
HEALTH_FAST_TIMEOUT_S = 1.5

# Page size / bounds for the two paginated collections (sessions, messages).
# V2 answers with ``{data, cursor}``; a single fetch is only the first page, and
# treating it as the full inventory would make session sync delete everything
# beyond the first page.
PAGE_SIZE = 200
MAX_PAGES = 25

# Synthesized part ids for streamed assistant content. V2 streams deltas per
# ``(assistantMessageID, kind, ordinal)`` and stores content parts **without**
# ids, so the same scheme is used on both paths: a streamed item and the
# turn-end snapshot describe the same platform item instead of duplicating it.
_PART_KINDS = frozenset({"text", "reasoning"})


class OpenCodeClientError(RuntimeError):
    """Raised when the opencode server rejects a request or is unreachable."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def append_directory_param(path: str, directory: str) -> str:
    """Append the project ``directory`` query parameter.

    V2 dropped the per-instance routing of 1.x (one serve serves every project)
    and instead uses ``directory`` as a filter on the collection routes
    (``GET /api/session``, ``/api/agent``, ``/api/command``). Kept as a helper so
    the filter stays a single place.
    """

    separator = "&" if "?" in path else "?"
    return f"{path}{separator}directory={quote(directory, safe='')}"


def _is_html(content_type: str, body: str) -> bool:
    """True when a response is the opencode web UI instead of an API payload."""

    if "html" in content_type.lower():
        return True
    head = body.lstrip()[:64].lower()
    return head.startswith(("<!doctype html", "<html"))


def _unwrap(payload: Any) -> Any:
    """Unwrap the ``{"data": ...}`` envelope every V2 route answers with."""

    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _tool_state(raw: Any) -> dict[str, Any]:
    """Normalize a V2 tool state into the ``{status, input, output}`` shape.

    V2 reports output either as a plain string or as a list of content blocks
    (``[{"type": "text", "text": ...}]``); both collapse to one string. Status
    vocabulary is ``running`` / ``streaming`` / ``completed`` / ``error`` /
    ``pending`` and ``timeline._TOOL_STATUS_MAP`` understands all of them.
    """

    state = raw if isinstance(raw, dict) else {}
    status = str(state.get("status") or "pending")
    output = state.get("output")
    if output is None and isinstance(state.get("content"), list):
        chunks: list[str] = []
        for block in state["content"]:
            if isinstance(block, dict):
                chunks.append(_as_text(block.get("text")))
            elif isinstance(block, str):
                chunks.append(block)
        output = "".join(chunks)
    if output is None and state.get("error"):
        output = _as_text(state.get("error"))
    return {"status": status, "input": state.get("input"), "output": output}


def _adapt_user_message(raw: Mapping[str, Any]) -> dict[str, Any]:
    """V2 user message -> ``{info, parts}``.

    V2 keeps the prompt text on the message itself (``text``) instead of a text
    part; it is projected into a single non-synthetic text part so the timeline
    mapper and the clientMessageId matcher see the shape they expect.
    """

    message_id = str(raw.get("id") or "")
    created = (raw.get("time") or {}).get("created") if isinstance(raw.get("time"), dict) else None
    parts: list[dict[str, Any]] = []
    text = _as_text(raw.get("text"))
    if text:
        parts.append({"id": f"{message_id}:text:0", "type": "text", "text": text})
    for index, file in enumerate(raw.get("files") or ()):
        if not isinstance(file, Mapping):
            continue
        url = str(file.get("uri") or file.get("url") or "")
        if not url:
            continue
        part: dict[str, Any] = {"id": f"{message_id}:file:{index}", "type": "file", "url": url}
        name = str(file.get("name") or file.get("filename") or "")
        if name:
            part["filename"] = name
        mime = file.get("mime") or file.get("mimeType")
        if isinstance(mime, str) and mime:
            part["mime"] = mime
        parts.append(part)
    return {
        "info": {"id": message_id, "role": "user", "time": {"created": created}},
        "parts": parts,
    }


def _adapt_assistant_message(raw: Mapping[str, Any]) -> dict[str, Any]:
    """V2 assistant message -> ``{info, parts}``.

    ``content[]`` entries are projected to ``text`` / ``reasoning`` / ``tool``
    parts; ``model`` (a ``Model.Ref``) is flattened into ``info.providerID`` /
    ``info.modelID`` because the runtime reads those keys when it reports the
    session's current model, and ``time.completed`` is what marks the message
    finished (turn-boundary detection and "assistant still running" checks).
    """

    message_id = str(raw.get("id") or "")
    time = raw.get("time") if isinstance(raw.get("time"), dict) else {}
    model = raw.get("model") if isinstance(raw.get("model"), dict) else {}
    parts: list[dict[str, Any]] = []
    per_kind: dict[str, int] = {}
    for entry in raw.get("content") or ():
        if not isinstance(entry, Mapping):
            continue
        kind = str(entry.get("type") or "")
        if kind not in _PART_KINDS and kind != "tool":
            continue
        index = per_kind.get(kind, 0)
        per_kind[kind] = index + 1
        if kind == "tool":
            state = _tool_state(entry.get("state"))
            name = str(entry.get("tool") or entry.get("name") or "tool")
            parts.append(
                {
                    "id": str(entry.get("id") or f"{message_id}:tool:{index}"),
                    "type": "tool",
                    "tool": name,
                    "state": state,
                    "callID": str(entry.get("callID") or entry.get("id") or ""),
                }
            )
            continue
        part: dict[str, Any] = {
            "id": f"{message_id}:{kind}:{index}",
            "type": kind,
            "text": _as_text(entry.get("text")),
        }
        time_entry = entry.get("time")
        if isinstance(time_entry, dict):
            part["time"] = dict(time_entry)
        parts.append(part)
    info: dict[str, Any] = {
        "id": message_id,
        "role": "assistant",
        "time": {
            "created": time.get("created"),
            "completed": time.get("completed"),
            "streamed": time.get("streamed"),
        },
    }
    if model:
        info["modelID"] = model.get("id")
        info["providerID"] = model.get("providerID")
        variant = model.get("variant")
        if variant:
            info["variant"] = variant
    return {"info": info, "parts": parts}


def _adapt_message(raw: Any) -> dict[str, Any] | None:
    """One V2 message entry -> ``{info, parts}``, or ``None`` when not renderable.

    The union also carries ``idle`` / ``model-switched`` / ``agent-switched`` /
    ``system`` / ``compaction`` markers, none of which are timeline items.
    """

    if not isinstance(raw, Mapping):
        return None
    kind = str(raw.get("type") or "")
    if kind == "user":
        return _adapt_user_message(raw)
    if kind == "assistant":
        return _adapt_assistant_message(raw)
    return None


def _adapt_event(frame: Mapping[str, Any]) -> list[dict[str, Any]]:
    """One V2 SSE frame -> the runtime's ``{type, properties}`` events.

    V2 publishes session work as ordered event types under ``data``:
    ``session.execution.started`` opens a turn, ``session.text.delta`` /
    ``session.reasoning.delta`` stream content keyed by
    ``(assistantMessageID, ordinal)``, ``session.text.ended`` /
    ``session.reasoning.ended`` restate it complete, and ``session.step.ended``
    marks the assistant message complete. There is no terminal ``session.idle``
    event; turn end is detected by polling the active map (see the runtime's
    watchdog), which is also what an unanswered permission/question needs.
    """

    frame_type = str(frame.get("type") or frame.get("event") or "")
    data = frame.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            data = None
    if not isinstance(data, Mapping):
        data = {}
    session_id = str(data.get("sessionID") or frame.get("sessionID") or "")
    if not session_id:
        return []
    properties: dict[str, Any] = {"sessionID": session_id}
    if frame_type == "session.execution.started":
        return [{"type": "session.status", "properties": {**properties, "status": {"type": "busy"}}}]
    if frame_type == "session.text.delta" or frame_type == "session.reasoning.delta":
        delta = data.get("delta")
        message_id = str(data.get("assistantMessageID") or "")
        ordinal = data.get("ordinal")
        if not isinstance(delta, str) or not delta or not message_id:
            return []
        kind = "text" if frame_type == "session.text.delta" else "reasoning"
        return [
            {
                "type": "message.part.delta",
                "properties": {
                    **properties,
                    "messageID": message_id,
                    "partID": f"{message_id}:{kind}:{ordinal}",
                    "field": "text",
                    "delta": delta,
                },
            }
        ]
    if frame_type in {"session.text.ended", "session.reasoning.ended"}:
        message_id = str(data.get("assistantMessageID") or "")
        if not message_id:
            return []
        ordinal = data.get("ordinal")
        kind = "text" if frame_type == "session.text.ended" else "reasoning"
        return [
            {
                "type": "message.part.updated",
                "properties": {
                    **properties,
                    "part": {
                        "id": f"{message_id}:{kind}:{ordinal}",
                        "type": kind,
                        "messageID": message_id,
                        "text": _as_text(data.get("text")),
                    },
                },
            }
        ]
    if frame_type == "session.step.ended":
        message_id = str(data.get("assistantMessageID") or "")
        if not message_id:
            return []
        created = frame.get("created")
        return [
            {
                "type": "message.updated",
                "properties": {
                    **properties,
                    "info": {
                        "id": message_id,
                        "role": "assistant",
                        "time": {"completed": created or 0},
                    },
                },
            }
        ]
    if frame_type == "session.step.started":
        message_id = str(data.get("assistantMessageID") or "")
        if not message_id:
            return []
        return [
            {
                "type": "message.updated",
                "properties": {**properties, "info": {"id": message_id, "role": "assistant"}},
            }
        ]
    if frame_type == "session.error":
        error = data.get("error")
        return [
            {
                "type": "session.error",
                "properties": {
                    **properties,
                    "error": error if isinstance(error, Mapping) else {"message": _as_text(data)},
                },
            }
        ]
    if frame_type.startswith("session.updated"):
        return [
            {
                "type": "session.updated",
                "properties": {
                    **properties,
                    "info": {
                        "title": data.get("title"),
                        "time": {"updated": frame.get("created")},
                    },
                },
            }
        ]
    return []


class OpenCodeClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout: float = 60.0,
        stream_timeout: float | None = None,
        api_user: str = "opencode",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.api_user = api_user
        self.stream_timeout = stream_timeout if stream_timeout is not None else timeout
        self.timeout = timeout
        self._http: httpx.AsyncClient | None = None

    def _authorization(self) -> str:
        # opencode serve protects itself with HTTP Basic (username defaults to
        # "opencode", overridable via OPENCODE_SERVER_USERNAME).
        token = base64.b64encode(f"{self.api_user}:{self.api_key}".encode()).decode()
        return f"Basic {token}"

    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            headers: dict[str, str] = {}
            if self.api_key:
                headers["Authorization"] = self._authorization()
            self._http = httpx.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=httpx.Timeout(self.timeout, connect=10.0),
            )
        return self._http

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    def set_credentials(self, api_user: str, api_key: str) -> None:
        """Adopt credentials discovered after construction.

        ``opencode serve`` inherits ``OPENCODE_SERVER_PASSWORD`` (and possibly
        ``OPENCODE_SERVER_USERNAME``) from the environment, so an auto-started
        instance requires Basic auth even when the runtime config left
        ``apiKey`` empty. The auto-start path generates a password and injects
        it into the spawn environment when the user environment has none.
        """

        if not api_key:
            return
        self.api_user = api_user
        self.api_key = api_key
        if self._http is not None:
            self._http.headers["Authorization"] = self._authorization()

    # ------------------------------------------------------------------ #
    # REST
    # ------------------------------------------------------------------ #

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        directory: str | None = None,
        timeout: httpx.Timeout | float | None = None,
    ) -> Any:
        client = await self._client()
        if directory:
            path = append_directory_param(path, directory)
        try:
            response = await client.request(method, path, json=json_body, timeout=timeout)
        except httpx.HTTPError as exc:
            raise OpenCodeClientError(f"opencode server unreachable: {exc}") from exc
        if response.status_code >= 400:
            # Surface the response body so callers see opencode's actual error
            # detail (e.g. ``{"_tag":"InvalidRequestError","message":"..."}``)
            # instead of just the bare status code, which is useless for triage.
            body_excerpt = (response.text or "").strip()
            if len(body_excerpt) > 400:
                body_excerpt = body_excerpt[:400] + "..."
            raise OpenCodeClientError(
                f"opencode {method} {path} failed: {response.status_code}"
                + (f" body={body_excerpt}" if body_excerpt else ""),
                status_code=response.status_code,
            )
        # 204 / empty bodies are normal (prompt admit, model switch, interrupt).
        if response.status_code == 204 or not response.content:
            return None
        # opencode answers unknown routes with the web UI (HTTP 200 + HTML), so
        # a mistyped path would otherwise look like a successful call.
        if _is_html(response.headers.get("content-type", ""), response.text):
            raise OpenCodeClientError(
                f"opencode {method} {path} answered {response.status_code} with the "
                "web UI instead of JSON; the route does not exist on this opencode "
                "version"
            )
        return response.json()

    async def health(self, *, fast: bool = False) -> dict[str, Any] | None:
        """``GET /api/info``.

        ``fast`` uses a short connect timeout for the "is anything listening?"
        precheck on the auto-start path: with the client's default (10s connect)
        a dead port costs several seconds of ADE attempts before the runtime is
        even allowed to spawn, and the client shows ``starting`` throughout.
        """

        timeout = httpx.Timeout(HEALTH_FAST_TIMEOUT_S, connect=1.0) if fast else None
        payload = await self._request("GET", "/api/info", timeout=timeout)
        if not isinstance(payload, dict):
            return None
        return payload

    async def _collect_pages(
        self,
        path: str,
        *,
        directory: str | None = None,
    ) -> list[Any]:
        """Follow ``cursor.next`` until the collection is exhausted."""

        collected: list[Any] = []
        cursor: str | None = None
        for _ in range(MAX_PAGES):
            params = {"limit": str(PAGE_SIZE)}
            if cursor:
                params["cursor"] = cursor
            query = urlencode(params)
            payload = await self._request("GET", f"{path}?{query}", directory=directory)
            data = _unwrap(payload)
            if isinstance(data, list):
                collected.extend(data)
            next_cursor = None
            if isinstance(payload, Mapping):
                cursor_entry = payload.get("cursor") or {}
                if isinstance(cursor_entry, Mapping):
                    raw_next = cursor_entry.get("next")
                    if isinstance(raw_next, str) and raw_next:
                        next_cursor = raw_next
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor
        return collected

    async def list_sessions(self) -> list[dict[str, Any]]:
        """All sessions across projects, newest first (V2 paginates)."""

        data = await self._collect_pages("/api/session")
        return [item for item in data if isinstance(item, dict)]

    async def list_agents(self, directory: str | None = None) -> list[dict[str, Any]]:
        """List opencode agents (build/plan/compaction/...).

        Each ``primary`` agent is a mode a user can switch to (``build`` is the
        read-write default, ``plan`` is read-only). The connector uses the list
        to expose Build/Plan as permission presets and to check that a selected
        mode exists in this project. Agents resolve per project config, so
        ``directory`` selects which project's agents are returned (without it,
        opencode answers for the serve cwd).
        """

        data = _unwrap(await self._request("GET", "/api/agent", directory=directory))
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    async def get_session(self, session_id: str, directory: str | None = None) -> dict[str, Any]:
        data = _unwrap(await self._request("GET", f"/api/session/{session_id}", directory=directory))
        if not isinstance(data, dict):
            raise OpenCodeClientError(f"session {session_id} not found")
        return data

    async def list_messages(self, session_id: str, directory: str | None = None) -> list[dict[str, Any]]:
        """Session messages as ``{info, parts}``, oldest first.

        V2 stores one flat record per message with ``content[]`` instead of the
        1.x ``{info, parts}`` pair, and answers newest-first. Adapting here
        keeps ``timeline.py`` and the clientMessageId matcher on one shape.
        """

        entries = await self._collect_pages(f"/api/session/{session_id}/message", directory=directory)
        messages: list[dict[str, Any]] = []
        for entry in reversed(entries):
            adapted = _adapt_message(entry)
            if adapted is not None:
                messages.append(adapted)
        return messages

    async def create_session(
        self,
        title: str | None = None,
        directory: str | None = None,
    ) -> dict[str, Any]:
        # V2 nests the project directory under ``location``; a flat ``directory``
        # key is rejected (the request body is a closed schema).
        body: dict[str, Any] = {}
        if title:
            body["title"] = title
        if directory:
            body["location"] = {"directory": directory}
        data = _unwrap(
            await self._request("POST", "/api/session", json_body=body or None, directory=directory)
        )
        if not isinstance(data, dict) or "id" not in data:
            raise OpenCodeClientError("session create returned no session id")
        return data

    async def prompt_async(
        self,
        session_id: str,
        content: str,
        model: dict[str, str] | None = None,
        agent: str | None = None,
        directory: str | None = None,
        extra_parts: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        """Admit a prompt; opencode executes the turn asynchronously.

        V2 has no per-prompt model/agent override, so the selection is applied
        to the session first (``POST /model`` verified 204; ``POST /agent``) and
        the prompt itself only carries text plus ``files``. ``delivery:
        "steer"`` interrupts an in-flight turn with the new text instead of
        queueing behind it.
        """

        files: list[dict[str, str]] = []
        for part in extra_parts:
            if not isinstance(part, Mapping) or part.get("type") != "file":
                continue
            uri = str(part.get("url") or "")
            if not uri:
                continue
            entry: dict[str, str] = {"uri": uri}
            name = str(part.get("filename") or "")
            if name:
                entry["name"] = name
            files.append(entry)
        if not content and not files:
            return
        if model:
            await self.switch_session_model(
                session_id,
                str(model.get("modelID") or model.get("id") or ""),
                str(model.get("providerID") or ""),
                variant=model.get("variant"),
                directory=directory,
            )
        if agent:
            await self.switch_session_agent(session_id, agent, directory=directory)
        body: dict[str, Any] = {"text": content, "delivery": "steer"}
        if files:
            body["files"] = files
        await self._request(
            "POST",
            f"/api/session/{session_id}/prompt",
            json_body=body,
            directory=directory,
        )

    async def abort(self, session_id: str, directory: str | None = None) -> None:
        await self._request("POST", f"/api/session/{session_id}/interrupt", directory=directory)

    async def reply_permission(
        self,
        session_id: str,
        permission_id: str,
        response: str,
        directory: str | None = None,
    ) -> None:
        """Respond to a pending permission request.

        ``response`` is one of ``once`` (approve this once), ``always``
        (approve and remember for the session) or ``reject``.
        """

        await self._request(
            "POST",
            f"/api/session/{session_id}/permission/{permission_id}/reply",
            json_body={"decision": response},
            directory=directory,
        )

    async def list_pending_permissions(
        self, session_id: str, directory: str | None = None
    ) -> list[dict[str, Any]]:
        """Pending permission requests for one session (V2 keeps the list server-side)."""

        data = _unwrap(
            await self._request("GET", f"/api/session/{session_id}/permission", directory=directory)
        )
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    async def list_pending_forms(self, session_id: str, directory: str | None = None) -> list[dict[str, Any]]:
        """Pending forms (opencode's mid-turn questions) for one session."""

        data = _unwrap(await self._request("GET", f"/api/session/{session_id}/form", directory=directory))
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    async def reply_question(
        self,
        session_id: str,
        question_id: str,
        reply: str | Mapping[str, Any] | Sequence[Any],
        directory: str | None = None,
    ) -> None:
        """Answer a form the model asked mid-turn.

        V2 answers a form with ``{"answer": {fieldId: value}}`` — one entry per
        form field. A mapping is used as-is when its keys are field ids; question
        notices that only know the question order fall back to matching the
        mapping values against the form's visible fields in order. A plain
        string remains supported for legacy free-text callers and is submitted
        for every field, as before.
        """

        fields: list[Mapping[str, Any]] = []
        try:
            detail = _unwrap(
                await self._request(
                    "GET", f"/api/session/{session_id}/form/{question_id}", directory=directory
                )
            )
        except OpenCodeClientError:
            detail = None
        if isinstance(detail, Mapping):
            for field in detail.get("fields") or ():
                if isinstance(field, Mapping):
                    fields.append(field)
        field_ids: list[str] = []
        visible_ids: list[str] = []
        for field in fields:
            # V2 form fields are keyed by ``key`` (``id`` on older builds).
            field_id = str(field.get("key") or field.get("id") or "")
            if not field_id:
                continue
            field_ids.append(field_id)
            if not field.get("hidden"):
                visible_ids.append(field_id)
        if not field_ids:
            raise OpenCodeClientError(f"form {question_id} has no answerable field")
        if isinstance(reply, str):
            answer = {field_id: reply for field_id in field_ids}
        elif isinstance(reply, Mapping):
            answer = {
                field_id: reply[field_id]
                for field_id in field_ids
                if field_id in reply
            }
            if not answer:
                values = list(reply.values())
                if len(values) == len(visible_ids):
                    answer = dict(zip(visible_ids, values, strict=True))
                elif len(values) == 1 and visible_ids:
                    answer = {field_id: values[0] for field_id in visible_ids}
                else:
                    raise OpenCodeClientError(
                        f"form {question_id} answers do not match its fields"
                    )
        elif isinstance(reply, Sequence):
            values = list(reply)
            if len(values) != len(visible_ids):
                raise OpenCodeClientError(
                    f"form {question_id} expected {len(visible_ids)} answers, got {len(values)}"
                )
            answer = dict(zip(visible_ids, values, strict=True))
        else:
            raise OpenCodeClientError(
                f"form {question_id} answer has unsupported type {type(reply).__name__}"
            )
        await self._request(
            "POST",
            f"/api/session/{session_id}/form/{question_id}/reply",
            json_body={"answer": answer},
            directory=directory,
        )

    async def reject_question(
        self,
        session_id: str,
        question_id: str,
        directory: str | None = None,
    ) -> None:
        """Dismiss a form without answering it."""

        await self._request(
            "DELETE", f"/api/session/{session_id}/form/{question_id}", directory=directory
        )

    async def list_commands(self, directory: str | None = None) -> list[dict[str, Any]]:
        data = _unwrap(await self._request("GET", "/api/command", directory=directory))
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    async def execute_command(
        self,
        session_id: str,
        command: str,
        arguments: str = "",
        directory: str | None = None,
    ) -> dict[str, Any] | None:
        """Run a user-defined command inside the session.

        V2's body is ``{name, text}``: the command name and the rest of the
        command line. The route answers 204, so nothing is returned.
        """

        body: dict[str, Any] = {"name": command}
        if arguments:
            body["text"] = arguments
        data = await self._request(
            "POST",
            f"/api/session/{session_id}/command",
            json_body=body,
            directory=directory,
        )
        payload = _unwrap(data)
        return payload if isinstance(payload, dict) else None

    async def switch_session_model(
        self,
        session_id: str,
        model_id: str,
        provider_id: str,
        variant: str | None = None,
        directory: str | None = None,
    ) -> None:
        """Switch the model used by subsequent turns (``POST /api/session/{id}/model``).

        ``model_id`` is the bare model id without the provider prefix
        (e.g. ``qwen3.8-27b``), and ``provider_id`` is the provider key
        from ``opencode.json`` (e.g. ``local``). The opencode web UI's
        ``/model`` slash command maps to this endpoint.
        """

        model: dict[str, Any] = {"id": model_id, "providerID": provider_id}
        if variant:
            model["variant"] = variant
        await self._request(
            "POST",
            f"/api/session/{session_id}/model",
            json_body={"model": model},
            directory=directory,
        )

    async def switch_session_agent(
        self,
        session_id: str,
        agent: str,
        directory: str | None = None,
    ) -> None:
        """Switch the agent subsequent turns run as (Build/Plan)."""

        await self._request(
            "POST",
            f"/api/session/{session_id}/agent",
            json_body={"agent": agent},
            directory=directory,
        )

    async def summarize_session(
        self,
        session_id: str,
        provider_id: str,
        model_id: str,
        directory: str | None = None,
    ) -> bool:
        """Compact the session conversation (``POST /api/session/{id}/compact``).

        V2 compacts with the session's own model, so no model reference is sent
        (the body only accepts an optional message id and a delivery mode).
        """

        await self._request(
            "POST",
            f"/api/session/{session_id}/compact",
            json_body={},
            directory=directory,
        )
        return True

    async def fork_session(
        self,
        session_id: str,
        message_id: str | None = None,
        directory: str | None = None,
    ) -> dict[str, Any] | None:
        """Fork a session before ``message_id`` (``POST /api/session/{id}/fork``).

        Returns the new session object. V2's boundary is expressed as ``before``
        (the fork starts at that message); ``message_id`` is optional, and
        without it opencode forks at the latest message.
        """

        body: dict[str, Any] = {}
        if message_id:
            body["before"] = message_id
        data = _unwrap(
            await self._request(
                "POST",
                f"/api/session/{session_id}/fork",
                json_body=body or None,
                directory=directory,
            )
        )
        return data if isinstance(data, dict) else None

    async def revert_latest_message(
        self,
        session_id: str,
        message_id: str | None = None,
        directory: str | None = None,
    ) -> bool:
        """Revert one model message (V2's staged undo).

        Mirrors opencode's ``/undo``: stage the revert against the target
        message, then commit it. ``message_id`` is the target message to revert
        to; if omitted, the most recent assistant message found via
        ``GET /api/session/{id}/message`` is used. Returns ``True`` if the
        revert ran, ``False`` if there was no model message to revert.
        """

        target = message_id
        if not target:
            messages = await self.list_messages(session_id, directory=directory)
            latest_assistant = None
            for msg in reversed(messages):
                if not isinstance(msg, dict):
                    continue
                info = msg.get("info") if isinstance(msg.get("info"), dict) else msg
                role = info.get("role")
                mid = info.get("id") or info.get("messageID")
                if mid and role != "user":
                    latest_assistant = mid
                    break
            if not latest_assistant:
                return False
            target = latest_assistant
        await self._request(
            "POST",
            f"/api/session/{session_id}/revert/stage",
            json_body={"messageID": target},
            directory=directory,
        )
        # The commit route takes no body: it commits whatever was staged.
        await self._request(
            "POST",
            f"/api/session/{session_id}/revert/commit",
            directory=directory,
        )
        return True

    async def provider_overview(self) -> dict[str, Any]:
        """V1-shaped provider overview rebuilt from V2's model + provider lists.

        V2 splits the catalog: ``GET /api/provider`` lists provider ids and
        activation, ``GET /api/model`` lists every model with its capabilities,
        variants and limits. Callers expect ``{connected, all: [{id, models}]}``
        so the shape is rebuilt here.
        """

        try:
            providers_payload = await self._request("GET", "/api/provider")
        except OpenCodeClientError:
            providers_payload = None
        try:
            models_payload = await self._request("GET", "/api/model")
        except OpenCodeClientError:
            models_payload = None
        providers = _unwrap(providers_payload)
        models = _unwrap(models_payload)
        provider_entries = [item for item in providers if isinstance(item, dict)] if isinstance(providers, list) else []
        model_entries = [item for item in models if isinstance(item, dict)] if isinstance(models, list) else []
        by_provider: dict[str, dict[str, Any]] = {}
        for provider in provider_entries:
            provider_id = str(provider.get("id") or "")
            if not provider_id:
                continue
            by_provider[provider_id] = {"id": provider_id, "name": provider.get("name"), "models": {}}
        for model in model_entries:
            provider_id = str(model.get("providerID") or "")
            model_id = str(model.get("modelID") or model.get("id") or "")
            if not provider_id or not model_id:
                continue
            entry = by_provider.setdefault(provider_id, {"id": provider_id, "models": {}})
            variants = {}
            for variant in model.get("variants") or ():
                if not isinstance(variant, Mapping):
                    continue
                variant_id = str(variant.get("id") or "")
                if not variant_id:
                    continue
                settings = variant.get("settings")
                variants[variant_id] = dict(settings) if isinstance(settings, Mapping) else {}
            raw_capabilities = model.get("capabilities") if isinstance(model.get("capabilities"), Mapping) else {}
            # V2 reports capabilities as ``{tools: bool, input: [...], output: [...]}``;
            # the catalog filter looks for a 1.x-style ``toolcall`` flag plus
            # ``output.text`` / ``input.text`` booleans.
            capabilities: dict[str, Any] = {"toolcall": bool(raw_capabilities.get("tools"))}
            for side in ("input", "output"):
                values = raw_capabilities.get(side)
                names = [str(value) for value in values] if isinstance(values, list) else []
                capabilities[side] = {name: True for name in names}
            entry["models"][model_id] = {
                "name": model.get("name"),
                "limit": model.get("limit") or {},
                "variants": variants,
                "capabilities": capabilities,
            }
        # ``connected`` mirrors 1.x "configured providers": V2 reports
        # activation per provider, so a provider that is not disabled counts as
        # available. Providers that only exist because a model named them are
        # still listed (models are the reason the catalog is useful).
        activation_by_id = {str(item.get("id") or ""): item.get("activation") for item in provider_entries}
        connected = [
            provider_id
            for provider_id, provider in by_provider.items()
            if provider_id in activation_by_id or provider["models"]
        ]
        disabled = {
            provider_id
            for provider_id, activation in activation_by_id.items()
            if str(activation or "") == "disabled" and not by_provider.get(provider_id, {}).get("models")
        }
        connected = [provider_id for provider_id in connected if provider_id not in disabled]
        return {"connected": connected, "all": list(by_provider.values())}

    async def session_status_map(self, directory: str | None = None) -> dict[str, Any]:
        """Busy/idle map for every running session (``GET /api/session/active``).

        V2 answers ``{ses_x: {type: "running"}}`` for active sessions and an
        empty map when idle; the map is global (no directory scoping). The
        ``running`` marker is translated to the ``busy`` shape the runtime
        checks for.
        """

        data = _unwrap(await self._request("GET", "/api/session/active"))
        if not isinstance(data, dict):
            return {}
        status_map: dict[str, Any] = {}
        for session_id, entry in data.items():
            if isinstance(entry, Mapping):
                entry_type = str(entry.get("type") or "")
                status_map[str(session_id)] = {"type": "busy" if entry_type == "running" else entry_type}
        return status_map

    # ------------------------------------------------------------------ #
    # SSE
    # ------------------------------------------------------------------ #

    async def stream_events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield normalized events from the live ``GET /api/event`` stream.

        V2's stream is live-only (no replay), global across projects, and each
        frame is ``{id, created?, type, location?, data, durable?}`` with the
        session id inside ``data``. Frames are translated here so callers only
        ever see the ``{type, properties}`` events the runtime dispatches on.

        The underlying connection is long-lived; callers must iterate this
        generator inside a task and handle ``OpenCodeClientError`` to
        reconnect.
        """

        client = await self._client()
        async with client.stream(
            "GET",
            "/api/event",
            timeout=httpx.Timeout(self.stream_timeout, connect=10.0),
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                raise OpenCodeClientError(
                    f"opencode /api/event failed: {response.status_code}",
                    status_code=response.status_code,
                )
            async for line in response.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:"):].strip()
                if not payload:
                    continue
                try:
                    frame = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if not isinstance(frame, dict):
                    continue
                for event in _adapt_event(frame):
                    yield event