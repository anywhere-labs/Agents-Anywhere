"""Redact credentials without interpreting or logging log payloads."""
import re

_SECRET = re.compile(r"mk_[A-Za-z0-9_-]+|(?i:Bearer)\s+[A-Za-z0-9._~+/-]+=*")
_FIELD = re.compile(r'(\\?"(?:connectorToken|access_token|refresh_token|password|apiKey)\\?"\s*:\s*\\?")[^"\\]*', re.IGNORECASE)


def redact(value: str) -> str:
    return _FIELD.sub(lambda match: match[1] + "[REDACTED]", _SECRET.sub("[REDACTED]", value))
