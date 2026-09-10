from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


class InputRequestValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class InputRequestOption:
    option_id: str
    label: str
    description: str | None = None

    def to_mapping(self) -> Mapping[str, Any]:
        return {
            "id": self.option_id,
            "label": self.label,
            **({"description": self.description} if self.description else {}),
        }


@dataclass(frozen=True, slots=True)
class InputRequestQuestion:
    question_id: str
    prompt: str
    options: tuple[InputRequestOption, ...]
    header: str | None = None
    multiple: bool = False
    allow_custom: bool = True

    def to_mapping(self) -> Mapping[str, Any]:
        return {
            "id": self.question_id,
            "prompt": self.prompt,
            "multiple": self.multiple,
            "allowCustom": self.allow_custom,
            "options": [option.to_mapping() for option in self.options],
            **({"header": self.header} if self.header else {}),
        }


@dataclass(frozen=True, slots=True)
class InputRequestAnswer:
    option_ids: tuple[str, ...]
    custom_text: str | None = None


@dataclass(frozen=True, slots=True)
class InputRequestForm:
    questions: tuple[InputRequestQuestion, ...]

    def __post_init__(self) -> None:
        if not self.questions:
            raise InputRequestValidationError("input request must contain questions")
        question_ids = [question.question_id for question in self.questions]
        if len(question_ids) != len(set(question_ids)):
            raise InputRequestValidationError(
                "input request question ids must be unique"
            )
        for question in self.questions:
            if not question.prompt:
                raise InputRequestValidationError("input request prompt is required")
            option_ids = [option.option_id for option in question.options]
            if len(option_ids) != len(set(option_ids)):
                raise InputRequestValidationError(
                    f"input request option ids must be unique for {question.question_id}"
                )

    def action(
        self,
        *,
        action_id: str = "submit",
        label: str = "Submit",
        style: str = "primary",
    ) -> Mapping[str, Any]:
        answer_properties: dict[str, Any] = {}
        for question in self.questions:
            option_ids = [option.option_id for option in question.options]
            option_ids_schema: dict[str, Any] = {
                "type": "array",
                "uniqueItems": True,
                "items": {"type": "string", "enum": option_ids},
            }
            if not question.multiple:
                option_ids_schema["maxItems"] = 1
            answer_properties[question.question_id] = {
                "type": "object",
                "properties": {
                    "optionIds": option_ids_schema,
                    "customText": {"type": "string"},
                },
                "additionalProperties": False,
            }
        return {
            "actionId": action_id,
            "label": label,
            "style": style,
            "input": {
                "required": True,
                "schema": {
                    "type": "object",
                    "required": ["answers"],
                    "properties": {
                        "answers": {
                            "type": "object",
                            "required": [
                                question.question_id for question in self.questions
                            ],
                            "properties": answer_properties,
                            "additionalProperties": False,
                        }
                    },
                    "additionalProperties": False,
                },
                "uiSchema": {
                    "component": "inputRequest",
                    "version": 1,
                    "questions": [question.to_mapping() for question in self.questions],
                },
            },
        }

    def parse_answers(
        self,
        input_data: Mapping[str, Any] | None,
    ) -> Mapping[str, InputRequestAnswer]:
        raw_answers = input_data.get("answers") if input_data is not None else None
        if not isinstance(raw_answers, Mapping):
            raise InputRequestValidationError("input request answers are required")

        known_question_ids = {question.question_id for question in self.questions}
        unknown_question_ids = set(raw_answers) - known_question_ids
        if unknown_question_ids:
            raise InputRequestValidationError(
                "input request contains unknown questions"
            )

        answers: dict[str, InputRequestAnswer] = {}
        for question in self.questions:
            raw_answer = raw_answers.get(question.question_id)
            if not isinstance(raw_answer, Mapping):
                raise InputRequestValidationError(
                    f"answer is required for {question.question_id}"
                )
            raw_option_ids = raw_answer.get("optionIds", [])
            if not isinstance(raw_option_ids, list) or not all(
                isinstance(option_id, str) for option_id in raw_option_ids
            ):
                raise InputRequestValidationError(
                    f"optionIds must be an array for {question.question_id}"
                )
            option_ids = tuple(raw_option_ids)
            if len(option_ids) != len(set(option_ids)):
                raise InputRequestValidationError(
                    f"duplicate options for {question.question_id}"
                )
            known_option_ids = {option.option_id for option in question.options}
            if any(option_id not in known_option_ids for option_id in option_ids):
                raise InputRequestValidationError(
                    f"unknown option for {question.question_id}"
                )
            raw_custom_text = raw_answer.get("customText")
            if raw_custom_text is not None and not isinstance(raw_custom_text, str):
                raise InputRequestValidationError(
                    f"customText must be a string for {question.question_id}"
                )
            custom_text = raw_custom_text.strip() if raw_custom_text else None
            if custom_text and not question.allow_custom:
                raise InputRequestValidationError(
                    f"custom answer is not allowed for {question.question_id}"
                )
            if not question.multiple and len(option_ids) > 1:
                raise InputRequestValidationError(
                    f"multiple options are not allowed for {question.question_id}"
                )
            if not question.multiple and option_ids and custom_text:
                raise InputRequestValidationError(
                    f"choose an option or custom text for {question.question_id}"
                )
            if not option_ids and not custom_text:
                raise InputRequestValidationError(
                    f"answer is required for {question.question_id}"
                )
            answers[question.question_id] = InputRequestAnswer(
                option_ids=option_ids,
                custom_text=custom_text,
            )
        return answers
