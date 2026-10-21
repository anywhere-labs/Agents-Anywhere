"""OpenCode runtime adapter.

Self-contained: talks directly to a local ``opencode serve`` instance over
REST + SSE. No plugin bridge required (unlike DSH).

Session model (opencode 2.x / V2 API, see ``sdk/client.py`` for the endpoint
map and the shape adaptation):
- The opencode native id (``ses_...``) is used as both the platform
  ``session_id`` and ``external_session_id`` (single-instance runtime).
- Turns are driven by ``POST /api/session/{id}/prompt`` (a durable inbox admit);
  the model/agent selection is applied to the session first, because V2 dropped
  per-prompt overrides.
- V2 publishes no terminal ``session.idle`` event, so turn completion is
  detected by polling ``GET /api/session/active`` (the watchdog tightens its
  cadence while a turn is in flight).
- Timeline: ``session.text.delta`` / ``session.reasoning.delta`` are streamed
  into the platform timeline live (throttled, one stable item id per streamed
  part); ``GET /api/session/{id}/message`` rebuilds the authoritative snapshot
  at turn end.
- Permission requests and questions are opencode's pending ``/permission`` and
  ``/form`` lists in V2, so they are polled rather than event-driven.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from connector.logging import logger
from connector.runtime_protocol import (
    CAPABILITY_CATALOG_EFFORT,
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_CATALOG_PERMISSION,
    CAPABILITY_RUNTIME_ATTACHMENT,
    CAPABILITY_SESSION_COMMANDS,
    CAPABILITY_SESSION_INTERACTION_APPROVAL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    CAPABILITY_SESSION_STEER,
    AgentRuntime,
    InputRequestForm,
    InputRequestOption,
    InputRequestQuestion,
    InputRequestValidationError,
    PreparedSessionTimelineSync,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    SessionMeta,
    SessionNotice,
    SessionSourceState,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode import provider_config, serve_process, timeline
from connector.runtimes.opencode.attachments import materialize_opencode_attachments
from connector.runtimes.opencode.pending_messages import (
    OpenCodePendingClientMessageRegistry,
)
from connector.runtimes.opencode.sdk.client import OpenCodeClient, OpenCodeClientError
from connector.server.protocol import protocol_selection_id

MODEL_SELECTION_KEY = "model"
PERMISSION_SELECTION_KEY = "permission"
# opencode permission mode presets exposed to the platform. opencode ships
# ``build`` (default; read-write, tools run per configured permission rules)
# and ``plan`` (read-only; ``edit`` tools are denied) as the two ``primary``
# agents users switch between; the other primary agents (``compaction``,
# ``summary``, ``title``) are opencode internals, not user-selectable modes.
#
# opencode has no separate "mode" field — the mode *is* the primary agent that
# runs the turn, so a selection is applied with ``POST /api/session/{id}/agent``
# right before the prompt. opencode persists the agent on the session record,
# which is also how the current mode is read back.
#
# Do NOT try to switch modes by PATCHing ``{"permissions": [...]}`` onto the
# session (that looks like the obvious API): on serve 1.18.34 the array is
# *appended* to the session's existing rules instead of replacing it, so
# switching Plan → Build leaves Plan's ``edit * deny`` behind (read-only Build)
# and grows the ruleset on every switch. The mode therefore applies from the
# next turn, like the model selection.
PERMISSION_PRESET_BUILD = "build"
PERMISSION_PRESET_PLAN = "plan"
_PERMISSION_PRESETS: tuple[str, ...] = (PERMISSION_PRESET_BUILD, PERMISSION_PRESET_PLAN)
_PERMISSION_PRESET_LABELS: dict[str, str] = {
    PERMISSION_PRESET_BUILD: "Build",
    PERMISSION_PRESET_PLAN: "Plan",
}
_PERMISSION_PRESET_DESCRIPTIONS: dict[str, str] = {
    PERMISSION_PRESET_BUILD: (
        "Default mode. Tools run based on configured permission rules (read-write)."
    ),
    PERMISSION_PRESET_PLAN: (
        "Plan mode. Edit tools are denied; only plan files may be written (read-only)."
    ),
}
# opencode's ``GET /command`` only returns user-defined skills; the built-in
# slash commands the web UI shows (``/model``, ``/compact``, ``/fork``,
# ``/share``, ``/undo``) are front-end only. The connector re-injects the
# subset that maps to a real opencode backend capability so the platform slash
# menu offers them alongside skills. Pure-GUI commands (``/new``, ``/open``,
# ``/terminal``, ``/mcp``, ``/export``) are intentionally NOT listed: they
# have no backend API and must be handled by the client itself.
#
# ``metadata.ui`` follows the platform command-UI contract: ``selector`` makes
# the client open its own picker (the same settings drawer as the model
# button) instead of calling execute — this is how ``/model`` behaves like the
# browser's command. ``execute`` commands run through the runtime.
_OPENCODE_BUILTIN_COMMANDS: tuple[dict[str, Any], ...] = (
    {
        "name": "model",
        "title": "切换模型",
        "description": "打开模型选择器,后续对话使用新模型",
        "accepts_args": False,
        "metadata": {"ui": {"kind": "selector", "target": "model"}},
    },
    {
        "name": "compact",
        "title": "压缩会话",
        "description": "压缩会话上下文以释放上下文窗口",
        "accepts_args": False,
        "metadata": {
            "ui": {
                "kind": "execute",
                "allowedStatuses": ["idle", "error"],
                "acceptsMultiline": False,
            }
        },
    },
    {
        "name": "fork",
        "title": "复制会话",
        "description": "从当前会话的最新消息创建分叉会话",
        "accepts_args": False,
        "metadata": {
            "ui": {
                "kind": "execute",
                "allowedStatuses": ["idle", "error"],
                "acceptsMultiline": False,
            }
        },
    },
    # opencode 2.x dropped session sharing (``POST /session/{id}/share`` is
    # gone — unknown routes answer with the web UI), so ``/share`` is no longer
    # offered: a menu entry that can only fail is worse than none.
    {
        "name": "undo",
        "title": "撤销最近消息",
        "description": "撤销最近一条模型回复",
        "accepts_args": False,
        "metadata": {
            "ui": {
                "kind": "execute",
                "allowedStatuses": ["idle", "error"],
                "acceptsMultiline": False,
            }
        },
    },
)
_OPENCODE_BUILTIN_COMMAND_NAMES = frozenset(
    command["name"] for command in _OPENCODE_BUILTIN_COMMANDS
)
# Commands opencode itself used to expose and 2.x dropped: not offered in the
# menu, but answered explicitly instead of falling through to the skills
# endpoint (which would report a confusing 400 from a route that never worked).
_REMOVED_BUILTIN_COMMAND_NAMES = frozenset({"share"})
_BUILTIN_UI = {command["name"]: command["metadata"] for command in _OPENCODE_BUILTIN_COMMANDS}
# opencode's session.summarize needs the model that writes the summary; when
# nothing was picked for the platform session, fall back to the model of the
# most recent assistant message.
_COMPACT_MODEL_FALLBACK_ERROR = (
    "当前会话还没有用过模型，无法确定压缩用模型；请先用 /model 选择模型或发送一条消息"
)
# Reconnect failures tolerated by the event loop before a recovery pass runs.
STREAM_FAILURE_RECOVERY_THRESHOLD = 3
SERVE_RESTART_INITIAL_BACKOFF_S = 1.0
SERVE_RESTART_MAX_BACKOFF_S = 30.0
# V2 emits no terminal ``session.idle`` event, so the active-session map is the
# only turn-end signal. While a turn is in flight the watchdog polls at this
# cadence (turn end lands within ~2.5s of opencode going idle); when nothing is
# running it falls back to the slow reconcile interval.
TURN_POLL_INTERVAL_S = 2.5
PORT_ADOPTION_WAIT_S = 15.0
# ...and the shorter grace used when the port is free: a serve that is still
# booting has not bound it yet, so this wait covers the peer-is-about-to-appear
# case without charging the full window on every restart.
PORT_ADOPTION_GRACE_S = 3.0
# How long a pushed session status suppresses an identical re-push. opencode
# emits the same status twice within milliseconds; the window only has to outlast
# that burst, so a genuinely later push still reaches the Server.
STATUS_PUSH_DEDUPE_WINDOW_S = 5.0

# Streaming: opencode pushes ``message.part.delta`` per token chunk, so the
# buffer is flushed at most this often per part. Fast enough to read as a
# typewriter, slow enough that a 300-token answer does not turn into 300
# timeline upserts.
STREAM_FLUSH_INTERVAL_S = 0.25
# Part types the live timeline maps; ``step-start``/``step-finish``/``patch``
# are internal markers (a step-finish finalizes the message's streamed text).
_STREAM_CONTENT_PART_TYPES = frozenset({"text", "reasoning", "tool"})
# A live-but-unhealthy child within this window is still booting; recovery
# waits instead of killing and respawning it. opencode cold starts (especially
# npx-launched on Windows) routinely exceed 60s, so a tight grace creates a
# kill-respawn loop that looks like "serve started several times".
SERVE_BOOT_GRACE_S = 180.0
# How many times start() retries the auto-start + health-check cycle before
# giving up. The supervisor does not retry a failed start, so a transient
# failure (serve still booting, npx mid-download) would otherwise permanently
# mark the runtime as error and disable the client send button.
START_MAX_ATTEMPTS = 3
START_RETRY_BACKOFF_S = 3.0


def _iso_ms(ms: float | None) -> str | None:
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat()


def _session_directory(session: Mapping[str, Any]) -> str | None:
    """The project directory of a session record.

    V2 nests it under ``location``; the flat ``directory`` key is still accepted
    because older opencode builds (and the session records written before the
    2.x upgrade) answer with it.
    """

    nested = (session.get("location") or {}).get("directory")
    return str(nested or session.get("directory") or "") or None


_QUESTION_CANCEL_ACTIONS = frozenset({"cancel", "dismiss", "reject"})
_LEGACY_CANCEL_REPLIES = frozenset({"cancel", "dismiss", "reject", "-"})


def _option_pair(option: Any) -> tuple[str, str] | None:
    """Return ``(answer value, display label)`` for one opencode option."""

    if isinstance(option, Mapping):
        label = option.get("label") or option.get("title") or option.get("value")
        value = option.get("value") or option.get("id") or label
    elif isinstance(option, str):
        value = label = option
    elif isinstance(option, (tuple, list)) and len(option) == 2:
        value, label = option
    else:
        return None
    if value is None or label is None:
        return None
    value_text = str(value)
    label_text = str(label).strip()
    if not value_text.strip() or not label_text:
        return None
    return value_text, label_text


def _normalise_questions(raw_questions: Any) -> list[dict[str, Any]]:
    """Normalise opencode question and form-field shapes to one internal shape.

    The SSE payload uses ``{question, options}`` while a V2 form uses
    ``{key, type, title, options}``. A question here keeps the answer key (the
    form field key when one exists), the prompt and option pairs, so the notice
    can be rendered as a real input-request form instead of a free-text reply.
    """

    questions: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(raw_questions or ()):
        if isinstance(raw, Mapping):
            raw_id = raw.get("id") if raw.get("id") is not None else raw.get("key")
            question_id = str(raw_id) if raw_id not in (None, "") else f"q_{index}"
            prompt = str(
                raw.get("question")
                or raw.get("prompt")
                or raw.get("text")
                or raw.get("title")
                or question_id
            ).strip()
            field_type = str(raw.get("fieldType") or raw.get("type") or "string")
            multiple = raw.get("multiple") is True or field_type == "multiselect"
            if multiple and field_type != "multiselect":
                # Legacy question events only said ``multiple``; keep the
                # answer array shape during the typed-answer conversion.
                field_type = "multiselect"
            raw_options = raw.get("options") or ()
            header = str(raw.get("header") or "").strip() or None
            if "allowCustom" in raw:
                allow_custom = raw.get("allowCustom") is True
            elif "custom" in raw:
                allow_custom = raw.get("custom") is True
            elif "fieldType" in raw:
                # A V2 form field without ``custom`` is a closed list.
                allow_custom = not raw_options and field_type != "boolean"
            else:
                # Legacy question events offered a free-text reply even when
                # they also carried options; keep that escape hatch.
                allow_custom = True
        else:
            question_id = f"q_{index}"
            prompt = str(raw).strip() or question_id
            field_type = "string"
            multiple = False
            raw_options = ()
            header = None
            allow_custom = True
        if field_type == "boolean" and not raw_options:
            raw_options = (
                {"value": "true", "label": "True"},
                {"value": "false", "label": "False"},
            )
            allow_custom = False
        options: list[tuple[str, str]] = []
        seen_options: set[str] = set()
        for option in raw_options:
            pair = _option_pair(option)
            if pair is None or pair[0] in seen_options:
                continue
            seen_options.add(pair[0])
            options.append(pair)
        base_id = question_id
        suffix = 2
        while question_id in used_ids:
            question_id = f"{base_id}_{suffix}"
            suffix += 1
        used_ids.add(question_id)
        questions.append(
            {
                "id": question_id,
                "question": prompt or question_id,
                "options": options,
                "multiple": multiple,
                "allowCustom": allow_custom,
                "fieldType": field_type,
                **({"header": header} if header else {}),
            }
        )
    return questions


def _option_labels(options: Any) -> list[str]:
    """Normalize option entries to labels for the fallback notice body."""

    labels: list[str] = []
    for option in options or ():
        pair = _option_pair(option)
        if pair is not None:
            labels.append(pair[1])
    return labels


def _form_to_question_props(form: Mapping[str, Any]) -> dict[str, Any]:
    """Project a V2 form into the question-notice props.

    opencode 2.x replaced 1.x's ``question`` events with forms: a titled set of
    typed fields (``{key, type, title?, options?}``). The form field keys are
    kept as question ids so a submitted answer maps straight back onto
    opencode's ``{answer: {fieldKey: value}}`` payload.
    """

    raw_questions: list[dict[str, Any]] = []
    for form_field in form.get("fields") or ():
        if not isinstance(form_field, Mapping) or form_field.get("hidden"):
            continue
        field_type = str(form_field.get("type") or "string")
        # External fields are a URL the user has to open elsewhere; rendering
        # them as a text answer would submit a value opencode never expects.
        if field_type == "external":
            continue
        field_key = str(form_field.get("key") or form_field.get("id") or "")
        if not field_key:
            continue
        raw_questions.append(
            {
                "id": field_key,
                "question": str(form_field.get("title") or field_key),
                "options": form_field.get("options") or (),
                "fieldType": field_type,
                "multiple": field_type == "multiselect",
                **(
                    {"custom": form_field.get("custom")}
                    if "custom" in form_field
                    else {}
                ),
            }
        )
    return {
        "id": str(form.get("id") or ""),
        "question": str(form.get("title") or ""),
        "questions": _normalise_questions(raw_questions),
    }


def _input_request_form(
    questions: list[dict[str, Any]],
) -> tuple[InputRequestForm | None, dict[str, str]]:
    """Build the platform input-request form and its field-type map."""

    if not questions:
        return None, {}
    input_questions: list[InputRequestQuestion] = []
    field_types: dict[str, str] = {}
    for question in questions:
        question_id = str(question.get("id") or "")
        options = tuple(
            InputRequestOption(option_id=value, label=label)
            for value, label in question.get("options") or ()
        )
        input_questions.append(
            InputRequestQuestion(
                question_id=question_id,
                prompt=str(question.get("question") or question_id),
                options=options,
                header=str(question.get("header") or "") or None,
                multiple=question.get("multiple") is True,
                allow_custom=question.get("allowCustom") is not False,
            )
        )
        field_types[question_id] = str(question.get("fieldType") or "string")
    try:
        return InputRequestForm(questions=tuple(input_questions)), field_types
    except InputRequestValidationError as exc:
        logger.warning("opencode question form rejected: {}", exc)
        return None, field_types


def _input_request_form_from_notice(notice: SessionNotice) -> InputRequestForm | None:
    """Rebuild the form from the notice action so replies survive a restart."""

    for action in notice.actions:
        if not isinstance(action, Mapping):
            continue
        input_spec = action.get("input")
        if not isinstance(input_spec, Mapping):
            continue
        ui_schema = input_spec.get("uiSchema")
        if not isinstance(ui_schema, Mapping):
            continue
        if ui_schema.get("component") != "inputRequest":
            continue
        raw_questions = ui_schema.get("questions")
        if not isinstance(raw_questions, list):
            continue
        form, _ = _input_request_form(_normalise_questions(raw_questions))
        if form is not None:
            return form
    return None


def _opencode_answer(
    parsed_answers: Mapping[str, Any],
    field_types: Mapping[str, str],
) -> dict[str, Any]:
    """Convert platform answer objects into opencode form values.

    Option ids are already opencode option values (``Form.Option.value``), so a
    single-select string answer needs no label lookup. Multiselect answers stay
    arrays, and boolean/number fields are coerced back to their typed values.
    """

    answer: dict[str, Any] = {}
    for question_id, parsed in parsed_answers.items():
        field_type = field_types.get(question_id, "string")
        option_values = list(parsed.option_ids)
        custom_text = parsed.custom_text
        if field_type == "multiselect":
            values = list(option_values)
            if custom_text:
                values.append(custom_text)
            answer[question_id] = values
            continue
        raw_value = (
            custom_text
            if custom_text is not None
            else (option_values[0] if option_values else "")
        )
        if field_type == "boolean":
            lowered = str(raw_value).strip().lower()
            if lowered in {"true", "1", "yes", "y", "是"}:
                answer[question_id] = True
            elif lowered in {"false", "0", "no", "n", "否"}:
                answer[question_id] = False
            else:
                raise InputRequestValidationError(
                    f"boolean answer expected for {question_id}"
                )
        elif field_type == "integer":
            answer[question_id] = int(str(raw_value))
        elif field_type == "number":
            answer[question_id] = float(str(raw_value))
        else:
            answer[question_id] = raw_value
    return answer


def _capability_flag(capabilities: Mapping[str, Any] | None, name: str) -> bool:
    """Return a capabilities flag as a real bool (opencode serves ``{}`` when unset)."""
    if not capabilities:
        return False
    return capabilities.get(name) is True


def _reasoning_items(
    model_key: str,
    variants: Mapping[str, Mapping[str, Any] | None] | None,
) -> tuple[RuntimeReasoningItem, ...]:
    """Build reasoning items from an opencode model's ``variants`` map.

    opencode expresses reasoning levels as ``variants`` on each model, e.g.
    ``{"low": {"reasoningEffort": "low"}, "high": {"reasoningEffort": "high"}}``.
    Each variant key becomes a selectable reasoning item; ``off`` maps to the
    ``none`` reasoning effort (matches the variant's ``reasoningEffort`` field).
    """
    if not variants:
        return ()
    result: list[RuntimeReasoningItem] = []
    for variant_key, variant in variants.items():
        if not isinstance(variant, Mapping):
            continue
        reasoning_id = variant.get("reasoningEffort")
        if not isinstance(reasoning_id, str) or not reasoning_id:
            # Fall back to the variant key (e.g. "off") rather than dropping the
            # entry — opencode lets users switch variants by key, so the
            # selection still needs to be representable.
            reasoning_id = variant_key
        result.append(
            RuntimeReasoningItem(
                id=reasoning_id,
                title=_reasoning_label(reasoning_id),
                selection_id=protocol_selection_id(
                    "opencode",
                    "model",
                    {"model_id": model_key, "reasoning_id": reasoning_id},
                ),
                metadata={"source": "opencode.provider/variants", "variant": variant_key},
            )
        )
    return tuple(result)


def _reasoning_label(reasoning_id: str) -> str:
    return {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "Extra high",
        "max": "Max",
        "none": "None",
        "off": "Off",
    }.get(reasoning_id, reasoning_id)


def _permission_preset_label(preset: str) -> str:
    """Human label for a preset; unknown presets fall back to their agent name."""

    return _PERMISSION_PRESET_LABELS.get(preset, preset)


def _permission_selection_id(preset: str) -> str:
    """Selection id the platform stores for one permission preset."""

    return protocol_selection_id("opencode", "permission", {"permission_id": preset})


@dataclass(slots=True)
class _StreamedPart:
    """One opencode part being streamed into the platform timeline."""

    part: dict[str, Any]
    message_id: str
    text: str = ""
    dirty: bool = False
    revision: int = 1
    flushed_at: float = 0.0
    order_seq: int = 0


@dataclass(slots=True)
class _StreamSession:
    """Streaming buffers for one native session."""

    parts: dict[str, _StreamedPart] = field(default_factory=dict)
    order: dict[str, int] = field(default_factory=dict)
    next_order_seq: int = 1
    parents: dict[str, str] = field(default_factory=dict)
    roles: dict[str, str] = field(default_factory=dict)
    # Last text published per part. A part whose buffer was dropped (turn end,
    # ``step-finish``) must not restart from empty when opencode sends another
    # delta for it, or the client sees the answer shrink to its last chunk.
    published: dict[str, str] = field(default_factory=dict)
    # The user's own message, accumulated from its part events so the live
    # timeline has the prompt too — without it the in-progress turn shows only
    # assistant output and the round looks unanchored until the turn-end
    # snapshot supplies the prompt.
    user_parts: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # The orderSeq reserved for that prompt (the slot before the streamed parts).
    user_order_seq: int | None = None
    # (content hash, orderSeq, status) of the last item actually pushed per part.
    # opencode restates parts -- several times while a tool runs, and once more
    # after ``session.idle`` -- and every upsert is an ingest on the Server, so an
    # unchanged restatement is dropped instead of republished (a running tool
    # otherwise burned ~9 ingests in 90ms with byte-identical content).
    fingerprints: dict[str, tuple[str, int, str]] = field(default_factory=dict)
    # Assistant messages already announced in this turn, so a step is logged once
    # instead of once per part it contains.
    steps: set[str] = field(default_factory=set)
    # When this turn became active, for the turn-end duration log.
    started_at: float = 0.0
    # The SSE loop and the watchdog can both finalize the same part; this keeps
    # them from publishing it twice with different statuses.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


# The per-session id maps above grow with the conversation and are kept for the
# whole session (a part that opencode emits after ``session.idle`` still needs
# its recorded order and turn id). A long session would otherwise accumulate
# them without bound, so drop the oldest entries once they pass this size — an
# old part is long since replaced by the turn-end snapshot, and if it ever
# streams again it simply gets a fresh slot.
_STREAM_STATE_MAX_ENTRIES = 4000
_STREAM_TRIMED_MAPS = ("order", "parents", "roles", "published", "fingerprints")


def _trim_stream_state(session: _StreamSession) -> None:
    for name in _STREAM_TRIMED_MAPS:
        mapping: dict[str, Any] = getattr(session, name)
        while len(mapping) > _STREAM_STATE_MAX_ENTRIES:
            mapping.pop(next(iter(mapping)))


def _elapsed_suffix(part: Mapping[str, Any]) -> str:
    """`` after 900.4s`` for a tool that has been running, else ``""``.

    A long tool is the usual reason a turn looks stuck from the outside, so the
    log line that reports a tool's state change also says how long it took. Uses
    opencode's own ``state.time`` (epoch ms) rather than our clock so it matches
    the timestamps the runtime reports.
    """

    state = part.get("state")
    times = state.get("time") if isinstance(state, Mapping) else None
    if not isinstance(times, Mapping):
        return ""
    start = times.get("start")
    if not isinstance(start, int):
        return ""
    end = times.get("end")
    stop = end if isinstance(end, int) else int(time.time() * 1000)
    return f" after {round(max(0.0, (stop - start) / 1000), 1)}s"


def _permission_preset_from_selection(selection_id: str | None) -> str | None:
    """Resolve a platform permission selection id back to an opencode preset.

    ``protocol_selection_id`` is a one-way hash, so the id is resolved by
    re-encoding every known preset and comparing (the codex and claude
    adapters decode their selection ids the same way). ``None`` means "no
    permission selection" (the picker shows the catalog default) or an id this
    runtime does not know, which callers must not silently treat as Build.
    """

    if not selection_id:
        return None
    for preset in _PERMISSION_PRESETS:
        if _permission_selection_id(preset) == selection_id:
            return preset
    return None


class OpenCodeRuntime(AgentRuntime):
    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        client_version: str = "1.0",
        client: OpenCodeClient | None = None,
        state_reconcile_interval_s: float = 20.0,
        auto_start_serve_timeout_s: float = 180.0,
    ) -> None:
        self.config = config
        self.host = host
        self.client_version = client_version
        values = dict(config.values)
        self._client = client or OpenCodeClient(
            values["serverUrl"],
            values.get("apiKey"),
            float(values.get("requestTimeoutSeconds", provider_config.DEFAULT_REQUEST_TIMEOUT_S)),
            stream_timeout=provider_config.DEFAULT_STREAM_TIMEOUT_S,
            api_user=str(values.get("apiUser") or "opencode"),
        )
        self._identity = RuntimeIdentity("opencode", "unknown", "OpenCode")
        self._pending_messages = OpenCodePendingClientMessageRegistry()
        # Native session id -> workspace directory. serve binds requests to the
        # instance for that directory; without it sessions land in the serve
        # process cwd regardless of the workspace the user selected.
        self._session_dirs: dict[str, str] = {}
        # Turn-ends the host refused (backend blip); retried on every
        # watchdog tick, snapshot sync and idle event.
        self._unended_turns: dict[str, str] = {}
        # Native sessions whose idle state was asserted to the host since their
        # last running update (see get_session_state self-heal).
        self._pushed_idle: set[str] = set()
        # (status, monotonic) per native session, for the duplicate-burst window
        # in ``_status_push_is_recent``.
        self._status_pushes: dict[str, tuple[str, float]] = {}
        self._stopping = False
        self._started = False
        self._state_reconcile_interval_s = state_reconcile_interval_s
        self._auto_start_serve_timeout_s = auto_start_serve_timeout_s
        # Native session ids with a turn in flight on the platform side.
        # If the ``session.idle`` event is lost (SSE drop mid-turn), the
        # watchdog reconciles against /session/status and emits the missing
        # turn-end so the platform session cannot stay "running" forever.
        self._active_turns: set[str] = set()
        # Native ids whose abort was requested; the turn-end is reported as
        # interrupted when serve finally confirms the session left busy.
        self._aborted_turns: set[str] = set()
        # Last outcome reported per native id, so a late duplicate idle event
        # cannot re-report a turn the reconciler already ended.
        self._recently_ended: dict[str, str] = {}
        # Supervised child ``opencode serve`` process, when auto-start owns one.
        self._serve: serve_process.ServeProcess | None = None
        self._serve_env: dict[str, str] | None = None
        self._recovery_lock = asyncio.Lock()
        self._recovery_task: asyncio.Task[None] | None = None
        # Cached ``opencode serve`` argv so the (slow, up to 15s) --version
        # probe runs at most once per runtime instead of on every spawn.
        self._cached_serve_command: list[str] | None = None
        self._stream_failures = 0
        self._health_degraded = False
        # --- diagnostics (temporary; no behavioral effect) ---
        # How many ``opencode serve`` children this runtime has spawned; a value
        # above 1 across a single start reveals repeated/spurious spawns.
        self._serve_spawn_count = 0
        # Monotonic counter of idle notifications per native session. Used to
        # detect the turn-start race: an idle arriving while prompt_async is
        # still in flight (before the turn is marked active).
        self._idle_seq: dict[str, int] = {}
        # Whether the SSE stream has delivered its first event since the last
        # disconnect; distinguishes "never connected" from "idle lost".
        self._event_stream_connected = False
        self._event_task: asyncio.Task[None] | None = None
        self._watchdog_task: asyncio.Task[None] | None = None
        self._models: dict[str, dict[str, Any]] | None = None
        self._model_lock = asyncio.Lock()
        # Bidirectional platform <-> native session id mapping. Discovered
        # sessions are identity-mapped; created sessions carry a connector-
        # assigned platform id separate from the native ``ses_...`` id.
        self._platform_to_native: dict[str, str] = {}
        self._native_to_platform: dict[str, str] = {}
        # Pending interaction notices (permission requests, questions) keyed by
        # platform session id -> notice_id -> SessionNotice. Cleared when the
        # corresponding ``permission.replied`` / question reply arrives.
        self._notices: dict[str, dict[str, SessionNotice]] = {}
        # Per-platform model selection applied to the next prompt. opencode
        # only accepts a model reference at prompt time, so a selection change
        # mid-session is stored here and injected on the next turn.
        self._selections: dict[str, dict[str, str | None]] = {}
        # opencode ``primary`` agents, keyed by name, populated lazily from
        # ``GET /agent``. Keyed by project directory (agents resolve per project
        # config and opencode answers relative to the requested directory);
        # ``None`` is the serve cwd. Only ``build`` and ``plan`` are offered as
        # permission presets — the remaining primary agents (compaction,
        # summary, title) are opencode internals.
        self._primary_agents: dict[str | None, dict[str, dict[str, Any]]] = {}
        # Live timeline streaming, keyed by native session: the in-flight parts
        # plus the message parent ids needed to resolve turn_id. Without this the
        # client only sees the turn's output when it ends.
        self._stream_sessions: dict[str, _StreamSession] = {}

    def _native_id(self, session_id: str, external_session_id: str | None) -> str:
        if external_session_id:
            return external_session_id
        return self._platform_to_native.get(session_id, session_id)

    def _platform_id(self, native_id: str) -> str:
        return self._native_to_platform.get(native_id, native_id)

    def _bind_session(self, platform_id: str, native_id: str) -> None:
        self._platform_to_native[platform_id] = native_id
        self._native_to_platform[native_id] = platform_id

    def _adopt_session_binding(self, session_id: str, external_session_id: str | None) -> str:
        """Rebuild the platform<->native pairing when the Server supplies both ids.

        The maps are in-memory: after a connector restart they are empty, and a
        Server-driven call (send message, state read) is the only place the
        pairing reappears. Without rebuilding here, every push for a
        pre-restart session is addressed with the *native* id; the Server can
        then only resolve it through the session row's externalSessionId —
        which sessions created before the contract fix carry as NULL — so the
        update is dropped and the platform session stays stuck in "running"
        with the send button permanently disabled.
        """

        native_id = self._native_id(session_id, external_session_id)
        if external_session_id:
            self._bind_session(session_id, native_id)
        return native_id

    def _remember_directory(self, native_id: str, directory: str | None) -> None:
        if directory:
            self._session_dirs[native_id] = directory

    def _directory_for(self, native_id: str) -> str | None:
        return self._session_dirs.get(native_id)

    # ------------------------------------------------------------------ #
    # identity / lifecycle
    # ------------------------------------------------------------------ #

    @property
    def sync_mode(self) -> str:
        return "events"

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    @staticmethod
    def _auth_hint_message(exc: BaseException) -> str | None:
        """Descriptive guidance when serve answers 401 (Basic auth mismatch)."""

        if getattr(exc, "status_code", None) != 401:
            return None
        return (
            "opencode serve 已运行但认证失败(401)：serve 使用 HTTP Basic 认证。"
            "请在运行时配置中填写 apiKey(密码)和 apiUser(用户名, 默认 opencode)；"
            "连接器自动拉起的 serve 会继承环境变量 "
            "OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME，"
            "两者都没有时连接器会自行生成密码注入 serve。"
        )

    async def start(self) -> None:
        self._stopping = False
        server_url = str(self.config.values.get("serverUrl") or "")
        logger.info("opencode start: connecting to {}", server_url)
        last_error: Exception | None = None
        for attempt in range(1, START_MAX_ATTEMPTS + 1):
            try:
                health = await self._try_start_once(server_url)
                break
            except RuntimeUnavailableError:
                # Surface auth/configuration failures immediately; retrying
                # them only delays the inevitable error message.
                raise
            except Exception as exc:  # noqa: BLE001 - transient startup failures
                last_error = exc
                if attempt >= START_MAX_ATTEMPTS:
                    break
                logger.warning(
                    "opencode start attempt {}/{} failed ({}); retrying in {}s",
                    attempt,
                    START_MAX_ATTEMPTS,
                    exc,
                    START_RETRY_BACKOFF_S,
                )
                await asyncio.sleep(START_RETRY_BACKOFF_S)
        else:
            # Unreachable: the for loop always breaks or raises.
            health = None  # pragma: no cover
        if last_error is not None:
            hint = self._auth_hint_message(last_error)
            detail = hint or str(last_error)
            logger.warning("opencode start failed after {} attempts: {}", START_MAX_ATTEMPTS, detail)
            with suppress(Exception):
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "opencode_auth_failed" if hint else "opencode_unreachable",
                        "message": f"无法连接 opencode serve: {detail}",
                        "retryable": True,
                    },
                )
            raise RuntimeUnavailableError(detail) from last_error
        version = str((health or {}).get("version") or "unknown")
        self._identity = RuntimeIdentity(
            "opencode", version, "OpenCode", protocol_version=self.client_version
        )
        logger.info("opencode start ok: serve version={}", version)
        if self._event_task is None or self._event_task.done():
            self._event_task = asyncio.create_task(self._event_loop(), name="opencode-events")
        if self._watchdog_task is None or self._watchdog_task.done():
            self._watchdog_task = asyncio.create_task(
                self._state_watchdog(), name="opencode-state-watchdog"
            )
        self._started = True

    async def _try_start_once(self, server_url: str) -> dict[str, Any] | None:
        """One attempt to reach (or auto-start) serve and return its health."""

        try:
            return await self._client.health()
        except OpenCodeClientError as exc:
            logger.warning("opencode start: server unreachable ({})", exc)
            if not self._should_auto_start(server_url):
                hint = self._auth_hint_message(exc)
                with suppress(Exception):
                    await self.host.runtime_health_update(
                        "starting",
                        {
                            "code": "opencode_auth_failed" if hint else "opencode_unreachable",
                            "message": hint or f"无法连接 opencode serve: {exc}",
                            "retryable": True,
                        },
                    )
                raise RuntimeUnavailableError(hint or str(exc)) from exc
            try:
                await self._auto_start_serve(server_url)
                return await self._client.health()
            except Exception as start_exc:
                hint = self._auth_hint_message(start_exc) or self._auth_hint_message(exc)
                detail = hint or str(start_exc)
                logger.warning("opencode start: auto-start did not recover ({})", detail)
                if hint:
                    # Auth failures are not transient: surface them so the outer
                    # loop does not waste attempts.
                    raise RuntimeUnavailableError(detail) from start_exc
                raise

    async def stop(self) -> None:
        self._stopping = True
        self._started = False
        tasks = [t for t in (self._event_task, self._watchdog_task, self._recovery_task) if t is not None]
        self._event_task = None
        self._watchdog_task = None
        self._recovery_task = None
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(BaseException):
                await task
        await self._stop_serve_process()
        await self._client.close()
        logger.info("opencode stop: tasks cancelled, client closed")
    async def _stop_serve_process(self) -> None:
        """Terminate the auto-started ``opencode serve`` child, if any.

        Leaving it running was tried and reverted: releasing the child means
        closing its pipe transports (the only way to stop reading them), and on
        Windows that kills the process instead of detaching it. Keeping the pipes
        open while the connector exits would instead break the child's stderr,
        which ``--print-logs`` depends on. Writing the child's output to a file
        instead of pipes would make detaching safe, but that is a larger change
        than the ~2s of spawn it would save on a restart that is already dominated
        by the desktop app rebuilding the connector.
        """

        serve = self._serve
        self._serve = None
        if serve is not None:
            await serve.stop()

    def _should_auto_start(self, server_url: str) -> bool:
        """Auto-start is allowed only for loopback URLs when not disabled."""
        if not bool(self.config.values.get("autoStart", True)):
            return False
        try:
            parsed = urlparse(server_url)
        except (ValueError, TypeError):
            return False
        return parsed.hostname in ("127.0.0.1", "localhost", "::1")

    @staticmethod
    def _serve_command(port: int) -> list[str]:
        return serve_process.resolve_serve_command(port)

    def _serve_target(self, server_url: str) -> tuple[str, int]:
        parsed = urlparse(server_url)
        return parsed.hostname or "127.0.0.1", parsed.port or 4096

    @staticmethod
    async def _port_listening(host: str, port: int) -> bool:
        """True when something accepts TCP on host:port (a foreign serve)."""
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=1.0)
        except OSError:  # includes TimeoutError, the builtin subclasses OSError
            return False
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()
        return True

    async def _auto_start_serve(self, server_url: str) -> None:
        """Spawn a local ``opencode serve`` child and wait for it to become healthy."""

        async with self._recovery_lock:
            await self._auto_start_serve_locked(server_url)

    async def _adoption_wait(self, timeout_s: float | None = None) -> tuple[bool, OpenCodeClientError | None]:
        """Poll health for ``timeout_s``; (adopted?, last error)."""

        wait_s = PORT_ADOPTION_WAIT_S if timeout_s is None else timeout_s
        deadline = asyncio.get_running_loop().time() + wait_s
        last_exc: OpenCodeClientError | None = None
        while asyncio.get_running_loop().time() < deadline:
            try:
                await self._client.health()
            except OpenCodeClientError as poll_exc:
                last_exc = poll_exc
                await asyncio.sleep(1.0)
                continue
            return True, None
        return False, last_exc

    async def _auto_start_serve_locked(self, server_url: str) -> None:
        host, port = self._serve_target(server_url)
        if self._serve_env is None:
            self._serve_env = await asyncio.to_thread(serve_process.serve_environment)
        # A spawned serve always protects itself with HTTP Basic. It reads the
        # password from OPENCODE_SERVER_PASSWORD (and the username from
        # OPENCODE_SERVER_USERNAME) out of the environment it inherits; with no
        # password set, opencode 2.x invents one the connector can never learn,
        # so every request — including the health probe — answers 401 and the
        # runtime never comes up. Inherit the user's password when there is one
        # and generate one otherwise, so the child and the client always agree.
        if not self._client.api_key:
            env_user, env_password = serve_process.environment_server_credentials(
                self._serve_env
            )
            if env_password:
                self._client.set_credentials(env_user, env_password)
                logger.info("opencode auto-start: inherited serve Basic auth user={}", env_user)
            else:
                env_user, generated = serve_process.generated_server_credentials(
                    self._serve_env
                )
                self._client.set_credentials(env_user, generated)
                logger.info(
                    "opencode auto-start: generated serve Basic auth user={} "
                    "(no OPENCODE_SERVER_PASSWORD in the environment)",
                    env_user,
                )
            # Discovery probes this URL without a runtime instance; without the
            # password it would 401 and report a healthy serve as unavailable.
            serve_process.register_serve_credentials(server_url, env_user, env_password or generated)
        # A concurrent recovery pass may already have brought serve up. A 401
        # here means a serve is already listening with credentials we do not
        # have; spawning another instance would only die on the shared log
        # file lock, so surface the auth hint instead.
        #
        # The three questions are independent -- is a serve answering, does
        # another opencode hold the log, is anything on our port -- so they are
        # asked at once. Chained, a connector restart spent ~4s failing the
        # health connect and then ~3s in the log-lock probe before it was even
        # allowed to spawn, all of it as ``status='starting'`` to the client.
        health_task = asyncio.create_task(self._client.health(fast=True))
        lock_task = asyncio.create_task(
            asyncio.to_thread(serve_process.is_serve_log_lock_held, self._serve_env)
        )
        try:
            await health_task
            # Something answered: adopt it and skip the probes below.
            lock_task.cancel()
            return
        except OpenCodeClientError as exc:
            hint = self._auth_hint_message(exc)
            if hint is not None:
                lock_task.cancel()
                raise RuntimeError(hint) from exc
        lock_held = await lock_task
        # Another opencode process (TUI, CLI, a foreign serve, CherryStudio, or a
        # dying orphan serve from a previous connector) holds opencode's log
        # file open — which on 2.x kills a serve that starts on the same data
        # directory. The holder may still be a serve worth adopting, so wait for
        # one, with the window chosen by what the port says: a serve that
        # already answered the precheck with a connection error may be booting,
        # and it binds the port only when ready, so "nothing listening" cannot
        # rule that out — but on a machine where some opencode always holds the
        # log (a TUI, CherryStudio) that same silence is the normal case, and
        # waiting the full window made the runtime unavailable for 1.5-2.5
        # minutes on every restart.
        if lock_held:
            listening = await self._port_listening(host, port)
            logger.warning(
                "opencode auto-start: opencode.log held by another opencode process "
                "and port {} is {}; probing for a serve to adopt",
                port,
                "taken" if listening else "free",
            )
            adopted, last_exc = await self._adoption_wait(
                None if listening else PORT_ADOPTION_GRACE_S
            )
            if adopted:
                logger.info("opencode auto-start: adopted external serve on port {}", port)
                return
            # A live serve we cannot authenticate to is the one case spawning
            # cannot work around.
            hint = self._auth_hint_message(last_exc)
            if hint is not None:
                raise RuntimeError(hint) from last_exc
            logger.info(
                "opencode auto-start: no serve answered; spawning on an isolated data dir"
            )
        # Whatever the probe said, a serve this connector starts gets its own
        # data directory: opencode 2.x takes ``<data>/log/opencode.log`` and the
        # session database exclusively, so sharing them with the user's
        # interactive opencode (or another serve) means dying at boot. The
        # directory is stable per port, so the sessions this runtime owns are
        # the same set across restarts — a per-spawn directory would make
        # session sync delete everything it synced last time.
        await asyncio.to_thread(
            serve_process.isolate_data_home, self._serve_env, tag=str(port)
        )
        if self._cached_serve_command is None:
            self._cached_serve_command = await asyncio.to_thread(
                serve_process.resolve_serve_command,
                port,
                self._serve_env,
                hostname="127.0.0.1" if host in ("localhost", "::1") else host,
            )
        command = self._cached_serve_command
        self._serve_spawn_count += 1
        logger.info(
            "opencode auto-start: launching (#{}): {}",
            self._serve_spawn_count,
            " ".join(command),
        )
        serve = serve_process.ServeProcess(on_exit=self._on_serve_exit)
        self._serve = serve
        await serve.spawn(command, self._serve_env)
        boot_started = asyncio.get_running_loop().time()
        try:
            await serve.wait_healthy(
                self._client.health, OpenCodeClientError, self._auto_start_serve_timeout_s
            )
        except RuntimeError as exc:
            # Another opencode process holding opencode.log kills the spawn, and
            # on 1.18.34 ``--print-logs`` does not reliably prevent it. Retrying
            # cannot help (the holder is not leaving on its own) and the child
            # says only "Unexpected error", so name the real cause instead --
            # RuntimeUnavailableError is surfaced by ``start`` without a retry.
            if serve_process.is_serve_log_lock_failure(str(exc)):
                log_path = serve_process.opencode_log_path(self._serve_env)
                logger.warning(
                    "opencode auto-start: spawn died on the opencode.log lock: {}",
                    log_path,
                )
                await serve.stop()
                if self._serve is serve:
                    self._serve = None
                raise RuntimeUnavailableError(
                    f"{serve_process.LOCK_HOLD_HINT}（日志文件：{log_path}）"
                ) from exc
            # A serve started elsewhere may be booting on the same port (or
            # our spawn died because the port was taken by a transient holder);
            # if something answers, adoption beats treating the failed spawn as
            # fatal.
            port_busy = serve_process.is_port_in_use(str(exc)) or await self._port_listening(
                host, port
            )
            lock_busy = await asyncio.to_thread(
                serve_process.is_serve_log_lock_held, self._serve_env
            )
            if not port_busy and not lock_busy:
                await serve.stop()
                if self._serve is serve:
                    self._serve = None
                raise
            logger.warning(
                "opencode auto-start: startup collision ({}); waiting for other serve", exc
            )
            adopted, last_poll_exc = await self._adoption_wait()
            await serve.stop()
            if self._serve is serve:
                self._serve = None
            if adopted:
                logger.info("opencode auto-start: adopted external serve on port {}", port)
                return
            hint = self._auth_hint_message(last_poll_exc) if last_poll_exc else None
            if hint is not None:
                raise RuntimeError(hint) from exc
            if lock_busy:
                raise RuntimeError(f"{exc} [{serve_process.LOCK_HOLD_HINT}]") from exc
            # Non-lock collision (port in use by a foreign process we cannot
            # adopt): surface the failure; the recovery loop retries with
            # backoff rather than stacking spawns here.
            raise
        logger.info(
            "opencode auto-start: serve ready on {}:{} after {:.1f}s (spawn #{})",
            host,
            port,
            asyncio.get_running_loop().time() - boot_started,
            self._serve_spawn_count,
        )
        return

    async def _on_serve_exit(self, code: int | None, tail: str) -> None:
        """ServeProcess monitor callback: the child died while we were running."""

        if self._stopping:
            return
        dead = self._serve
        if dead is not None and dead.process is not None and dead.process.returncode is not None:
            self._serve = None
        if not self._started:
            # Still inside start(): wait_healthy surfaces the failure to the
            # caller, who decides whether to retry. No background loop yet.
            return
        logger.warning(
            "opencode serve exited unexpectedly (code={}); scheduling recovery", code
        )
        with suppress(Exception):
            await self.host.runtime_health_update(
                "error",
                {
                    "code": "opencode_serve_exited",
                    "message": f"opencode serve 意外退出 (code={code})，正在自动重启。",
                    "retryable": True,
                },
            )
        self._schedule_recovery("serve-exited")

    def _schedule_recovery(self, reason: str) -> None:
        if self._stopping:
            return
        if self._recovery_task is not None and not self._recovery_task.done():
            return
        self._recovery_task = asyncio.create_task(
            self._recover(reason), name="opencode-serve-recovery"
        )

    async def _recover(self, reason: str) -> None:
        """Keep probing/restoring serve reachability until it is healthy."""

        server_url = str(self.config.values.get("serverUrl") or "")
        attempt = 0
        while not self._stopping:
            async with self._recovery_lock:
                try:
                    await self._client.health()
                except OpenCodeClientError as exc:
                    logger.debug("opencode recovery ({}) probe failed: {}", reason, exc)
                else:
                    logger.info("opencode recovery ({}) complete: serve reachable", reason)
                    self._health_degraded = False
                    self._stream_failures = 0
                    with suppress(Exception):
                        await self.host.runtime_health_update("running", None)
                    with suppress(Exception):
                        await self._reconcile_active_turns()
                    return
                serve = self._serve
                if (
                    serve is not None
                    and serve.process is not None
                    and serve.process.returncode is None
                    and not serve.boot_grace_expired(SERVE_BOOT_GRACE_S)
                ):
                    # The child is still booting; re-probe next cycle instead
                    # of killing it or stacking duplicate spawns.
                    logger.info(
                        "opencode recovery ({}) decision=wait (child pid={} still within {}s boot grace)",
                        reason,
                        serve.process.pid,
                        int(SERVE_BOOT_GRACE_S),
                    )
                elif self._should_auto_start(server_url):
                    if serve is not None and serve.process is not None:
                        # Wedged long enough: replace it rather than wait.
                        logger.info(
                            "opencode recovery ({}) decision=kill-and-respawn (pid={} exceeded {}s boot grace)",
                            reason,
                            serve.process.pid,
                            int(SERVE_BOOT_GRACE_S),
                        )
                        await serve.stop()
                        self._serve = None
                    else:
                        logger.info(
                            "opencode recovery ({}) decision=auto-start (no live child)",
                            reason,
                        )
                    try:
                        await self._auto_start_serve_locked(server_url)
                    except Exception as exc:  # noqa: BLE001 - keep retrying with backoff
                        logger.warning("opencode recovery ({}) spawn failed: {}", reason, exc)
                else:
                    logger.info(
                        "opencode recovery ({}) decision=give-up (auto-start disabled or non-loopback)",
                        reason,
                    )
            if self._stopping:
                return
            attempt += 1
            delay = SERVE_RESTART_INITIAL_BACKOFF_S * 2**min(attempt, 5)
            await asyncio.sleep(min(delay, SERVE_RESTART_MAX_BACKOFF_S))

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def resynchronize(self, session_id: str | None = None, external_session_id: str | None = None) -> None:
        """Rebuild the timeline from the server for one session (or all known)."""

        if session_id:
            await self._publish_timeline(session_id, external_session_id)
        # Full resync is driven by the connector's background scanner via
        # get_session_snapshot(); nothing to calibrate on the transport itself.

    # ------------------------------------------------------------------ #
    # capabilities / catalogs
    # ------------------------------------------------------------------ #

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return RuntimeCapabilitySet(
            runtime="opencode",
            revision=5,
            capabilities=(
                RuntimeCapability(
                    capability_id=CAPABILITY_CATALOG_MODEL,
                    scope="runtime",
                    runtime="opencode",
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_CATALOG_EFFORT,
                    scope="runtime",
                    runtime="opencode",
                ),
                RuntimeCapability(
                    # Build/Plan presets, read from ``GET /agent``.
                    capability_id=CAPABILITY_CATALOG_PERMISSION,
                    scope="runtime",
                    runtime="opencode",
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_RUNTIME_ATTACHMENT,
                    scope="runtime",
                    runtime="opencode",
                ),
            ),
            metadata={"source": "opencode.static"},
        )

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        """Session-scoped facts; send/interrupt must carry the platform session id.

        The Server's capability projection matches session-scoped entries by
        ``(runtime, scope="session", sessionId, runtimeId)``. A session-scoped
        entry without ``session_id`` — or one declared only on the
        runtime-scoped set — matches no projection group, so
        ``session.send_message`` resolves to "unsupported" and the client's
        send button stays disabled forever after the first turn.
        """

        return RuntimeCapabilitySet(
            runtime="opencode",
            revision=5,
            session_id=session_id,
            capabilities=(
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_INTERRUPT,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_STEER,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_INTERACTION_APPROVAL,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_COMMANDS,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                # Catalog/attachment facts are declared runtime-scoped, but the
                # Server only projects a session's effective capabilities from
                # entries that also appear in this session-scoped set. Without
                # these mirrors, ``catalog.model`` / ``catalog.effort`` resolve
                # to unsupported and the client disables the model and
                # reasoning selectors even though the catalogs carry data.
                RuntimeCapability(
                    capability_id=CAPABILITY_CATALOG_MODEL,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_CATALOG_EFFORT,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    # Build/Plan mirror. Per-call approvals still flow through
                    # ``session.interaction.approval``; this only drives the
                    # mode selector.
                    capability_id=CAPABILITY_CATALOG_PERMISSION,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_RUNTIME_ATTACHMENT,
                    scope="session",
                    runtime="opencode",
                    session_id=session_id,
                ),
            ),
            metadata={"source": "opencode.static"},
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        models = await self._connected_models()
        items: list[RuntimeModelItem] = []
        for key, model in models.items():
            provider_id, _, model_id = key.partition("/")
            # Skip non-chat models (embeddings, image generators, guards, …).
            # opencode serve reports capabilities per model; chat-capable
            # models expose ``toolcall`` and text output.
            capabilities = model.get("capabilities") or {}
            if not (
                _capability_flag(capabilities, "toolcall")
                and _capability_flag(
                    (capabilities.get("output") or {}), "text"
                )
            ):
                continue
            title = str(model.get("name") or model_id)
            if query and query.lower() not in key.lower():
                continue
            context = (model.get("limit") or {}).get("context")
            reasoning_items = _reasoning_items(key, model.get("variants") or {})
            items.append(
                RuntimeModelItem(
                    id=key,
                    title=f"{title} ({provider_id})",
                    selection_id=None
                    if reasoning_items
                    else protocol_selection_id(
                        "opencode",
                        "model",
                        {"model_id": key, "reasoning_id": None},
                    ),
                    description=f"context {context}" if context else None,
                    reasoning_items=reasoning_items,
                    metadata={"providerID": provider_id, "modelID": model_id},
                )
            )
            if len(items) >= limit:
                break
        return RuntimeModelCatalog(
            runtime="opencode", revision=1, models=tuple(items)
        )

    async def _connected_models(self) -> dict[str, dict[str, Any]]:
        async with self._model_lock:
            if self._models is None:
                try:
                    data = await self._client.provider_overview()
                except OpenCodeClientError:
                    data = {}
                connected = data.get("connected") if isinstance(data, dict) else []
                all_providers = data.get("all") if isinstance(data, dict) else []
                by_id = {p.get("id"): p for p in all_providers if isinstance(p, dict)}
                models: dict[str, dict[str, Any]] = {}
                for provider_id in connected or []:
                    provider = by_id.get(provider_id)
                    if not provider:
                        continue
                    for model_id, model in (provider.get("models") or {}).items():
                        if isinstance(model, dict):
                            models[f"{provider_id}/{model_id}"] = model
                self._models = models
            return self._models

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        """Expose opencode's Build and Plan permission mode presets.

        opencode ships two ``primary`` agents users switch between:
        ``build`` (default; read-write — tools run per configured
        permission rules) and ``plan`` (read-only — ``edit`` tools are
        denied, only plan files may be written). The remaining primary
        agents (``compaction``, ``summary``, ``title``) are opencode
        internals, so they are not offered as modes.

        Which agents exist is resolved from ``GET /agent`` (cached per project
        directory), so a preset is only offered when this opencode install
        really has it. The selection itself is applied as the agent of the
        next prompt — see ``_permission_mode_for_turn``.
        """

        agents = await self._load_primary_agents()
        items: list[RuntimePermissionItem] = []
        for name in _PERMISSION_PRESETS:
            if name not in agents:
                continue
            items.append(
                RuntimePermissionItem(
                    id=name,
                    title=_permission_preset_label(name),
                    selection_id=_permission_selection_id(name),
                    description=_PERMISSION_PRESET_DESCRIPTIONS[name],
                    default=name == PERMISSION_PRESET_BUILD,
                    metadata={
                        "source": "opencode.agent",
                        "agent": name,
                        # Native mapping, mirroring the codex/claude adapters:
                        # Build/Plan *is* the opencode primary agent that runs
                        # the turn.
                        "runtimeSettings": {"agent": name},
                        "selectionEffect": "next_turn",
                    },
                )
            )
        if query:
            lowered = query.casefold()
            items = [
                entry for entry in items
                if lowered in entry.id.casefold() or lowered in entry.title.casefold()
            ]
        return RuntimePermissionCatalog(
            runtime="opencode", revision=5, permissions=tuple(items[:limit])
        )

    async def _load_primary_agents(
        self, directory: str | None = None
    ) -> dict[str, dict[str, Any]]:
        """Fetch and cache the ``primary`` agents of one project directory.

        Keyed by agent **id** (``build`` / ``plan``), which is what the prompt
        and the permission presets address; V2's ``name`` is the display label
        (``Build`` / ``Plan``) and must not be mistaken for the key.
        """

        cached = self._primary_agents.get(directory)
        if cached is not None:
            return cached
        try:
            agents = await self._client.list_agents(directory=directory)
        except OpenCodeClientError as exc:
            logger.warning(
                "opencode list_agents failed: directory={} error={}", directory, exc
            )
            self._primary_agents[directory] = {}
            return self._primary_agents[directory]
        result: dict[str, dict[str, Any]] = {}
        for agent in agents:
            if not isinstance(agent, Mapping):
                continue
            name = agent.get("id") or agent.get("name")
            if not isinstance(name, str) or not name:
                continue
            if agent.get("mode") != "primary":
                continue
            result[name] = dict(agent)
        self._primary_agents[directory] = result
        return result

    async def _permission_mode_for_turn(
        self,
        native_id: str,
        selections: Mapping[str, str | None] | None,
    ) -> str | None:
        """Resolve the opencode agent the next turn must run as.

        opencode has no per-prompt agent field in V2, so ``prompt_async`` applies
        the returned name to the session (``POST /api/session/{id}/agent``) before
        admitting the prompt. ``None`` means "leave opencode's own default
        alone": a session the platform never put a mode on keeps the mode the
        user picked in the opencode TUI.

        The preset must exist in this project, because serve accepts an unknown
        agent name silently and then runs no turn at all. A mode the platform
        selected wins over opencode's own ``plan_exit`` tool, which asks to
        leave Plan mode mid-turn: the platform keeps sending the selected agent
        until the user changes the picker.
        """

        raw = (selections or {}).get(PERMISSION_SELECTION_KEY)
        preset = _permission_preset_from_selection(raw)
        if raw and preset is None:
            logger.warning(
                "opencode unknown permission selection: session={} selection={}",
                self._platform_id(native_id),
                raw,
            )
            return None
        if preset is None:
            return None
        agents = await self._load_primary_agents(self._directory_for(native_id))
        if not agents:
            # No directory-scoped answer (serve cwd, or an unreachable
            # ``GET /agent``): fall back to the project the runtime booted in.
            agents = await self._load_primary_agents(None)
        if preset not in agents:
            logger.warning(
                "opencode permission preset not installed: session={} preset={}",
                self._platform_id(native_id),
                preset,
            )
            return None
        return preset

    def _permission_mode_from_session(self, session: Mapping[str, Any]) -> str | None:
        """Map the agent opencode recorded on a session back to a preset.

        ``session["agent"]`` is what the opencode web UI and TUI show as the
        current mode, and it survives a connector restart (unlike the
        connector's in-memory selection). A session that never ran a turn, or
        one last driven by another agent (a subagent, or ``compaction``), has
        no mode to report.
        """

        agent = session.get("agent")
        if isinstance(agent, str) and agent in _PERMISSION_PRESETS:
            return agent
        return None

    # ------------------------------------------------------------------ #
    # sessions
    # ------------------------------------------------------------------ #

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        sessions = await self._client.list_sessions()
        metas: list[SessionMeta] = []
        for session in sessions[: max(limit, 0)]:
            sid = str(session.get("id") or "")
            if not sid:
                continue
            # V2 nests the project directory under ``location``.
            directory = _session_directory(session)
            self._remember_directory(sid, directory)
            model = session.get("model") or {}
            metas.append(
                SessionMeta(
                    session_id=sid,
                    external_session_id=sid,
                    runtime="opencode",
                    title=session.get("title"),
                    cwd=directory,
                    ordering_time=_iso_ms((session.get("time") or {}).get("updated")),
                    source_state=SessionSourceState(availability="available"),
                    metadata={
                        "model": f"{model.get('providerID')}/{model.get('id')}" if model else None,
                    },
                )
            )
        return tuple(metas)

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        """Every session opencode knows about, across all projects.

        ``GET /api/session`` paginates, and the client walks ``cursor.next`` to
        exhaustion, so one call is the complete inventory — treating the first
        page as the whole set would make session sync "delete" everything beyond
        it. ``page_size`` only caps the returned slice.
        """

        return await self.list_sessions(limit=page_size, force=force)

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        native_id = self._adopt_session_binding(session_id, external_session_id)
        messages = await self._client.list_messages(native_id, self._directory_for(native_id))
        client_message_ids = self._pending_messages.resolve(native_id, messages)
        items = [
            item.to_platform_item(session_id, seq)
            for seq, item in enumerate(
                timeline.map_messages_to_timeline(native_id, messages, client_message_ids)
            )
        ]
        if limit is not None:
            items = items[-limit:]
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=native_id,
            runtime="opencode",
            items=tuple(items),
            complete=True,
            metadata={"messageCount": len(messages)},
        )

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> bool:
        """Publish a fresh snapshot ourselves; the connector need not re-poll."""

        with suppress(Exception):
            await self._publish_timeline(session_id, external_session_id)
        return True

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync:
        """Pre-build the snapshot so the connector avoids a second fetch."""

        snapshot = await self.get_session_snapshot(session_id, external_session_id)
        return PreparedSessionTimelineSync(snapshot=snapshot)

    async def _publish_timeline(
        self, session_id: str, external_session_id: str | None
    ) -> tuple[RuntimeTimelineItem, ...]:
        native_id = self._adopt_session_binding(session_id, external_session_id)
        messages = await self._client.list_messages(native_id, self._directory_for(native_id))
        client_message_ids = self._pending_messages.resolve(native_id, messages)
        items = tuple(
            item.to_platform_item(session_id, seq)
            for seq, item in enumerate(
                timeline.map_messages_to_timeline(native_id, messages, client_message_ids)
            )
        )
        await self.host.timeline_sync(
            session_id,
            "opencode",
            items,
            external_session_id=native_id,
            complete=True,
        )
        return items

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        native_id = self._adopt_session_binding(session_id, external_session_id)
        status_map = await self._client.session_status_map(self._directory_for(native_id))
        status = status_map.get(native_id) or {}
        status_type = status.get("type")
        if status_type == "busy":
            runtime_status = "running"
        elif status_type == "idle":
            runtime_status = "idle"
        else:
            runtime_status = "idle"
        if runtime_status == "running":
            self._pushed_idle.discard(native_id)
        elif native_id not in self._pushed_idle and native_id not in self._active_turns:
            # Self-heal sessions that got stuck in "running" (e.g. a turn ended
            # before this push existed): reopening them re-queries serve, so
            # re-asserting idle unlocks the client send button.
            self._pushed_idle.add(native_id)
            logger.info(
                "opencode get_session_state self-heal: pushing idle platform={} native={}",
                session_id,
                native_id,
            )
            with suppress(Exception):
                await self.host.session_state_update(
                    session_id, "opencode", status="idle", external_session_id=native_id
                )
        return SessionState(
            session_id=session_id,
            external_session_id=native_id,
            runtime="opencode",
            status=runtime_status,
            selections=await self._session_selections(session_id, native_id),
        )

    async def _session_selections(
        self, session_id: str, native_id: str
    ) -> dict[str, str | None]:
        """Report the model and permission selections the pickers should display.

        The in-memory selection wins (it is what the next turn will use);
        after a connector restart it is empty, so fall back to what the
        opencode session itself records: ``model`` for the model picker and
        ``permission`` (matched against the agent rulesets) for the
        Build/Plan picker. Without the model fallback the picker button renders
        empty and ``/model`` looks broken even though switching works; without
        the permission fallback a restarted connector always shows Build.
        """

        selections: dict[str, str | None] = dict(self._selections.get(session_id) or {})
        # The selection is echoed back exactly as it arrived. The client treats
        # ``selections`` values as opaque selection ids on both sides -- it
        # resolves them with ``modelIdsForSelectionId`` /
        # ``permissionIdForSelectionId`` -- so reporting a resolved model key
        # here left the composer unable to match any option and it fell back to
        # the first catalog entry.
        need_model = not selections.get(MODEL_SELECTION_KEY)
        need_permission = not selections.get(PERMISSION_SELECTION_KEY)
        if not (need_model or need_permission):
            return selections
        try:
            session = await self._client.get_session(native_id)
        except OpenCodeClientError:
            return selections
        if not isinstance(session, dict):
            return selections
        if need_model:
            model = session.get("model")
            if isinstance(model, dict):
                provider_id = model.get("providerID")
                model_id = model.get("id")
                if (
                    isinstance(provider_id, str)
                    and isinstance(model_id, str)
                    and provider_id
                    and model_id
                ):
                    # A selection id, like the in-memory path: the client
                    # resolves this value through the catalog, so a raw
                    # ``provider/model`` key is unresolvable for it. For a
                    # reasoning model only its variants are selectable, so the
                    # first variant stands in -- the model is what the picker
                    # shows either way.
                    model_key = f"{provider_id}/{model_id}"
                    selections[MODEL_SELECTION_KEY] = (
                        await self._model_selection_id(model_key) or model_key
                    )
        if need_permission:
            preset = self._permission_mode_from_session(session)
            if preset is not None:
                selections[PERMISSION_SELECTION_KEY] = _permission_selection_id(preset)
        return selections

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        """Return pending interaction notices (approval requests, questions)."""

        _ = external_session_id
        return tuple(self._notices.get(session_id, {}).values())

    # ------------------------------------------------------------------ #
    # turns
    # ------------------------------------------------------------------ #

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple = (),
        client_message_id: str | None = None,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = runtime_options
        try:
            session = await self._client.create_session(title, directory=cwd)
        except OpenCodeClientError as exc:
            logger.warning("opencode create session failed: {}", exc)
            return RuntimeOperationResult(ok=False, code="create_failed", message=str(exc))
        native_id = str(session["id"])
        self._bind_session(session_id, native_id)
        # V2 nests the project directory under ``location``.
        created_directory = _session_directory(session)
        self._remember_directory(native_id, str(created_directory or cwd) if (created_directory or cwd) else None)
        # Persist the selections the session was created with. Without this the
        # pickers have nothing to show for a brand-new session (the opencode
        # session record carries neither the model nor the permission mode yet)
        # and a later ``start_turn`` would drop the model again.
        if selections:
            self._selections[session_id] = dict(selections)
        self._pending_messages.register(
            native_session_id=native_id,
            client_message_id=client_message_id,
            text=content,
        )
        logger.info(
            "opencode session created: platform={} native={}", session_id, native_id
        )
        await self.host.session_meta_upsert(
            session_id,
            "opencode",
            external_session_id=native_id,
            title=title or (content[:60] if content else None),
            cwd=created_directory,
            ordering_time=_iso_ms((session.get("time") or {}).get("created")),
        )
        await self._start_turn(
            native_id, content, selections, session_id=session_id, attachments=attachments
        )
        return RuntimeOperationResult(
            ok=True,
            # Contract key is camelCase (same as codex/claude/dsh). A snake_case
            # key here is silently unreadable by the Server: session.create
            # responses then bind externalSessionId=None, and every later
            # notification that arrives with the native id (e.g. after a
            # connector restart, when the platform<->native map is gone) can
            # never resolve back to the platform session, leaving it stuck in
            # "running" (send button permanently disabled).
            result={"externalSessionId": native_id},
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        native_id = self._adopt_session_binding(session_id, external_session_id)
        self._remember_directory(native_id, cwd)
        # Persist selections so a later model change applies to subsequent
        # turns even if the caller does not re-send them.
        if selections:
            self._selections[session_id] = dict(selections)
        effective = selections or self._selections.get(session_id)
        self._pending_messages.register(
            native_session_id=native_id,
            client_message_id=client_message_id,
            text=content,
        )
        logger.info(
            "opencode start_turn: platform={} external={} -> native={}",
            session_id,
            external_session_id,
            native_id,
        )
        try:
            await self._start_turn(
                native_id, content, effective, session_id=session_id, attachments=attachments
            )
        except OpenCodeClientError as exc:
            logger.warning("opencode start_turn failed: native={} error={}", native_id, exc)
            return RuntimeOperationResult(ok=False, code="turn_failed", message=str(exc))
        return RuntimeOperationResult(ok=True)

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        """Steer the active turn.

        opencode has no dedicated steer endpoint; a prompt admitted with
        ``delivery: "steer"`` interrupts the in-flight turn and resumes with the
        new input (the same call serves an idle session). When the session is
        idle this behaves identically to ``start_turn``.
        """

        native_id = self._adopt_session_binding(session_id, external_session_id)
        self._pending_messages.register(
            native_session_id=native_id,
            client_message_id=client_message_id,
            text=content,
        )
        try:
            await self._start_turn(
                native_id,
                content,
                self._selections.get(session_id),
                session_id=session_id,
                attachments=attachments,
            )
        except OpenCodeClientError as exc:
            logger.warning("opencode steer_turn failed: native={} error={}", native_id, exc)
            return RuntimeOperationResult(ok=False, code="steer_failed", message=str(exc))
        return RuntimeOperationResult(ok=True)

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        """Store model/permission selections and mirror them onto the session.

        opencode accepts a model reference per prompt, so the model selection
        is applied to the next ``start_turn`` / ``steer_turn`` call. Pushing it
        to ``POST /api/session/{id}/model`` as well keeps the opencode-side
        session record (and the web UI, and other platform clients) in sync
        with what the platform picker shows.

        The permission selection (Build/Plan) is validated here and applied by
        the next prompt, because opencode has no endpoint to switch the mode
        after the fact. Reporting ok does not mean the mode already changed:
        like the model, it takes effect on the next turn.
        """

        raw_permission = selections.get(PERMISSION_SELECTION_KEY)
        if raw_permission and _permission_preset_from_selection(raw_permission) is None:
            return RuntimeOperationResult(
                ok=False,
                code="opencode_invalid_selection",
                message=f"Unsupported OpenCode permission selection: {raw_permission}",
            )
        self._selections[session_id] = dict(selections)
        native_id: str | None = None
        raw = selections.get(MODEL_SELECTION_KEY)
        model_key, model_variant = await self._resolve_model_selection(
            raw if isinstance(raw, str) else None
        )
        if model_key is not None:
            native_id = self._adopt_session_binding(session_id, external_session_id)
            provider_id, _, model_id = model_key.partition("/")
            if provider_id and model_id:
                try:
                    await self._client.switch_session_model(
                        native_id,
                        model_id,
                        provider_id,
                        variant=model_variant,
                        directory=self._directory_for(native_id),
                    )
                except OpenCodeClientError as exc:
                    # Non-fatal: the next prompt still carries the model ref.
                    logger.warning(
                        "opencode selection push failed: native={} error={}",
                        native_id,
                        exc,
                    )
        if raw_permission:
            if native_id is None:
                native_id = self._adopt_session_binding(session_id, external_session_id)
            mode = await self._permission_mode_for_turn(native_id, selections)
            logger.info(
                "opencode permission mode selected: platform={} native={} mode={}",
                session_id,
                native_id,
                mode or "opencode-default",
            )
        logger.info("opencode selections updated: platform={} selections={}", session_id, dict(selections))
        return RuntimeOperationResult(ok=True)

    async def _start_turn(
        self,
        native_id: str,
        content: str,
        selections: Mapping[str, str | None] | None,
        session_id: str | None = None,
        attachments: tuple = (),
    ) -> None:
        model = await self._model_ref(selections)
        # Build/Plan is the agent this turn runs as; opencode remembers it on
        # the session, so the picker can read the mode back after a restart.
        agent = await self._permission_mode_for_turn(native_id, selections)
        # Line the streamed items up with the orderSeq the turn-end snapshot
        # will assign them (see _seed_stream_order).
        await self._seed_stream_order(native_id)
        parts: tuple[dict[str, object], ...] = ()
        if attachments and session_id:
            materialized = await materialize_opencode_attachments(
                self.host, session_id, tuple(attachments)
            )
            parts = tuple(item.to_part() for item in materialized)
            if len(materialized) != len(attachments):
                logger.warning(
                    "opencode turn attachment partial: platform={} requested={} materialized={}",
                    session_id,
                    len(attachments),
                    len(materialized),
                )
        logger.info(
            "opencode turn start: platform={} native={} model={} variant={} agent={} attachments={}",
            self._platform_id(native_id),
            native_id,
            (model or {}).get("modelID"),
            (model or {}).get("variant"),
            agent,
            len(parts),
        )
        idle_before = self._idle_seq.get(native_id, 0)
        # Mark the turn active BEFORE admitting the prompt. V2's admit is
        # durable (``POST /api/session/{id}/prompt`` returns as soon as the
        # message is queued) and the watchdog may reconcile the session idle
        # while this await is still in flight for a very fast turn; _finish_turn
        # must see it in _active_turns so the turn is properly ended instead of
        # being dropped as "untracked" and leaving the platform session stuck in
        # "running".
        self._active_turns.add(native_id)
        self._pushed_idle.discard(native_id)
        await self._client.prompt_async(
            native_id,
            content,
            model=model,
            agent=agent,
            directory=self._directory_for(native_id),
            extra_parts=parts,
        )
        idle_after = self._idle_seq.get(native_id, 0)
        if idle_after != idle_before:
            logger.warning(
                "opencode turn-start race: idle arrived while prompt in flight "
                "platform={} native={} (idle_seq {}->{})",
                self._platform_id(native_id),
                native_id,
                idle_before,
                idle_after,
            )
        # If an idle arrived during the await, _finish_turn already ran and
        # removed this session from _active_turns; do not re-push running.
        if native_id not in self._active_turns:
            return
        self._aborted_turns.discard(native_id)
        self._recently_ended.pop(native_id, None)
        with suppress(Exception):
            await self.host.session_state_update(
                self._platform_id(native_id),
                "opencode",
                status="running",
                external_session_id=native_id,
            )

    async def _model_selection_id(self, model_key: str) -> str | None:
        """The selection id a client can resolve back to ``model_key``.

        Mirrors what ``list_model_catalog`` hands out: a model without reasoning
        variants is addressable directly, a reasoning model only through one of
        its variants (its own ``selection_id`` is ``None`` there).
        """

        models = await self._connected_models()
        model = models.get(model_key)
        if model is None:
            return None
        reasoning = _reasoning_items(model_key, model.get("variants") or {})
        if not reasoning:
            return protocol_selection_id(
                "opencode", "model", {"model_id": model_key, "reasoning_id": None}
            )
        return reasoning[0].selection_id

    async def _resolve_model_selection(
        self, raw: str | None
    ) -> tuple[str | None, str | None]:
        """``(provider/model key, variant)`` for a client-supplied model selection.

        Accepts both shapes the platform uses. The composer picks with the model
        key, but the selection it sends over the runtime RPC is the catalog's
        ``selection_id`` -- a one-way hash -- so the id is resolved by rebuilding
        the catalog's own ids and matching, the same way
        ``_permission_preset_from_selection`` resolves a permission id. Only
        accepting the key meant a picked model never reached the prompt: the turn
        went out without a model and opencode silently used its own default,
        while the picker still showed what had been chosen.

        The variant is the second half of the answer. A reasoning model has no
        selectable id of its own -- its variants do -- so the id the client sends
        identifies *model plus effort*, and dropping the effort (as this did)
        meant the picker offered a choice the turn never applied. opencode's own
        ``ModelRef`` is ``{id, providerID, variant?}`` both for
        ``POST /api/session/{id}/model`` and for a prompt's ``model`` field.
        """

        if not raw:
            return None, None
        if "/" in raw:
            provider_id, _, model_id = raw.partition("/")
            return (raw if provider_id and model_id else None), None
        models = await self._connected_models()
        for key, model in models.items():
            if (
                protocol_selection_id(
                    "opencode", "model", {"model_id": key, "reasoning_id": None}
                )
                == raw
            ):
                return key, None
            for reasoning in _reasoning_items(key, model.get("variants") or {}):
                if reasoning.selection_id == raw:
                    # ``metadata.variant`` is opencode's own variant key, which is
                    # what ModelRef.variant expects; ``id`` is the reasoning
                    # effort, which usually matches but need not.
                    variant = reasoning.metadata.get("variant")
                    return key, variant if isinstance(variant, str) and variant else None
        logger.warning(
            "opencode model selection matches no catalog model: selection={}", raw
        )
        return None, None

    async def _model_ref(
        self, selections: Mapping[str, str | None] | None
    ) -> dict[str, str] | None:
        raw = (selections or {}).get(MODEL_SELECTION_KEY)
        key, variant = await self._resolve_model_selection(
            raw if isinstance(raw, str) else None
        )
        if key is None:
            return None
        provider_id, _, model_id = key.partition("/")
        ref = {"providerID": provider_id, "modelID": model_id}
        if variant:
            ref["variant"] = variant
        return ref

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = reason
        native_id = self._native_id(session_id, None)
        try:
            await self._client.abort(native_id, self._directory_for(native_id))
        except OpenCodeClientError as exc:
            return RuntimeOperationResult(ok=False, code="abort_failed", message=str(exc))
        if native_id in self._active_turns:
            self._aborted_turns.add(native_id)
            # Serve normally emits session.idle after an abort; reconcile now
            # so a missed idle event does not leave the session stuck running.
            with suppress(Exception):
                await self._reconcile_active_turns()
        return RuntimeOperationResult(ok=True)

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        native_id = self._native_id(session_id, external_session_id)
        # ``GET /command`` is directory-scoped and answers 503 without one, so
        # the session's own workspace must be passed or the user's skills and
        # commands never show up in the slash menu.
        return await self._list_runtime_commands(query, limit, self._directory_for(native_id))

    async def list_runtime_commands(
        self,
        limit: int = 100,
    ) -> tuple[RuntimeCommand, ...]:
        # No session context here: opencode answers for the serve cwd, and a
        # project-less cwd has no commands (503) — only the builtins remain.
        return await self._list_runtime_commands(None, limit, None)

    async def _list_runtime_commands(
        self, query: str | None, limit: int, directory: str | None
    ) -> tuple[RuntimeCommand, ...]:
        items: list[RuntimeCommand] = []
        # Built-in slash commands first — they are the user's primary entry
        # points (``/model``, ``/compact`` ...) and must survive any limit
        # truncation that would otherwise drop them once skills fill the list.
        for spec in _OPENCODE_BUILTIN_COMMANDS:
            name = str(spec["name"])
            title = str(spec["title"])
            if query and query.lower() not in name.lower() and query.lower() not in title.lower():
                continue
            items.append(
                RuntimeCommand(
                    id=name,
                    title=title,
                    description=str(spec["description"]),
                    category="builtin",
                    scope="session",
                    accepts_args=bool(spec["accepts_args"]),
                    metadata={
                        "source": "builtin",
                        "builtin": True,
                        **dict(spec["metadata"]),
                    },
                )
            )
            if len(items) >= limit:
                return tuple(items)
        try:
            commands = await self._client.list_commands(directory=directory)
        except OpenCodeClientError as exc:
            logger.warning(
                "opencode list_commands failed: directory={} error={}", directory, exc
            )
            return tuple(items)
        seen = {cmd.id for cmd in items}
        for cmd in commands:
            if not isinstance(cmd, dict):
                continue
            name = str(cmd.get("name") or "")
            if not name or name in seen:
                continue
            if query and query.lower() not in name.lower():
                continue
            items.append(
                RuntimeCommand(
                    id=name,
                    title=name,
                    description=cmd.get("description") or None,
                    aliases=tuple(cmd.get("hints") or ()),
                    category=cmd.get("source"),
                    scope="session",
                    accepts_args=True,
                    metadata={"source": cmd.get("source"), "template": cmd.get("template")},
                )
            )
            if len(items) >= limit:
                break
        return tuple(items)

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        native_id = self._adopt_session_binding(session_id, external_session_id)
        directory = self._directory_for(native_id)
        arguments = raw if raw is not None else " ".join(args)
        # Built-in slash commands map to dedicated opencode endpoints, not
        # ``POST /session/{id}/command`` (which only runs user-defined skills).
        builtin = command.lstrip("/")
        if builtin in _REMOVED_BUILTIN_COMMAND_NAMES:
            return RuntimeCommandResult(
                command=command,
                ok=False,
                code="unsupported",
                message="当前 opencode 版本不再提供会话分享接口",
            )
        if builtin in _OPENCODE_BUILTIN_COMMAND_NAMES:
            return await self._execute_builtin_command(
                session_id, native_id, builtin, arguments, directory, command
            )
        try:
            await self._client.execute_command(
                native_id, command, arguments, directory
            )
        except OpenCodeClientError as exc:
            logger.warning("opencode execute_command failed: {}", exc)
            return RuntimeCommandResult(command=command, ok=False, code="command_failed", message=str(exc))
        return RuntimeCommandResult(command=command, ok=True)

    @staticmethod
    def _command_ok(
        command: str, text: str, **extra: Any
    ) -> RuntimeCommandResult:
        """A completed command with display text for the client's toast."""

        return RuntimeCommandResult(
            command=command,
            ok=True,
            result={"text": text, "executionState": "completed", **extra},
        )

    async def _execute_builtin_command(
        self,
        session_id: str,
        native_id: str,
        builtin: str,
        arguments: str,
        directory: str | None,
        command: str,
    ) -> RuntimeCommandResult:
        """Dispatch a built-in slash command to its dedicated opencode endpoint."""

        try:
            if builtin == "model":
                # The platform drives ``/model`` through its own selector
                # (``metadata.ui.kind == "selector"``), so this branch only
                # runs for API-level callers that still pass an argument.
                model_ref = arguments.strip()
                if not model_ref:
                    return RuntimeCommandResult(
                        command=command,
                        ok=False,
                        code="missing_argument",
                        message="usage: /model <provider>/<model_id>",
                    )
                # Accept ``provider/model`` or a bare ``model`` id (then we
                # cannot pick a provider and must reject).
                if "/" in model_ref:
                    provider_id, model_id = model_ref.split("/", 1)
                else:
                    return RuntimeCommandResult(
                        command=command,
                        ok=False,
                        code="invalid_argument",
                        message=(
                            "opencode requires <provider>/<model_id>, e.g. "
                            "local/qwen3.8-27b"
                        ),
                    )
                variant = None
                if "|" in model_id:
                    model_id, variant = model_id.split("|", 1)
                await self._client.switch_session_model(
                    native_id, model_id, provider_id, variant=variant, directory=directory
                )
                self._selections.setdefault(session_id, {})[MODEL_SELECTION_KEY] = (
                    f"{provider_id}/{model_id}"
                )
                return self._command_ok(command, f"已切换模型为 {provider_id}/{model_id}")
            elif builtin == "compact":
                model = await self._resolve_model_for_compact(session_id, native_id)
                if model is None:
                    return RuntimeCommandResult(
                        command=command,
                        ok=False,
                        code="model_required",
                        message=_COMPACT_MODEL_FALLBACK_ERROR,
                    )
                provider_id, model_id = model
                await self._client.summarize_session(
                    native_id, provider_id, model_id, directory=directory
                )
                return self._command_ok(command, "会话已压缩")
            elif builtin == "fork":
                forked = await self._client.fork_session(
                    native_id, message_id=arguments.strip() or None, directory=directory
                )
                new_id = (forked or {}).get("id")
                text = f"已创建分叉会话 {new_id}" if new_id else "已创建分叉会话"
                return self._command_ok(command, text)
            elif builtin == "undo":
                # /undo accepts an optional messageID arg; without one, the
                # client auto-resolves the latest model message. ``False``
                # means "no recent model message to revert" — treat as a
                # no-op success rather than an error.
                reverted = await self._client.revert_latest_message(
                    native_id,
                    message_id=arguments.strip() or None,
                    directory=directory,
                )
                if not reverted:
                    return RuntimeCommandResult(
                        command=command,
                        ok=True,
                        code="nothing_to_undo",
                        message="没有可撤销的模型消息",
                    )
                return self._command_ok(command, "已撤销最近一条模型消息")
            else:
                return RuntimeCommandResult(
                    command=command,
                    ok=False,
                    code="unknown_command",
                    message=f"builtin command {builtin!r} not implemented",
                )
        except OpenCodeClientError as exc:
            logger.warning("opencode builtin {} failed: {}", builtin, exc)
            return RuntimeCommandResult(
                command=command, ok=False, code="command_failed", message=str(exc)
            )

    async def _resolve_model_for_compact(
        self, session_id: str, native_id: str
    ) -> tuple[str, str] | None:
        """Pick the model opencode should use to write the session summary.

        Order: the platform session's picked model, then the model recorded on
        the opencode session itself, then the model of the latest assistant
        message. Returns ``None`` when the session never used a model.
        """

        raw = (self._selections.get(session_id) or {}).get(MODEL_SELECTION_KEY)
        # ``/session/{id}/summarize`` takes providerID + modelID only, so the
        # variant is not part of the answer here.
        picked, _variant = await self._resolve_model_selection(
            raw if isinstance(raw, str) else None
        )
        if picked is not None:
            provider_id, _, model_id = picked.partition("/")
            if provider_id and model_id:
                return provider_id, model_id
        try:
            session = await self._client.get_session(native_id)
        except OpenCodeClientError:
            session = {}
        model = session.get("model") if isinstance(session, dict) else None
        if isinstance(model, dict):
            provider_id = model.get("providerID")
            model_id = model.get("id")
            if isinstance(provider_id, str) and isinstance(model_id, str) and provider_id and model_id:
                return provider_id, model_id
        try:
            messages = await self._client.list_messages(
                native_id, directory=self._directory_for(native_id)
            )
        except OpenCodeClientError:
            return None
        for message in reversed(messages):
            info = message.get("info") if isinstance(message, dict) else None
            if not isinstance(info, dict) or info.get("role") != "assistant":
                continue
            provider_id = info.get("providerID")
            model_id = info.get("modelID")
            if isinstance(provider_id, str) and isinstance(model_id, str) and provider_id and model_id:
                return provider_id, model_id
        return None

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        """Resolve a pending approval or question notice.

        Permission actions map to opencode's reply vocabulary:
        ``approve`` → ``once``, ``approve_for_session`` → ``always``,
        ``reject`` → ``reject``.
        """

        notices = self._notices.get(session_id, {})
        notice = notices.get(notice_id)
        if notice is None:
            return RuntimeOperationResult(
                ok=False, code="notice_not_found", message=f"notice {notice_id} not found"
            )
        interaction_type = notice.interaction_type
        context = notice.context or {}
        native_id = self._native_id(session_id, context.get("externalSessionId"))
        directory = self._directory_for(native_id)
        try:
            if interaction_type == "approval":
                permission_id = str(context.get("permissionId") or "")
                response = self._permission_response_for_action(action_id)
                if not permission_id or response is None:
                    return RuntimeOperationResult(
                        ok=False,
                        code="invalid_approval",
                        message=f"cannot resolve permission response for action={action_id}",
                    )
                await self._client.reply_permission(
                    native_id, permission_id, response, directory=directory
                )
            elif interaction_type in {"question", "input_request"}:
                # ``input_request`` is what the question notices are published
                # as (the Server's accepted kinds); ``question`` stays accepted
                # for notices raised by older builds.
                question_id = str(context.get("questionId") or "")
                if not question_id:
                    return RuntimeOperationResult(
                        ok=False, code="invalid_question", message="question id missing"
                    )
                reply = ""
                if isinstance(input_data, Mapping):
                    raw_reply = input_data.get("reply")
                    if isinstance(raw_reply, str):
                        reply = raw_reply.strip()
                cancel = action_id in _QUESTION_CANCEL_ACTIONS or (
                    reply in _LEGACY_CANCEL_REPLIES
                )
                # Dismissing the card is a real opencode action; answering with
                # an empty string is not (opencode rejects an empty label).
                if cancel:
                    await self._client.reject_question(
                        native_id, question_id, directory=directory
                    )
                else:
                    form = _input_request_form_from_notice(notice)
                    raw_answers = (
                        input_data.get("answers")
                        if isinstance(input_data, Mapping)
                        else None
                    )
                    if form is not None and isinstance(raw_answers, Mapping):
                        try:
                            parsed = form.parse_answers(input_data)
                            raw_field_types = context.get("fieldTypes")
                            field_types = (
                                {
                                    str(key): str(value)
                                    for key, value in raw_field_types.items()
                                }
                                if isinstance(raw_field_types, Mapping)
                                else {}
                            )
                            answer = _opencode_answer(parsed, field_types)
                        except (InputRequestValidationError, TypeError, ValueError) as exc:
                            return RuntimeOperationResult(
                                ok=False,
                                code="invalid_question",
                                message=str(exc),
                            )
                        await self._client.reply_question(
                            native_id, question_id, answer, directory=directory
                        )
                    else:
                        if not reply:
                            return RuntimeOperationResult(
                                ok=False,
                                code="empty_reply",
                                message="a question reply cannot be empty",
                            )
                        await self._client.reply_question(
                            native_id, question_id, reply, directory=directory
                        )
            else:
                return RuntimeOperationResult(
                    ok=False,
                    code="unsupported_interaction",
                    message=f"interaction type {interaction_type} not supported",
                )
        except OpenCodeClientError as exc:
            logger.warning("opencode respond_interaction failed: {}", exc)
            return RuntimeOperationResult(ok=False, code="reply_failed", message=str(exc))
        # Mark the notice resolved and drop it from the pending set.
        notices.pop(notice_id, None)
        with suppress(Exception):
            await self.host.notice_upsert(
                SessionNotice(
                    notice_id=notice.notice_id,
                    session_id=session_id,
                    runtime="opencode",
                    type=notice.type,
                    title=notice.title,
                    message=notice.message,
                    severity=notice.severity,
                    status="resolved",
                    interaction_type=notice.interaction_type,
                )
            )
        # The approval was blocking: without an explicit state update the
        # platform session stays in ``waiting_approval`` for the rest of the
        # turn (the client keeps the composer blocked) even though opencode has
        # resumed. Only a tracked turn is pushed back to ``running`` — an
        # untracked one would be pushed idle by the idle handler.
        if native_id in self._active_turns:
            with suppress(Exception):
                await self.host.session_state_update(
                    session_id, "opencode", status="running", external_session_id=native_id
                )
        return RuntimeOperationResult(ok=True)

    @staticmethod
    def _permission_response_for_action(action_id: str) -> str | None:
        if action_id in {"approve", "approved"}:
            return "once"
        if action_id in {"approve_for_session", "approved_for_session"}:
            return "always"
        if action_id in {"reject", "decline", "cancel"}:
            return "reject"
        return None

    # ------------------------------------------------------------------ #
    # SSE event loop
    # ------------------------------------------------------------------ #

    async def _event_loop(self) -> None:
        """Consume the global /event stream and push state to the host.

        Transport-level resilience: on disconnect, back off and reconnect.
        """

        backoff = 1.0
        while not self._stopping:
            try:
                async for event in self._client.stream_events():
                    backoff = 1.0
                    self._stream_failures = 0
                    if not self._event_stream_connected:
                        self._event_stream_connected = True
                        logger.info("opencode event stream connected (first event received)")
                    await self._handle_event(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - transport errors are expected
                if self._stopping:
                    break
                self._event_stream_connected = False
                self._stream_failures += 1
                logger.warning("opencode event stream error: {}; reconnecting", exc)
                with suppress(Exception):
                    await self._reconcile_active_turns()
                if self._stream_failures >= STREAM_FAILURE_RECOVERY_THRESHOLD:
                    if not self._health_degraded:
                        self._health_degraded = True
                        with suppress(Exception):
                            await self.host.runtime_health_update(
                                "error",
                                {
                                    "code": "opencode_unreachable",
                                    "message": f"opencode serve 持续不可达: {exc}",
                                    "retryable": True,
                                },
                            )
                    self._schedule_recovery("stream-down")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _state_watchdog(self) -> None:
        """Reconcile in-flight turns and poll opencode's pending interactions.

        A turn-end missed while the SSE stream was down (or before this process
        started) would otherwise leave the platform session stuck in "running"
        forever, disabling the client send button. V2 publishes no terminal
        ``session.idle`` event at all, so this loop is the primary turn-end
        detector and runs at ``TURN_POLL_INTERVAL_S`` whenever a turn is in
        flight; idle sessions fall back to the slow reconcile interval.

        The same tick polls each busy session's pending permission/question
        lists: in V2 those are opencode's ``/permission`` and ``/form`` routes
        rather than events, and an unanswered request blocks the turn.
        """

        while not self._stopping:
            interval = (
                TURN_POLL_INTERVAL_S
                if self._active_turns
                else self._state_reconcile_interval_s
            )
            await asyncio.sleep(interval)
            if self._stopping:
                break
            with suppress(Exception):
                await self._reconcile_active_turns()
            with suppress(Exception):
                await self._poll_pending_interactions()
            with suppress(Exception):
                await self._flush_unended_turns()

    async def _reconcile_active_turns(self) -> None:
        """Emit the missing turn-end for turns opencode no longer reports busy.

        ``GET /api/session/active`` is a single global map (``{ses_x: {type:
        "running"}}``), so one request covers every candidate session.
        """

        # Primary set: turns this process started and has not ended.
        candidates = set(self._active_turns)
        # Safety net: known sessions that we have not yet confirmed idle. These
        # cover the case where the connector restarted mid-turn (so _active_turns
        # is empty) or where an idle event was lost and the active-turn bookkeeping
        # somehow desynced. Without this, a stuck "running" session can only be
        # recovered when the user reopens it (get_session_state self-heal).
        for native_id in self._session_dirs:
            if native_id not in self._pushed_idle:
                candidates.add(native_id)
        if not candidates:
            return
        try:
            status_map = await self._client.session_status_map()
        except OpenCodeClientError as exc:
            logger.debug("opencode reconcile skipped: {}", exc)
            return
        recovered = []
        for native_id in list(candidates):
            entry = status_map.get(native_id)
            if isinstance(entry, dict) and entry.get("type") == "busy":
                continue
            recovered.append(native_id)
        for native_id in recovered:
            if await self._has_pending_interactions(native_id):
                # The turn blocks on the user, not on serve. Reconciling it to
                # idle here would remove it from the interaction poll's target
                # set before the question card was ever raised.
                logger.info(
                    "opencode reconcile deferred: platform={} native={} waits on a pending interaction",
                    self._platform_id(native_id),
                    native_id,
                )
                continue
            platform_id = self._platform_id(native_id)
            if native_id in self._active_turns or native_id in self._recently_ended:
                logger.info(
                    "opencode reconcile: turn end recovered for platform={} native={} (idle event missed)",
                    platform_id,
                    native_id,
                )
                await self._finish_turn(native_id)
            else:
                # Safety-net session (not tracked by this process, not recently
                # ended). Serve says it is idle; just nudge the platform back to
                # idle without emitting turnEnded, which would be wrong for a
                # turn this connector never started.
                logger.info(
                    "opencode reconcile: idle safety-net push for platform={} native={}",
                    platform_id,
                    native_id,
                )
                self._pushed_idle.add(native_id)
                with suppress(Exception):
                    await self.host.session_state_update(
                        platform_id, "opencode", status="idle", external_session_id=native_id
                    )

    async def _poll_pending_interactions(self) -> None:
        """Mirror opencode's pending permission requests and questions as notices.

        opencode 2.x keeps both lists server-side (``GET /api/session/{id}/
        permission`` and ``.../form``) instead of publishing events for them, and
        an unanswered request blocks the turn: the model waits for the user while
        the platform session sits in "running" forever. Each tick compares the
        pending ids with the notices already shown, raises a notice for anything
        new, and resolves notices opencode closed on its own.
        """

        targets: list[str] = []
        for native_id in self._active_turns:
            if self._platform_id(native_id):
                targets.append(native_id)
        for platform_id, notices in self._notices.items():
            native_id = self._native_id(platform_id, None)
            if not any(entry.interaction_type for entry in notices.values()):
                continue
            if native_id not in targets and self._directory_for(native_id):
                targets.append(native_id)
        # A turn this process never started (native TUI, or a connector restart
        # mid-turn) blocks on a pending question exactly like a tracked one; ask
        # serve which sessions it considers busy so those requests surface too.
        try:
            status_map = await self._client.session_status_map()
        except OpenCodeClientError as exc:
            logger.debug("opencode interaction poll skipped the busy scan: {}", exc)
            status_map = {}
        for native_id, entry in status_map.items():
            if (
                isinstance(entry, dict)
                and entry.get("type") == "busy"
                and native_id not in targets
                and native_id in self._native_to_platform
            ):
                targets.append(native_id)
        for native_id in targets:
            with suppress(OpenCodeClientError):
                await self._sync_pending_permissions(native_id)
            with suppress(OpenCodeClientError):
                await self._sync_pending_forms(native_id)

    async def _has_pending_interactions(self, native_id: str) -> bool:
        """True when serve still holds an unanswered permission or form for the session.

        Used by the turn reconciler: a session waiting on the user must not be
        reconciled to idle, or the interaction card would be raised too late (or
        never) while the composer opens early. A failed probe is treated as
        "nothing pending" so a dead serve cannot freeze the session in running.
        """

        directory = self._directory_for(native_id)
        try:
            if await self._client.list_pending_permissions(native_id, directory):
                return True
            return bool(await self._client.list_pending_forms(native_id, directory))
        except OpenCodeClientError:
            return False

    async def _sync_pending_permissions(self, native_id: str) -> None:
        platform_id = self._platform_id(native_id)
        if not platform_id:
            return
        pending = await self._client.list_pending_permissions(
            native_id, self._directory_for(native_id)
        )
        notices = self._notices.get(platform_id, {})
        pending_ids = {
            str(item.get("id") or "")
            for item in pending
            if str(item.get("id") or "")
        }
        for item in pending:
            permission_id = str(item.get("id") or "")
            notice_id = f"notice_opencode_perm_{permission_id}"
            if not permission_id or notice_id in notices:
                continue
            # A V2 permission request carries the same fields a 1.x
            # ``permission.asked`` event did (action + resources).
            await self._handle_permission_asked(platform_id, native_id, dict(item))
        for permission_id in list(self._noticed_permission_ids(platform_id) - pending_ids):
            await self._handle_permission_replied(
                platform_id, native_id, {"id": permission_id}
            )

    async def _sync_pending_forms(self, native_id: str) -> None:
        platform_id = self._platform_id(native_id)
        if not platform_id:
            return
        pending = await self._client.list_pending_forms(
            native_id, self._directory_for(native_id)
        )
        pending_ids = {
            str(item.get("id") or "")
            for item in pending
            if str(item.get("id") or "")
        }
        notices = self._notices.get(platform_id, {})
        for item in pending:
            form_id = str(item.get("id") or "")
            notice_id = f"notice_opencode_que_{form_id}"
            if not form_id or notice_id in notices:
                continue
            await self._handle_question_asked(
                platform_id, native_id, _form_to_question_props(item)
            )
        for form_id in list(self._noticed_question_ids(platform_id) - pending_ids):
            await self._handle_question_closed(platform_id, {"id": form_id})

    def _noticed_permission_ids(self, platform_id: str) -> set[str]:
        prefix = "notice_opencode_perm_"
        return {
            notice_id.removeprefix(prefix)
            for notice_id in self._notices.get(platform_id, {})
            if notice_id.startswith(prefix)
        }

    def _noticed_question_ids(self, platform_id: str) -> set[str]:
        prefix = "notice_opencode_que_"
        return {
            notice_id.removeprefix(prefix)
            for notice_id in self._notices.get(platform_id, {})
            if notice_id.startswith(prefix)
        }

    async def _finish_turn(self, native_id: str) -> None:
        """End the tracked turn; aborts report ``interrupted``, rest ``completed``.

        An idle event for a turn this process never tracked still ends the
        platform turn: that is what frees sessions that were mid-turn across a
        connector restart. A turn already reported (via the abort reconciler or
        an earlier idle) is not reported twice.
        """

        interrupted = native_id in self._aborted_turns
        was_tracked = interrupted or native_id in self._active_turns
        self._active_turns.discard(native_id)
        self._aborted_turns.discard(native_id)
        platform_id = self._platform_id(native_id)
        logger.debug(
            "opencode finish_turn: platform={} native={} was_tracked={} interrupted={} recently_ended={}",
            platform_id,
            native_id,
            was_tracked,
            interrupted,
            self._recently_ended.get(native_id),
        )
        if was_tracked:
            self._recently_ended[native_id] = "interrupted" if interrupted else "completed"
        elif self._recently_ended.get(native_id) is not None:
            await self._finish_streaming_parts(platform_id, native_id)
            await self._publish_timeline_safe(platform_id, native_id)
            self._pending_messages.unresolve(native_id)
            await self._flush_unended_turns()
            return
        outcome = self._recently_ended.get(native_id, "completed")
        # Final live state (items flip from ``running`` to ``done``) before the
        # snapshot, which restates the same item ids from the message list.
        await self._finish_streaming_parts(platform_id, native_id)
        items = await self._publish_timeline_safe(platform_id, native_id)
        if items is not None and not items:
            # opencode reported the turn finished while the snapshot holds no items
            # at all, so the platform records a completed turn with nothing to
            # show. This has been observed when the provider produced no output:
            # the turn is closed as "completed" and the real failure only surfaces
            # later as a separate session.error, if at all. Warning here is the
            # only place the gap is visible - reconcile's own status poll succeeded,
            # so it has no error of its own to report. Outcome stays "completed"
            # because an empty turn is not provably a failure.
            logger.warning(
                "opencode turn ended with no timeline items: platform={} native={} "
                "outcome={} elapsed={}s - nothing was rendered for this turn",
                platform_id,
                native_id,
                outcome,
                self._turn_elapsed_s(native_id),
            )
        # After the snapshot: it is the authoritative picture of what opencode
        # thinks finished, and anything still running in it will never be
        # corrected by a later event.
        await self._settle_unfinished_items(platform_id, native_id, items or (), outcome)
        self._pending_messages.unresolve(native_id)
        await self._report_turn_end(platform_id, native_id, outcome)
        await self._flush_unended_turns()

    def _turn_elapsed_s(self, native_id: str) -> float:
        """Seconds since this turn became active, or ``-1.0`` if unknown.

        Set on the pre-prompt path, so a turn adopted after a connector restart
        reports ``-1`` rather than a misleading 0.
        """

        session = self._stream_sessions.get(native_id)
        if session is None or session.started_at <= 0.0:
            return -1.0
        return round(time.monotonic() - session.started_at, 1)

    async def _report_turn_end(self, platform_id: str, native_id: str, outcome: str) -> None:
        """Deliver turn-end + idle state to the host, or remember it for retry.

        The client's "working" indicator tracks the pushed session state, so
        the idle update is as load-bearing as ``turnEnded`` itself (the codex
        adapter sends both on every turn end). A lost pair leaves the platform
        session stuck in "running": the server then never forwards follow-up
        messages, and the client cannot interact again even after reopening
        the session.
        """

        try:
            await self.host.session_turn_ended(
                platform_id, "opencode", external_session_id=native_id, outcome=outcome
            )
            await self.host.session_state_update(
                platform_id, "opencode", status="idle", external_session_id=native_id
            )
            self._pushed_idle.add(native_id)
            logger.info(
                "opencode turn-end delivered: platform={} native={} outcome={} elapsed={}s",
                platform_id,
                native_id,
                outcome,
                self._turn_elapsed_s(native_id),
            )
        except Exception as exc:  # noqa: BLE001 - retry through the watchdog
            logger.warning(
                "opencode turn-end delivery failed; will retry: platform={} native={} error={}",
                platform_id,
                native_id,
                exc,
            )
            self._unended_turns[native_id] = outcome

    async def _flush_unended_turns(self) -> None:
        if not self._unended_turns:
            return
        for native_id, outcome in list(self._unended_turns.items()):
            try:
                await self.host.session_turn_ended(
                    self._platform_id(native_id),
                    "opencode",
                    external_session_id=native_id,
                    outcome=outcome,
                )
                await self.host.session_state_update(
                    self._platform_id(native_id),
                    "opencode",
                    status="idle",
                    external_session_id=native_id,
                )
            except Exception as exc:  # noqa: BLE001 - keep retrying
                logger.debug("opencode turn-end retry failed native={} error={}", native_id, exc)
                continue
            logger.info(
                "opencode turn-end retried successfully: platform={} native={}",
                self._platform_id(native_id),
                native_id,
            )
            self._pushed_idle.add(native_id)
            self._unended_turns.pop(native_id, None)

    async def _publish_timeline_safe(
        self, session_id: str, external_session_id: str
    ) -> tuple[RuntimeTimelineItem, ...] | None:
        """Publish the authoritative snapshot, or ``None`` when it could not be read.

        ``None`` and ``()`` mean different things and callers must not confuse
        them: an empty snapshot is evidence (the turn rendered nothing), while
        ``None`` means we never learned what opencode holds, so emptiness proves
        nothing.
        """
        try:
            return await self._publish_timeline(session_id, external_session_id)
        except Exception as exc:  # noqa: BLE001 - snapshot failures must not block turn-end
            logger.warning(
                "opencode timeline publish failed: platform={} native={} error={}",
                session_id,
                external_session_id,
                exc,
            )
            return None

    async def _settle_unfinished_items(
        self,
        platform_id: str,
        native_id: str,
        items: tuple[RuntimeTimelineItem, ...],
        outcome: str,
    ) -> None:
        """Give items opencode left ``running`` at turn end a terminal state.

        opencode has been observed closing a turn with ``outcome=completed``
        while tool items were still ``running``: the provider stalled, the event
        stream went quiet for minutes, and the turn ended without ever reporting
        those tools as finished. The snapshot reports them faithfully as running,
        so the client keeps a spinner on a turn that is over and nothing will ever
        clear it. An ``interrupted`` outcome has the same problem by definition.

        The inconsistency is worth a WARNING when opencode claimed success, and
        either way the item is restated as ``failed``: the fact stays visible in
        the log, and the UI stops waiting.
        """

        unfinished = [item for item in items if item.status == "running"]
        if not unfinished:
            return
        if outcome == "completed":
            logger.warning(
                "opencode turn ended with unfinished items: platform={} native={} "
                "outcome={} count={} items={}",
                platform_id,
                native_id,
                outcome,
                len(unfinished),
                ", ".join(f"{item.type}:{item.id}" for item in unfinished[:10]),
            )
        for item in unfinished:
            try:
                await self.host.timeline_item_upsert(
                    replace(item, status="failed", revision=item.revision + 1)
                )
            except Exception as exc:  # noqa: BLE001 - best effort, never fatal
                logger.warning(
                    "opencode unfinished item settle failed: item={} error={}", item.id, exc
                )

    def _status_push_is_recent(self, native_id: str, status: str) -> bool:
        """True when this exact status was pushed moments ago.

        Bounded on purpose: a duplicate that arrives seconds later still has to
        be pushed, so a lost update cannot leave the session stuck in the wrong
        state. This only swallows the burst opencode emits for one transition.
        """

        previous = self._status_pushes.get(native_id)
        if previous is None:
            return False
        pushed_status, pushed_at = previous
        return (
            pushed_status == status
            and time.monotonic() - pushed_at < STATUS_PUSH_DEDUPE_WINDOW_S
        )

    def _remember_status_push(self, native_id: str, status: str) -> None:
        self._status_pushes[native_id] = (status, time.monotonic())

    async def _handle_event(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        props = event.get("properties") or {}
        native_id = props.get("sessionID")
        if not native_id:
            return
        platform_id = self._platform_id(native_id)
        logger.debug(
            "opencode event: type={} platform={} native={}", etype, platform_id, native_id
        )
        if etype == "session.idle":
            self._idle_seq[native_id] = self._idle_seq.get(native_id, 0) + 1
            logger.info(
                "opencode session.idle: platform={} native={}", platform_id, native_id
            )
            await self._finish_turn(native_id)
        elif etype == "session.status":
            status_type = (props.get("status") or {}).get("type")
            logger.debug(
                "opencode event session.status: platform={} native={} status={} active={}",
                platform_id,
                native_id,
                status_type,
                native_id in self._active_turns,
            )
            if status_type == "busy":
                # Only a turn this process started and has not yet ended may
                # drive the platform session into "running". ``opencode serve``
                # replays a session's current status on every SSE (re)connect,
                # so an untracked busy can arrive long after the turn finished
                # (its idle already reported). Reflecting it would flip the
                # session back to "running" and, because the watchdog only
                # reconciles tracked turns, nothing would ever restore idle —
                # the client's send button would stay disabled after the turn
                # already showed as ended. Codex ties running to an active turn
                # id for the same reason.
                if native_id not in self._active_turns:
                    logger.debug(
                        "opencode session.status busy ignored (no active turn): platform={} native={}",
                        platform_id,
                        native_id,
                    )
                    return
                if self._status_push_is_recent(native_id, "running"):
                    # opencode emits the same status twice within milliseconds
                    # (verified on 1.18.34: 24 identical ``busy`` events in the
                    # last 60 log lines). Each one became another
                    # ``session state push`` to the Server for no change at all.
                    logger.debug(
                        "opencode session.status busy suppressed (duplicate): platform={} native={}",
                        platform_id,
                        native_id,
                    )
                    return
                logger.info(
                    "opencode session.status busy: platform={} native={}", platform_id, native_id
                )
                self._pushed_idle.discard(native_id)
                self._remember_status_push(native_id, "running")
                with suppress(Exception):
                    await self.host.session_state_update(
                        platform_id,
                        "opencode",
                        status="running",
                        external_session_id=native_id,
                    )
            elif status_type == "idle":
                # ``session.status idle`` precedes ``session.idle`` on the wire
                # (verified against 1.18.34), so it ends the turn a beat
                # earlier. Only tracked turns are ended here: a replayed idle
                # for an unrelated session must not fabricate a turn-end, and
                # untracked-but-stale sessions are covered by the watchdog's
                # safety-net reconcile.
                if native_id in self._active_turns or native_id in self._recently_ended:
                    logger.info(
                        "opencode session.status idle: platform={} native={}",
                        platform_id,
                        native_id,
                    )
                    self._status_pushes.pop(native_id, None)
                    self._idle_seq[native_id] = self._idle_seq.get(native_id, 0) + 1
                    await self._finish_turn(native_id)
                else:
                    logger.debug(
                        "opencode session.status idle ignored (untracked): platform={} native={}",
                        platform_id,
                        native_id,
                    )
        elif etype == "session.updated":
            info = props.get("info") or {}
            with suppress(Exception):
                await self.host.session_meta_upsert(
                    platform_id,
                    "opencode",
                    external_session_id=native_id,
                    title=info.get("title"),
                    cwd=info.get("directory"),
                    ordering_time=_iso_ms((info.get("time") or {}).get("updated")),
                )
        elif etype in {"permission.asked", "permission.v2.asked"}:
            await self._handle_permission_asked(platform_id, native_id, props)
        elif etype in {"permission.replied", "permission.v2.replied"}:
            await self._handle_permission_replied(platform_id, native_id, props)
        elif etype in {"question.asked", "question.v2.asked"}:
            await self._handle_question_asked(platform_id, native_id, props)
        elif etype in {
            "question.replied",
            "question.v2.replied",
            "question.rejected",
            "question.v2.rejected",
        }:
            await self._handle_question_closed(platform_id, props)
        elif etype == "session.error":
            await self._handle_session_error(platform_id, native_id, props)
        elif etype == "message.updated":
            # Tracked for three things: the assistant message's turn id (its user
            # message lives in ``parentID``), its role — so the user's own parts
            # are never streamed back as an assistant message — and completion,
            # which finalizes the streamed text.
            info = props.get("info") or {}
            message_id = str(info.get("id") or "")
            if message_id:
                session = self._stream(native_id)
                role = str(info.get("role") or "")
                if role:
                    session.roles[message_id] = role
                parent_id = str(info.get("parentID") or "")
                if parent_id:
                    session.parents[message_id] = parent_id
                if (info.get("time") or {}).get("completed"):
                    await self._finalize_message_parts(platform_id, native_id, message_id)
        elif etype == "message.part.delta":
            await self._guard_stream_event(
                platform_id, native_id, self._handle_part_delta, platform_id, native_id, props
            )
        elif etype == "message.part.updated":
            await self._guard_stream_event(
                platform_id, native_id, self._handle_part_update, platform_id, native_id, props
            )
        elif etype == "message.part.removed":
            # The buffer goes away immediately; the platform item stays until the
            # next complete snapshot (there is no remove notification).
            self._stream(native_id).parts.pop(str(props.get("partID") or ""), None)

    def _streams_session(self, native_id: str) -> bool:
        """True when this session is one the platform shows.

        ``/global/event`` carries every opencode instance's events, including
        sessions the user opened in the opencode TUI or web UI. Streaming those
        would burn an ingest notification per throttle window for an item the
        Server cannot resolve (their platform session id is unknown), so they are
        skipped. Sessions we own are known through the directory map (filled
        while discovering sessions) or the platform<->native bindings.
        """

        return (
            native_id in self._session_dirs
            or native_id in self._platform_to_native
            or native_id in self._native_to_platform
        )

    async def _guard_stream_event(
        self,
        platform_id: str,
        native_id: str,
        handler: Any,
        *args: Any,
    ) -> None:
        """Run one streaming handler; never let a payload kill the SSE loop.

        An exception escaping ``_handle_event`` reaches the transport-level
        handler, which reconnects the stream and can end up respawning serve and
        reporting the runtime unreachable. A malformed ``message.part.*`` payload
        must cost one dropped update, nothing more. Sessions the platform does not
        show are skipped entirely (see ``_streams_session``).
        """

        if not self._streams_session(native_id):
            return
        try:
            await handler(*args)
        except Exception as exc:  # noqa: BLE001 - one bad event, one lost update
            logger.warning(
                "opencode stream event failed: platform={} native={} error={}",
                platform_id,
                native_id,
                exc,
            )

    async def _seed_stream_order(self, native_id: str) -> None:
        """Continue the timeline ordering where the last snapshot left off.

        Streamed items must land on the ``orderSeq`` the turn-end snapshot will
        give them: the platform orders a timeline by ``orderSeq`` (and pages
        with it), and the snapshot numbers items by their position in the
        flattened message list. A per-turn counter starting at 1 therefore
        collided with the previous turn's items — the client's ordering put the
        new turn's streamed text on top of the old one and the final answer
        never showed where it belonged. Seed from the current item count before
        prompting, reserving one slot for the incoming user message.
        """

        session = self._stream(native_id)
        # Per-turn bookkeeping, reset before the ordering hint below: it is
        # allowed to fail (and return early) without leaving the previous turn's
        # step counter in place.
        session.user_parts.clear()
        session.steps.clear()
        session.started_at = time.monotonic()
        try:
            messages = await self._client.list_messages(
                native_id, self._directory_for(native_id)
            )
            base = len(timeline.map_messages_to_timeline(native_id, messages))
        except Exception as exc:  # noqa: BLE001 - ordering hint only, never fatal
            # Deliberately broad: this sits on the pre-prompt path and a bad
            # response here must not swallow the user's message. Without the
            # seed the turn still streams, just with orderSeq values that the
            # turn-end snapshot renumbers.
            logger.debug(
                "opencode stream order seed skipped: native={} error={}", native_id, exc
            )
            return
        # ``base`` items already exist (0..base-1); the incoming user message
        # takes slot ``base``, so the first streamed part is ``base + 1`` — the
        # same slot the turn-end snapshot will give it.
        session.user_order_seq = max(session.next_order_seq - 1, base)
        session.next_order_seq = max(session.next_order_seq, base + 1)
        session.user_parts.clear()

    def _stream(self, native_id: str) -> _StreamSession:
        session = self._stream_sessions.get(native_id)
        if session is None:
            session = _StreamSession()
            self._stream_sessions[native_id] = session
        return session

    def _streamed_part(
        self,
        session: _StreamSession,
        part_id: str,
        message_id: str,
        part: dict[str, Any] | None = None,
    ) -> _StreamedPart | None:
        """Get or create the buffer for one part; ``None`` for user parts.

        A part is dropped when its message is known to be the user's: the user
        message is already on screen (optimistic echo plus the turn-end
        snapshot), so streaming it back would duplicate or relabel it.
        """

        if not part_id:
            return None
        if session.roles.get(message_id) == "user":
            return None
        entry = session.parts.get(part_id)
        if entry is None:
            order_seq = session.order.setdefault(part_id, session.next_order_seq)
            session.next_order_seq = max(session.next_order_seq, order_seq + 1)
            entry = _StreamedPart(
                # A delta carries no part object, so seed the minimum the item
                # mapper needs (it keys off the part id) and resume from what was
                # last published: a delta that arrives after the buffer was
                # dropped must extend the answer, not replace it with its tail.
                part=dict(part) if part else {"id": part_id, "type": "text"},
                message_id=message_id,
                text=session.published.get(part_id, ""),
                order_seq=order_seq,
            )
            session.parts[part_id] = entry
        elif part is not None:
            entry.part = dict(part)
        return entry

    async def _handle_part_delta(
        self,
        platform_id: str,
        native_id: str,
        props: dict[str, Any],
    ) -> None:
        """Append one streamed chunk to its part and flush on the throttle.

        opencode 1.18.34 sends ``{sessionID, messageID, partID, field, delta}``
        with no ``part`` object (the published SDK type is stale). ``field`` is
        the part field the chunk belongs to; only text-like fields are mapped.
        A text part is announced by a ``message.part.updated`` with empty text
        before its first delta, so an unknown buffer still lands on a text item
        and is corrected when the real part arrives.
        """

        if str(props.get("field") or "text") != "text":
            return
        delta = props.get("delta")
        if not isinstance(delta, str) or not delta:
            return
        session = self._stream(native_id)
        entry = self._streamed_part(
            session,
            str(props.get("partID") or ""),
            str(props.get("messageID") or ""),
        )
        if entry is None:
            return
        entry.text += delta
        if native_id not in self._active_turns:
            # Same as a late ``message.part.updated``: the turn is over, so this
            # is final content. Publishing it as ``running`` would leave a
            # spinner on a finished answer with nobody left to clear it.
            await self._publish_streamed_part(
                platform_id, native_id, session, entry, streaming=False
            )
            session.parts.pop(str(props.get("partID") or ""), None)
            return
        entry.dirty = True
        await self._flush_stream(platform_id, native_id, session)

    async def _handle_part_update(
        self,
        platform_id: str,
        native_id: str,
        props: dict[str, Any],
    ) -> None:
        """Publish a part opencode restated: created, changed or completed.

        ``message.part.updated`` carries the whole part, so it is trusted over
        the accumulated deltas — a dropped chunk cannot leave the client with a
        truncated answer. Flushed immediately: these events carry the
        transitions the client renders (tool running → done, text finished).
        """

        part = props.get("part")
        if not isinstance(part, dict):
            return
        part_type = str(part.get("type") or "")
        part_id = str(part.get("id") or "")
        message_id = str(part.get("messageID") or "")
        session = self._stream(native_id)
        if session.roles.get(message_id) == "user":
            await self._publish_streamed_user_message(platform_id, native_id, message_id, part)
            return
        if part_type in _STREAM_CONTENT_PART_TYPES:
            entry = self._streamed_part(session, part_id, message_id, part)
            if entry is None:
                return
            if message_id and message_id not in session.steps:
                # opencode reports one assistant message per step (a tool round
                # trip, a patch, the final answer). Their boundaries are the only
                # structure a turn has, and they are what makes "still working"
                # readable in the log between two status changes.
                session.steps.add(message_id)
                logger.info(
                    "opencode step start: platform={} native={} step={}/{} first_part={}",
                    platform_id,
                    native_id,
                    len(session.steps),
                    message_id,
                    part_type,
                )
            if part_type in {"text", "reasoning"}:
                text = part.get("text")
                if isinstance(text, str):
                    entry.text = text
            if native_id not in self._active_turns:
                # The turn already ended: opencode emits the final assistant
                # message and its parts *after* ``session.idle``. Buffering them
                # would leave the answer stuck in ``running`` forever, so publish
                # it as done.
                await self._publish_streamed_part(
                    platform_id, native_id, session, entry, streaming=False
                )
                session.parts.pop(part_id, None)
                return
            entry.dirty = True
            await self._flush_stream(platform_id, native_id, session, force=True)
            return
        if part_type == "step-finish":
            # The assistant stopped writing text for this message: publish what
            # was streamed as ``done`` so it stops rendering as in-flight while
            # the turn continues with tools. Other internal parts (step-start,
            # patch, file) say nothing about completion and are ignored.
            await self._finalize_message_parts(platform_id, native_id, message_id)

    async def _publish_streamed_user_message(
        self,
        platform_id: str,
        native_id: str,
        message_id: str,
        part: dict[str, Any],
    ) -> None:
        """Publish the user's prompt as soon as opencode reports its part.

        The turn-end snapshot is the only thing that used to carry the prompt,
        so while a turn was running the live timeline held assistant output with
        nothing to anchor it to — the round looked unanchored/misplaced and only
        settled once the snapshot arrived. The item is built by the same mapper
        the snapshot uses (same id: the opencode message id) and carries
        ``source.clientMessageId`` as soon as the pending-send registry matches
        the text, so it merges with the client's optimistic echo instead of
        doubling it.
        """

        session = self._stream(native_id)
        parts = session.user_parts.setdefault(message_id, [])
        if not any(existing.get("id") == part.get("id") for existing in parts):
            parts.append(dict(part))
        client_message_ids = self._pending_messages.resolve(
            native_id,
            [{"info": {"id": message_id, "role": "user"}, "parts": list(parts)}],
        )
        item = timeline.map_user_message_item(
            native_id,
            message_id,
            list(parts),
            client_message_id=client_message_ids.get(message_id),
        )
        if item is None:
            return
        order_seq = (
            session.user_order_seq
            if session.user_order_seq is not None
            else session.next_order_seq
        )
        try:
            await self.host.timeline_item_upsert(
                item.to_platform_item(platform_id, order_seq)
            )
        except Exception as exc:  # noqa: BLE001 - a lost update must be visible
            logger.warning(
                "opencode streamed user message push failed: message={} error={}",
                message_id,
                exc,
            )

    async def _finalize_message_parts(
        self, platform_id: str, native_id: str, message_id: str
    ) -> None:
        """Publish the streamed text of one message as ``done`` and drop it."""

        if not message_id:
            return
        session = self._stream_sessions.get(native_id)
        if session is None:
            return
        async with session.lock:
            for part_id in [
                part_id
                for part_id, entry in session.parts.items()
                if entry.message_id == message_id
            ]:
                entry = session.parts.pop(part_id)
                await self._publish_streamed_part(
                    platform_id, native_id, session, entry, streaming=False
                )

    async def _publish_streamed_part(
        self,
        platform_id: str,
        native_id: str,
        session: _StreamSession,
        entry: _StreamedPart,
        *,
        streaming: bool,
    ) -> None:
        turn_id = session.parents.get(entry.message_id) or entry.message_id or None
        item = timeline.map_streaming_part(
            native_id,
            entry.part,
            text=entry.text,
            turn_id=turn_id,
            revision=entry.revision,
            streaming=streaming,
        )
        if item is None:
            # Nothing mappable yet (opencode announces a text part with empty
            # text). The revision only advances for items the client can see,
            # so the platform does not see a gap it cannot match.
            return
        part_key = entry.part.get("id") or ""
        platform_item = item.to_platform_item(platform_id, entry.order_seq)
        fingerprint = (
            platform_item.content_hash,
            platform_item.order_seq,
            platform_item.status,
        )
        previous = session.fingerprints.get(part_key)
        if previous == fingerprint:
            # Nothing the client can render changed. opencode restates the same
            # part repeatedly (a tool's state while it runs, the final part after
            # ``session.idle``), and each upsert costs one Server ingest.
            logger.debug(
                "opencode part push skipped (unchanged): item={} status={}",
                item.id,
                platform_item.status,
            )
            return
        session.fingerprints[part_key] = fingerprint
        session.published[part_key] = entry.text
        entry.revision += 1
        if previous is None or previous[2] != platform_item.status:
            # A status change is what the client renders (spinner on, spinner
            # off, tool failed), so it is worth an INFO line; the text updates in
            # between stay at DEBUG to keep a long turn readable.
            logger.info(
                "opencode item {} id={} status={}->{} orderSeq={} revision={}{}",
                platform_item.type,
                platform_item.id,
                previous[2] if previous else "new",
                platform_item.status,
                platform_item.order_seq,
                platform_item.revision,
                _elapsed_suffix(entry.part),
            )
        try:
            await self.host.timeline_item_upsert(platform_item)
        except Exception as exc:  # noqa: BLE001 - a lost update must be visible
            logger.warning(
                "opencode streamed item push failed: item={} revision={} error={}",
                item.id,
                entry.revision,
                exc,
            )

    async def _flush_stream(
        self,
        platform_id: str,
        native_id: str,
        session: _StreamSession,
        *,
        force: bool = False,
    ) -> None:
        now = asyncio.get_running_loop().time()
        # Held across the awaits so the watchdog's turn-end finalization cannot
        # publish a part as ``done`` while this loop still has it queued as
        # ``running`` (the Server keeps the last write).
        async with session.lock:
            for entry in list(session.parts.values()):
                if not entry.dirty:
                    continue
                if not force and now - entry.flushed_at < STREAM_FLUSH_INTERVAL_S:
                    continue
                entry.dirty = False
                entry.flushed_at = now
                await self._publish_streamed_part(
                    platform_id, native_id, session, entry, streaming=True
                )

    async def _finish_streaming_parts(self, platform_id: str, native_id: str) -> None:
        """Publish the final state of every streamed part before the snapshot.

        The turn-end snapshot rebuilds from ``GET /session/{id}/message`` and
        reuses the same item ids, so this only has to make the last live state
        visible (``done`` instead of ``running``) and drop the buffers.

        The session object itself is kept: its ``next_order_seq`` must survive
        into the next turn. opencode also emits the final assistant message and
        its parts *after* ``session.idle``, so those late parts arrive with no
        active turn and are published straight through as ``done`` (see
        ``_handle_part_update``).
        """

        session = self._stream_sessions.get(native_id)
        if session is None:
            return
        async with session.lock:
            for entry in list(session.parts.values()):
                await self._publish_streamed_part(
                    platform_id, native_id, session, entry, streaming=False
                )
            session.parts.clear()
            session.user_parts.clear()
        _trim_stream_state(session)

    async def _handle_permission_asked(
        self, platform_id: str, native_id: str, props: dict[str, Any]
    ) -> None:
        """Surface a permission request as an approval notice.

        Both V1 (``permission.asked``) and V2 (``permission.v2.asked``) carry
        the same fields under ``properties``; V1 names the action
        ``permission`` while V2 calls it ``action``.
        """

        permission_id = str(props.get("id") or "")
        if not permission_id:
            return
        action = props.get("permission") or props.get("action") or "tool"
        patterns = props.get("patterns") or props.get("resources") or []
        if isinstance(patterns, list):
            detail = ", ".join(str(p) for p in patterns[:5])
        else:
            detail = str(patterns)
        notice_id = f"notice_opencode_perm_{permission_id}"
        notice = SessionNotice(
            notice_id=notice_id,
            session_id=platform_id,
            runtime="opencode",
            type="interaction",
            title=f"OpenCode 请求权限: {action}",
            message=detail or None,
            severity="warning",
            interaction_type="approval",
            blocking={"scope": "session", "targetId": platform_id},
            response_required=True,
            source={"permissionId": permission_id},
            context={
                "permissionId": permission_id,
                "externalSessionId": native_id,
                "action": action,
                "patterns": patterns,
            },
            actions=(
                {"actionId": "approve", "label": "允许本次", "style": "primary"},
                {"actionId": "approve_for_session", "label": "始终允许", "style": "secondary"},
                {"actionId": "reject", "label": "拒绝", "style": "danger"},
            ),
            metadata={"source": "opencode.permission"},
        )
        # Record only after the Server accepted the notice: a notice stored
        # before a failed upload would be deduped by the poll forever and the
        # approval card would never appear.
        try:
            await self.host.notice_upsert(notice)
        except Exception as error:  # noqa: BLE001 - the next poll tick re-raises it
            logger.warning(
                "opencode permission notice upload failed: platform={} native={} perm={} error_type={}",
                platform_id,
                native_id,
                permission_id,
                type(error).__name__,
            )
            return
        self._notices.setdefault(platform_id, {})[notice_id] = notice
        logger.info(
            "opencode permission asked: platform={} native={} perm={} action={}",
            platform_id,
            native_id,
            permission_id,
            action,
        )
        with suppress(Exception):
            await self.host.session_state_update(
                platform_id,
                "opencode",
                status="waiting_approval",
                external_session_id=native_id,
            )

    async def _handle_permission_replied(
        self, platform_id: str, native_id: str, props: dict[str, Any]
    ) -> None:
        permission_id = str(props.get("id") or "")
        if not permission_id:
            return
        notice_id = f"notice_opencode_perm_{permission_id}"
        notices = self._notices.get(platform_id, {})
        notice = notices.pop(notice_id, None)
        if notice is None:
            return
        logger.info(
            "opencode permission replied: platform={} native={} perm={}",
            platform_id,
            native_id,
            permission_id,
        )
        with suppress(Exception):
            await self.host.notice_upsert(
                SessionNotice(
                    notice_id=notice.notice_id,
                    session_id=platform_id,
                    runtime="opencode",
                    type=notice.type,
                    title=notice.title,
                    message=notice.message,
                    severity=notice.severity,
                    status="resolved",
                    interaction_type=notice.interaction_type,
                )
            )

    async def _handle_question_asked(
        self, platform_id: str, native_id: str, props: dict[str, Any]
    ) -> None:
        """Surface a question the model asked mid-turn as a blocking notice.

        opencode questions carry selectable options. Publish them as the
        platform's input-request form so every option is a real selection
        instead of a single free-text reply button; the form field keys are
        also what opencode expects back in ``{answer: {fieldKey: value}}``.
        """

        question_id = str(props.get("id") or "")
        if not question_id:
            return
        questions = _normalise_questions(props.get("questions") or ())
        if not questions and isinstance(props.get("fields"), (list, tuple)):
            questions = _form_to_question_props(props)["questions"]
        text = str(props.get("question") or "").strip()
        form, field_types = _input_request_form(questions)
        options: list[str] = []
        for question in questions:
            options.extend(
                label for _value, label in question.get("options") or ()
            )
        if form is not None:
            actions: tuple[Mapping[str, Any], ...] = (
                form.action(action_id="submit", label="Submit"),
                {"actionId": "cancel", "label": "Cancel", "style": "secondary"},
            )
            prompts = {str(question.get("question") or "") for question in questions}
            # The form already renders every prompt; only keep a body when the
            # event carried a form title that is not one of those prompts.
            message = text if text and text not in prompts else None
        else:
            body = text
            if options:
                body = f"{text}\n可选回复: {' / '.join(options)}"
            message = body.strip() or None
            actions = (
                {"actionId": "reply", "label": "回复", "style": "primary"},
            )
        notice_id = f"notice_opencode_que_{question_id}"
        notice = SessionNotice(
            notice_id=notice_id,
            session_id=platform_id,
            runtime="opencode",
            type="interaction",
            title="OpenCode 向你提问",
            message=message,
            severity="info",
            # The Server only accepts the shared interaction kinds; "question"
            # would be rejected and the card would never reach the client.
            interaction_type="input_request",
            blocking={"scope": "session", "targetId": platform_id},
            response_required=True,
            source={"questionId": question_id},
            context={
                "questionId": question_id,
                "externalSessionId": native_id,
                "options": options,
                "fieldTypes": field_types,
            },
            actions=actions,
            metadata={"source": "opencode.question"},
        )
        # Record only after the Server accepted the notice: a notice stored
        # before a failed upload would be deduped by the poll forever and the
        # question card would never appear.
        try:
            await self.host.notice_upsert(notice)
        except Exception as error:  # noqa: BLE001 - the next poll tick re-raises it
            logger.warning(
                "opencode question notice upload failed: platform={} native={} que={} error_type={}",
                platform_id,
                native_id,
                question_id,
                type(error).__name__,
            )
            return
        self._notices.setdefault(platform_id, {})[notice_id] = notice
        logger.info(
            "opencode question asked: platform={} native={} que={}",
            platform_id,
            native_id,
            question_id,
        )
        # A question blocks the turn just like a permission request, so the
        # platform session must leave "running" or the client keeps waiting on a
        # turn that is actually waiting on the user.
        with suppress(Exception):
            await self.host.session_state_update(
                platform_id,
                "opencode",
                status="waiting_approval",
                external_session_id=native_id,
            )

    async def _handle_question_closed(
        self, platform_id: str, props: dict[str, Any]
    ) -> None:
        """Resolve a question notice opencode closed itself (answered/rejected).

        The turn can end (or the question be dismissed) without the platform
        ever answering; without this the approval card stays on screen forever.
        """

        question_id = str(props.get("id") or "")
        if not question_id:
            return
        notices = self._notices.get(platform_id, {})
        notice = notices.pop(f"notice_opencode_que_{question_id}", None)
        if notice is None:
            return
        logger.info(
            "opencode question closed: platform={} que={}", platform_id, question_id
        )
        with suppress(Exception):
            await self.host.notice_upsert(
                SessionNotice(
                    notice_id=notice.notice_id,
                    session_id=platform_id,
                    runtime="opencode",
                    type=notice.type,
                    title=notice.title,
                    message=notice.message,
                    severity=notice.severity,
                    status="resolved",
                    interaction_type=notice.interaction_type,
                )
            )

    async def _handle_session_error(
        self, platform_id: str, native_id: str, props: dict[str, Any]
    ) -> None:
        error = props.get("error") or {}
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else str(error)
        logger.warning(
            "opencode session.error: platform={} native={} code={} message={}",
            platform_id,
            native_id,
            code,
            message,
        )
        with suppress(Exception):
            await self.host.session_state_update(
                platform_id,
                "opencode",
                status="error",
                external_session_id=native_id,
                error={"code": code, "message": message} if code or message else None,
            )
        # A session error normally ends the turn; reconcile so the platform
        # session does not stay "running".
        if native_id in self._active_turns:
            self._recently_ended[native_id] = "error"
            await self._finish_turn(native_id)
