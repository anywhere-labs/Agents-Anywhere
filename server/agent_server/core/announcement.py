from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AnnouncementUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool
    markdown: str = Field(max_length=20_000)

    @model_validator(mode="after")
    def require_published_content(self) -> AnnouncementUpdate:
        if self.enabled and not self.markdown.strip():
            raise ValueError("An enabled announcement must contain Markdown text")
        return self


class AnnouncementSettings(BaseModel):
    enabled: bool = False
    markdown: str = ""
    publishedAt: str | None = None


class PublicAnnouncement(BaseModel):
    markdown: str
    publishedAt: str


class AnnouncementResponse(BaseModel):
    announcement: PublicAnnouncement | None = None
