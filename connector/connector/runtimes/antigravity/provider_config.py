from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_SESSION_SEND_MESSAGE,
    RuntimeCapability,
    RuntimeCapabilitySet,
)

DEFAULT_GEMINI_DIR = Path.home() / ".gemini"
DEFAULT_ANTIGRAVITY_DIR = DEFAULT_GEMINI_DIR / "antigravity"
DEFAULT_AGENTAPI_PATH = DEFAULT_ANTIGRAVITY_DIR / "bin" / "agentapi"
DEFAULT_DB_PATH = DEFAULT_ANTIGRAVITY_DIR / "conversation_summaries.db"
DEFAULT_BRAIN_DIR = DEFAULT_ANTIGRAVITY_DIR / "brain"


def antigravity_config_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "agentapiPath": {
                "type": "string",
                "title": "AgentAPI executable path",
                "description": "Path to the Antigravity agentapi binary/script.",
                "default": str(DEFAULT_AGENTAPI_PATH),
            },
            "dataDir": {
                "type": "string",
                "title": "Antigravity App Data Directory",
                "description": "Directory where conversations and transcripts are stored.",
                "default": str(DEFAULT_ANTIGRAVITY_DIR),
            },
            "defaultModel": {
                "type": "string",
                "title": "Default Model",
                "description": "Default model to use when starting a conversation.",
                "enum": [
                    "flash",
                    "pro",
                    "flash_lite",
                    "gemini-3.8-flash",
                    "gemini-3.7-flash",
                    "gemini-3.6-flash",
                    "gemini-3.1-pro",
                    "claude-sonnet-4-6",
                    "claude-opus-4-6",
                    "claude-haiku-4-5",
                    "gpt-oss-120b",
                ],
                "default": "flash",
            },
        },
        "additionalProperties": True,
    }


def antigravity_capabilities(connector_id: str | None = None) -> RuntimeCapabilitySet:
    return RuntimeCapabilitySet(
        runtime="antigravity",
        revision=1,
        connector_id=connector_id,
        capabilities=(
            RuntimeCapability(
                capability_id=CAPABILITY_CATALOG_MODEL,
                scope="runtime",
                runtime="antigravity",
                connector_id=connector_id,
                supported=True,
                available=True,
                allowed=True,
                unavailable_reason=None,
                metadata={"source": "antigravity.runtime"},
            ),
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                scope="runtime",
                runtime="antigravity",
                connector_id=connector_id,
                supported=True,
                available=True,
                allowed=True,
                unavailable_reason=None,
                metadata={"source": "antigravity.runtime"},
            ),
        ),
        metadata={"source": "antigravity.runtime"},
    )


def antigravity_session_capabilities(
    session_id: str,
    connector_id: str | None = None,
    revision: int = 1,
) -> RuntimeCapabilitySet:
    return RuntimeCapabilitySet(
        runtime="antigravity",
        revision=revision,
        session_id=session_id,
        connector_id=connector_id,
        capabilities=(
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                scope="session",
                runtime="antigravity",
                session_id=session_id,
                connector_id=connector_id,
                supported=True,
                available=True,
                allowed=True,
                unavailable_reason=None,
                metadata={"source": "antigravity.runtime"},
            ),
            RuntimeCapability(
                capability_id=CAPABILITY_CATALOG_MODEL,
                scope="session",
                runtime="antigravity",
                session_id=session_id,
                connector_id=connector_id,
                supported=True,
                available=True,
                allowed=True,
                unavailable_reason=None,
                metadata={"source": "antigravity.runtime"},
            ),
        ),
        metadata={"source": "antigravity.runtime"},
    )
