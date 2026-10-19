"""Redact credentials without interpreting or logging log payloads."""
import re

_KEY = re.compile(r"\bmk_[A-Za-z0-9_-]+")
# Bearer/Basic values are unambiguous scheme tokens; ``Connector`` is only
# treated as a scheme next to an authorization field because it is a common
# word in log messages.
_SCHEME = re.compile(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*")
_FIELD = re.compile(
    r'(?i)((?:\\?")?(?:authorization|connectorToken|access[_-]?token|refresh[_-]?token'
    r'|password|secret|api[_-]?key|key)(?:\\?")?\s*[:=]\s*(?:\\?")?'
    r'(?:(?:Bearer|Basic|Connector)\s+)?)'
    r'([^"\\\s,}]+)'
)


def redact(value: str) -> str:
    value = _KEY.sub("[REDACTED]", value)
    value = _SCHEME.sub(lambda match: f"{match[1]} [REDACTED]", value)
    # The authorization prefix keeps its scheme so the value still reads as a
    # credential while ``connectorToken=...`` and quoted JSON forms both match.
    return _FIELD.sub(lambda match: f"{match[1]}[REDACTED]", value)
