from __future__ import annotations

import pytest

from connector.server.runtime_rpc_params import runtime_attachments


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
