"""Map Codex `request_user_input` requests onto the platform input request form.

The Codex app-server asks the client for user input with a server -> client
request (`item/tool/requestUserInput`). The wire shape is defined by
`ToolRequestUserInputParams` / `ToolRequestUserInputResponse` in the app-server
protocol:

    params   {"threadId", "turnId", "itemId", "questions": [...], "isBlocking"}
    question {"id", "header", "question", "options"?, "isOther", "isSecret"}
    option   {"label", "description"}
    response {"answers": {<question id>: {"answers": [<label or free text>, ...]}}}

Codex options carry no ids, so the platform form uses positional option ids and
keeps a label mapping to build the response payload.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    InputRequestForm,
    InputRequestOption,
    InputRequestQuestion,
    RuntimeUnsupportedError,
    SessionNotice,
)

CODEX_REQUEST_USER_INPUT = "item/tool/requestUserInput"
CODEX_REQUEST_USER_INPUT_ASYNC = "request_user_input_async"

CODEX_INPUT_REQUEST_METHODS = {CODEX_REQUEST_USER_INPUT}

ASYNC_REPLY_PATTERN = re.compile(
    r"\A\s*<send_user_message_question_reply>\s*(?P<payload>.*?)"
    r"\s*</send_user_message_question_reply>\s*\Z",
    re.DOTALL,
)


def is_user_input_request(method: object) -> bool:
    return isinstance(method, str) and method in CODEX_INPUT_REQUEST_METHODS


@dataclass(frozen=True, slots=True)
class CodexInputRequest:
    form: InputRequestForm
    params: Mapping[str, Any]
    option_label_by_id: Mapping[str, Mapping[str, str]]

    def response_payload(
        self,
        input_data: Mapping[str, Any] | None,
    ) -> Mapping[str, Any]:
        """Build the `ToolRequestUserInputResponse` payload for submitted answers."""

        parsed_answers = self.form.parse_answers(input_data)
        answers: dict[str, Mapping[str, list[str]]] = {}
        for question in self.form.questions:
            parsed = parsed_answers[question.question_id]
            option_labels = self.option_label_by_id[question.question_id]
            values = [option_labels[option_id] for option_id in parsed.option_ids]
            if parsed.custom_text:
                values.append(parsed.custom_text)
            answers[question.question_id] = {"answers": values}
        return {"answers": answers}


@dataclass(frozen=True, slots=True)
class CodexAsyncInputCall:
    call_id: str
    request: CodexInputRequest

    @property
    def notice_id(self) -> str:
        return async_input_notice_id(self.call_id)

    @property
    def client_message_id(self) -> str:
        return async_input_client_message_id(self.call_id)

    def reply_envelope(self, input_data: Mapping[str, Any] | None) -> str:
        parsed_answers = self.request.form.parse_answers(input_data)
        answers: list[dict[str, str]] = []
        for question in self.request.form.questions:
            parsed = parsed_answers[question.question_id]
            option_labels = self.request.option_label_by_id[question.question_id]
            answer = parsed.custom_text or next(
                (
                    option_labels[option_id]
                    for option_id in parsed.option_ids
                    if option_id in option_labels
                ),
                "",
            )
            answers.append(
                {
                    "questionItemId": question.question_id,
                    "question": question.prompt,
                    "answer": answer,
                }
            )
        payload = json.dumps(answers, ensure_ascii=False, separators=(",", ":"))
        return (
            "<send_user_message_question_reply>\n"
            f"{payload}\n"
            "</send_user_message_question_reply>\n"
        )


@dataclass(frozen=True, slots=True)
class CodexAsyncInputReply:
    call_ids: tuple[str, ...]
    readable_text: str


def async_input_notice_id(call_id: str) -> str:
    digest = hashlib.sha256(call_id.encode("utf-8")).hexdigest()[:32]
    return f"notice_codex_async_input_{digest}"


def async_input_client_message_id(call_id: str) -> str:
    digest = hashlib.sha256(call_id.encode("utf-8")).hexdigest()[:32]
    return f"codex_async_input_{digest}"


def async_input_timeline_item_id(call_id: str) -> str:
    digest = hashlib.sha256(call_id.encode("utf-8")).hexdigest()[:32]
    return f"codex_async_input_item_{digest}"


def codex_input_request(params: Mapping[str, Any]) -> CodexInputRequest:
    raw_questions = params.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        raise ValueError("request_user_input requires a non-empty questions array")

    questions: list[InputRequestQuestion] = []
    option_label_by_id: dict[str, Mapping[str, str]] = {}
    seen_question_ids: set[str] = set()
    for raw_question in raw_questions:
        if not isinstance(raw_question, Mapping):
            raise TypeError("request_user_input question must be an object")
        is_secret = raw_question.get("isSecret", False)
        if not isinstance(is_secret, bool):
            raise TypeError("request_user_input isSecret must be a boolean")
        if is_secret:
            # Platform forms do not provide private input or private answer storage.
            raise RuntimeUnsupportedError("request_user_input secret questions")
        question_id = _required_text(raw_question.get("id"), "question id")
        if question_id in seen_question_ids:
            raise ValueError("request_user_input question ids must be unique")
        seen_question_ids.add(question_id)
        prompt = _required_text(raw_question.get("question"), "question")
        is_other = raw_question.get("isOther", False)
        if not isinstance(is_other, bool):
            raise TypeError("request_user_input isOther must be a boolean")
        raw_options = raw_question.get("options")
        if raw_options is None:
            raw_options = []
        if not isinstance(raw_options, list):
            raise TypeError("request_user_input options must be an array")

        options: list[InputRequestOption] = []
        option_labels: dict[str, str] = {}
        for option_index, raw_option in enumerate(raw_options):
            if not isinstance(raw_option, Mapping):
                raise TypeError("request_user_input option must be an object")
            option_id = f"o_{option_index}"
            options.append(
                InputRequestOption(
                    option_id=option_id,
                    label=_required_text(raw_option.get("label"), "option label"),
                    description=_optional_text(raw_option.get("description")),
                )
            )
            option_labels[option_id] = str(raw_option.get("label"))
        questions.append(
            InputRequestQuestion(
                question_id=question_id,
                header=_optional_text(raw_question.get("header")),
                prompt=prompt,
                options=tuple(options),
                multiple=False,
                # Codex only offers free text when the question opts into "Other",
                # and a question without options can only be answered in free text.
                allow_custom=is_other or not options,
            )
        )
        option_label_by_id[question_id] = option_labels

    return CodexInputRequest(
        form=InputRequestForm(questions=tuple(questions)),
        params=deepcopy(dict(params)),
        option_label_by_id=option_label_by_id,
    )


def codex_async_input_call(raw: Mapping[str, Any]) -> CodexAsyncInputCall | None:
    if (
        raw.get("type") != "function_call"
        or raw.get("name") != CODEX_REQUEST_USER_INPUT_ASYNC
    ):
        return None
    call_id = _optional_text(raw.get("call_id")) or _optional_text(raw.get("callId"))
    if call_id is None:
        return None
    arguments = raw.get("arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return None
    if not isinstance(arguments, Mapping):
        return None
    raw_questions = arguments.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        return None
    questions: list[dict[str, Any]] = []
    for index, raw_question in enumerate(raw_questions):
        if not isinstance(raw_question, Mapping):
            return None
        title = _optional_text(raw_question.get("title"))
        if title is None:
            return None
        raw_options = raw_question.get("options")
        if raw_options is None:
            raw_options = []
        if not isinstance(raw_options, list) or not all(
            isinstance(option, str) and option for option in raw_options
        ):
            return None
        question_id = json.dumps(
            [CODEX_REQUEST_USER_INPUT_ASYNC, call_id, index],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        questions.append(
            {
                "id": question_id,
                "question": title,
                "options": [
                    {"label": option, "description": None} for option in raw_options
                ],
                "isOther": True,
                "isSecret": False,
            }
        )
    try:
        request = codex_input_request({"questions": questions})
    except (ValueError, TypeError):
        return None
    return CodexAsyncInputCall(call_id=call_id, request=request)


def parse_async_input_reply(text: str) -> CodexAsyncInputReply | None:
    match = ASYNC_REPLY_PATTERN.fullmatch(text)
    if match is None:
        return None
    try:
        payload = json.loads(match.group("payload"))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, list) or not payload:
        return None
    call_ids: list[str] = []
    readable: list[str] = []
    seen_question_ids: set[str] = set()
    for entry in payload:
        if not isinstance(entry, Mapping):
            return None
        question_item_id = entry.get("questionItemId")
        question = entry.get("question")
        answer = entry.get("answer")
        if not all(
            isinstance(value, str) for value in (question_item_id, question, answer)
        ):
            return None
        if (
            not question.strip()
            or not answer.strip()
            or question_item_id in seen_question_ids
        ):
            return None
        seen_question_ids.add(question_item_id)
        try:
            identity = json.loads(question_item_id)
        except json.JSONDecodeError:
            return None
        if (
            not isinstance(identity, list)
            or len(identity) != 3
            or identity[0] != CODEX_REQUEST_USER_INPUT_ASYNC
            or not isinstance(identity[1], str)
            or not identity[1]
            or type(identity[2]) is not int
            or identity[2] < 0
        ):
            return None
        call_ids.append(identity[1])
        readable.append(f"{question}\n\n> {answer}")
    return CodexAsyncInputReply(
        call_ids=tuple(dict.fromkeys(call_ids)),
        readable_text="\n\n".join(readable),
    )


def user_input_notice(
    *,
    session_id: str,
    thread_id: str,
    turn_id: str | None,
    item_id: str | None,
    request_id: str,
    request: CodexInputRequest,
    is_blocking: bool,
) -> SessionNotice:
    return SessionNotice(
        notice_id=f"notice_codex_input_{request_id}",
        session_id=session_id,
        runtime="codex",
        type="interaction",
        title="Codex needs your input",
        severity="info",
        status="open",
        interaction_type="input_request",
        blocking={"scope": "session", "targetId": session_id} if is_blocking else None,
        response_required=True,
        actions=(
            request.form.action(),
            {"actionId": "cancel", "label": "Cancel", "style": "secondary"},
        ),
        source={
            "component": "codex.request_user_input",
            "threadId": thread_id,
            **({"timelineItemId": item_id} if item_id else {}),
        },
        context={
            "inputStatus": "pending",
            "requestKind": "questionnaire",
            "method": CODEX_REQUEST_USER_INPUT,
            "requestId": request_id,
            "isBlocking": is_blocking,
            "toolName": "request_user_input",
            "threadId": thread_id,
            "requestParams": deepcopy(dict(request.params)),
            **({"turnId": turn_id} if turn_id else {}),
            **({"itemId": item_id} if item_id else {}),
        },
        metadata={"source": CODEX_REQUEST_USER_INPUT},
    )


def async_user_input_notice(
    *,
    session_id: str,
    thread_id: str,
    turn_id: str | None,
    item_id: str | None,
    call: CodexAsyncInputCall,
    resolved: bool,
) -> SessionNotice:
    status = "resolved" if resolved else "open"
    return SessionNotice(
        notice_id=call.notice_id,
        session_id=session_id,
        runtime="codex",
        type="interaction",
        title="Codex needs your input",
        severity="info",
        status=status,
        interaction_type="input_request",
        blocking=None,
        response_required=not resolved,
        actions=(
            ()
            if resolved
            else (
                call.request.form.action(),
                {"actionId": "cancel", "label": "Cancel", "style": "secondary"},
            )
        ),
        source={
            "component": "codex.request_user_input_async",
            "threadId": thread_id,
            **({"timelineItemId": item_id} if item_id else {}),
        },
        context={
            "inputStatus": status if resolved else "pending",
            "requestKind": "questionnaire",
            "method": CODEX_REQUEST_USER_INPUT_ASYNC,
            "requestId": call.call_id,
            "callId": call.call_id,
            "isBlocking": False,
            "toolName": CODEX_REQUEST_USER_INPUT_ASYNC,
            "threadId": thread_id,
            "requestParams": deepcopy(dict(call.request.params)),
            **({"turnId": turn_id} if turn_id else {}),
            **({"itemId": item_id} if item_id else {}),
        },
        metadata={"source": CODEX_REQUEST_USER_INPUT_ASYNC},
    )


INPUT_REQUEST_CANCEL_ACTIONS = {"cancel", "cancelled", "reject", "declined"}


def is_cancelled_input_action(action_or_status: str) -> bool:
    return action_or_status in INPUT_REQUEST_CANCEL_ACTIONS


def user_input_response_from_interaction(
    action_or_status: str,
    context: Mapping[str, Any],
) -> Mapping[str, Any]:
    """Build the app-server response payload for a submitted questionnaire."""

    if is_cancelled_input_action(action_or_status):
        return {"answers": {}}
    raw_params = context.get("requestParams")
    if not isinstance(raw_params, Mapping):
        raise TypeError("request_user_input params are required to answer")
    request = codex_input_request(raw_params)
    return request.response_payload({"answers": context.get("answers")})


def is_input_request_context(context: Mapping[str, Any]) -> bool:
    return context.get("requestKind") == "questionnaire" and context.get("method") in {
        CODEX_REQUEST_USER_INPUT,
        CODEX_REQUEST_USER_INPUT_ASYNC,
    }


def is_async_input_request_context(context: Mapping[str, Any]) -> bool:
    return (
        context.get("requestKind") == "questionnaire"
        and context.get("method") == CODEX_REQUEST_USER_INPUT_ASYNC
    )


def async_input_call_from_context(context: Mapping[str, Any]) -> CodexAsyncInputCall:
    call_id = _required_text(context.get("callId"), "call id")
    raw_params = context.get("requestParams")
    if not isinstance(raw_params, Mapping):
        raise TypeError("request_user_input_async params are required to answer")
    return CodexAsyncInputCall(
        call_id=call_id,
        request=codex_input_request(raw_params),
    )


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"request_user_input {field_name} is required")
    return value


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
