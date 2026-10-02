from pydantic import BaseModel, ConfigDict, Field

CHUNK_BYTES = 262_144
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MAX_PENDING_BYTES = 512 * 1024 * 1024
MAX_PENDING_UPLOADS = 32


class SnapshotUploadManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    uploadId: str = Field(pattern=r"^[a-f0-9]{64}$")
    sessionId: str = Field(min_length=1, max_length=256)
    runtimeId: str = Field(min_length=1, max_length=256)
    throughSeq: int = Field(ge=-1, le=9_007_199_254_740_991)
    totalBytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)


class SnapshotUploadError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
