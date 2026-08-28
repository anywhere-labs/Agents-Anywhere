from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    InputRequestForm,
    InputRequestOption,
    InputRequestQuestion,
    SessionNotice,
)


@dataclass(frozen=True, slots=True)
class ClaudeInputRequest:
    form: InputRequestForm
    original_input: Mapping[str, Any]
    question_text_by_id: Mapping[str, str]
    option_label_by_id: Mapping[str, Mapping[str, str]]

    def updated_input(self, input_data: Mapping[str, Any] | None) -> Mapping[str, Any]:
        parsed_answers = self.form.parse_answers(input_data)
        answers: dict[str, str | list[str]] = {}
        for question in self.form.questions:
            parsed = parsed_answers[question.question_id]
            option_labels = self.option_label_by_id[question.question_id]
            values = [option_labels[option_id] for option_id in parsed.option_ids]
            if parsed.custom_text:
                values.append(parsed.custom_text)
            question_text = self.question_text_by_id[question.question_id]
            answers[question_text] = values if question.multiple else values[0]
        return {
            **deepcopy(dict(self.original_input)),
            "questions": deepcopy(self.original_input["questions"]),
            "answers": answers,
        }


def claude_input_request(tool_input: Mapping[str, Any]) -> ClaudeInputRequest:
    raw_questions = tool_input.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        raise ValueError("AskUserQuestion requires a non-empty questions array")

    questions: list[InputRequestQuestion] = []
    question_text_by_id: dict[str, str] = {}
    option_label_by_id: dict[str, Mapping[str, str]] = {}
    seen_question_texts: set[str] = set()
    for question_index, raw_question in enumerate(raw_questions):
        if not isinstance(raw_question, Mapping):
            raise ValueError("AskUserQuestion question must be an object")
        question_text = _required_text(raw_question.get("question"), "question")
        if question_text in seen_question_texts:
            raise ValueError("AskUserQuestion question text must be unique")
        seen_question_texts.add(question_text)
        header = _optional_text(raw_question.get("header"))
        multi_select = raw_question.get("multiSelect", False)
        if not isinstance(multi_select, bool):
            raise ValueError("AskUserQuestion multiSelect must be a boolean")
        raw_options = raw_question.get("options")
        if not isinstance(raw_options, list):
            raise ValueError("AskUserQuestion options must be an array")

        question_id = f"q_{question_index}"
        options: list[InputRequestOption] = []
        option_labels: dict[str, str] = {}
        for option_index, raw_option in enumerate(raw_options):
            if not isinstance(raw_option, Mapping):
                raise ValueError("AskUserQuestion option must be an object")
            option_id = f"o_{option_index}"
            label = _required_text(raw_option.get("label"), "option label")
            options.append(
                InputRequestOption(
                    option_id=option_id,
                    label=label,
                    description=_optional_text(raw_option.get("description")),
                )
            )
            option_labels[option_id] = label
        questions.append(
            InputRequestQuestion(
                question_id=question_id,
                header=header,
                prompt=question_text,
                options=tuple(options),
                multiple=multi_select,
                allow_custom=True,
            )
        )
        question_text_by_id[question_id] = question_text
        option_label_by_id[question_id] = option_labels

    return ClaudeInputRequest(
        form=InputRequestForm(questions=tuple(questions)),
        original_input=deepcopy(dict(tool_input)),
        question_text_by_id=question_text_by_id,
        option_label_by_id=option_label_by_id,
    )


def input_request_notice(
    *,
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    request_id: str,
    request: ClaudeInputRequest,
    tool_use_id: str | None,
    timeline_item_id: str | None,
) -> SessionNotice:
    return SessionNotice(
        notice_id=f"notice_claude_input_{request_id}",
        session_id=session_id,
        runtime="claude",
        type="interaction",
        title="Claude needs your input",
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
            "component": "claude.ask_user_question",
            **({"timelineItemId": timeline_item_id} if timeline_item_id else {}),
        },
        context={
            "inputStatus": "pending",
            "requestKind": "questionnaire",
            "turnId": turn_id,
            "toolName": "AskUserQuestion",
            "toolInput": deepcopy(dict(request.original_input)),
            **({"toolUseId": tool_use_id} if tool_use_id else {}),
            **({"sessionId": external_session_id} if external_session_id else {}),
        },
        metadata={"source": "claude.ask_user_question"},
    )


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"AskUserQuestion {field_name} is required")
    return value


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
