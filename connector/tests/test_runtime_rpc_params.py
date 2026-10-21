from __future__ import annotations

import pytest

from connector.server.runtime_rpc_params import (
    CommandExecuteParams,
    runtime_attachments,
)


@pytest.mark.parametrize("raw", ["", " /goal hello  world\nsecond line "])
def test_command_rpc_preserves_exact_raw(raw: str) -> None:
    parsed = CommandExecuteParams.parse(
        {"sessionId": "s", "command": "goal", "raw": raw}
    )
    assert parsed.raw == raw


@pytest.mark.parametrize(
    "field,value",
    [("raw", 0), ("raw", []), ("args", ""), ("args", 0), ("args", {}), ("args", [1])],
)
def test_command_rpc_rejects_malformed_input(field: str, value: object) -> None:
    with pytest.raises(TypeError):
        CommandExecuteParams.parse({"sessionId": "s", "command": "goal", field: value})


def test_runtime_attachments_rejects_base64_content() -> None:
    with pytest.raises(ValueError, match="not sent as base64"):
        runtime_attachments(
            {
                "attachments": [
                    {
                        "fileId": "file_1",
                        "name": "note.txt",
                        "mediaType": "text/plain",
                        "contentBase64": "aGVsbG8=",
                    }
                ]
            }
        )


def test_runtime_attachments_accepts_file_reference() -> None:
    attachments = runtime_attachments(
        {
            "attachments": [
                {
                    "fileId": "file_1",
                    "name": "note.txt",
                    "mediaType": "text/plain",
                    "size": 5,
                    "sha256": "abc",
                }
            ]
        }
    )

    assert len(attachments) == 1
    assert attachments[0].file_id == "file_1"
    assert attachments[0].name == "note.txt"
    assert attachments[0].media_type == "text/plain"
    assert attachments[0].size == 5
    assert attachments[0].sha256 == "abc"
