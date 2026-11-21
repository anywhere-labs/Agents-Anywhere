from __future__ import annotations


class ControlError(Exception):
    """Base application/domain error raised by core & service layers."""

    code: str = "internal"
    http_status: int = 500

    def __init__(self, message: str, *, code: str | None = None, http_status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if http_status is not None:
            self.http_status = http_status


class ValidationError(ControlError):
    code = "invalid_argument"
    http_status = 422


class UnauthenticatedError(ControlError):
    code = "unauthenticated"
    http_status = 401


class ForbiddenError(ControlError):
    code = "permission_denied"
    http_status = 403


class NotFoundError(ControlError):
    code = "not_found"
    http_status = 404


class ConflictError(ControlError):
    code = "conflict"
    http_status = 409


class RateLimitError(ControlError):
    code = "resource_exhausted"
    http_status = 429


class DeviceOfflineError(ControlError):
    code = "device_offline"
    http_status = 503


class UpstreamUnavailableError(ControlError):
    code = "unavailable"
    http_status = 503
