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

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    InputRequestForm,
    InputRequestOption,
    InputRequestQuestion,
    SessionNotice,
)

CODEX_REQUEST_USER_INPUT = "item/tool/requestUserInput"

CODEX_INPUT_REQUEST_METHODS = {CODEX_REQUEST_USER_INPUT}


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
        blocking={"scope": "session", "targetId": session_id},
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
            "requestParams": deepcopy(dict(request.params)),
            **({"turnId": turn_id} if turn_id else {}),
            **({"itemId": item_id} if item_id else {}),
            **_secret_question_context(request),
        },
        metadata={"source": CODEX_REQUEST_USER_INPUT},
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
    return (
        context.get("requestKind") == "questionnaire"
        and context.get("method") == CODEX_REQUEST_USER_INPUT
    )


def _secret_question_context(request: CodexInputRequest) -> Mapping[str, Any]:
    secret_ids = [
        str(question.get("id"))
        for question in request.params.get("questions", [])
        if isinstance(question, Mapping) and question.get("isSecret") is True
    ]
    return {"secretQuestionIds": secret_ids} if secret_ids else {}


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"request_user_input {field_name} is required")
    return value


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
