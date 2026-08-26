from __future__ import annotations


class RuntimeProtocolError(RuntimeError):
    code = "runtime_protocol_error"
    retryable = False


class RuntimeUnsupportedError(RuntimeProtocolError):
    code = "runtime_unsupported"

    def __init__(self, method: str) -> None:
        super().__init__(f"runtime does not support {method}")
        self.method = method


class RuntimeInvalidRequestError(RuntimeProtocolError):
    code = "runtime_invalid_request"


class RuntimeInstancesUnsupportedError(RuntimeInvalidRequestError):
    code = "runtime_instances_unsupported"


class RuntimeConflictError(RuntimeProtocolError):
    code = "runtime_conflict"


class RuntimeUnavailableError(RuntimeProtocolError):
    code = "runtime_unavailable"
    retryable = True


class RuntimeUpstreamError(RuntimeProtocolError):
    code = "runtime_upstream_error"
