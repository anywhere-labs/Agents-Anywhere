from dataclasses import asdict

from ..domain.definitions import fingerprint
from ..domain.operations import PromptOperation, require_same_input


class PromptService:
    def __init__(self, store):
        self.store = store

    def prepare(
        self, session_id: str, message_id: str, text: str, blocks=None
    ) -> tuple[PromptOperation, bool]:
        digest = prompt_digest(session_id, text, blocks)
        key = fingerprint([session_id, message_id])
        previous = self.store.get("prompt", key)
        if previous:
            require_same_input(previous["input_digest"], digest)
            return PromptOperation(**previous), False
        operation = PromptOperation(message_id, session_id, digest).dispatch()
        self.store.put("prompt", key, asdict(operation))
        return operation, True

    def save(self, operation: PromptOperation):
        self.store.put(
            "prompt",
            fingerprint([operation.session_id, operation.operation_id]),
            asdict(operation),
        )

    def restore(self):
        for row in self.store.values("prompt"):
            value = PromptOperation(**row)
            self.save(value.lose_connection())


def prompt_digest(session_id: str, text: str, blocks=None):
    value = {"sessionId": session_id, "text": text}
    if blocks:
        value["blocks"] = blocks
    return fingerprint(value)
