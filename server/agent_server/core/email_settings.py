from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class EmailSettingsView(BaseModel):
    enabled: bool = False
    fromAddress: str = ""
    apiKeyConfigured: bool = False


class EmailSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    fromAddress: str | None = Field(default=None, max_length=320)
    apiKey: str | None = Field(default=None, max_length=512, repr=False)
    clearApiKey: bool = False
