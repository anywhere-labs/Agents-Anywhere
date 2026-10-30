"""Decode only a named native tool string; never interpret partial JSON as a plan."""

import json
import re


def partial_string(value: str, key: str) -> str | None:
    match = re.search(r'"' + re.escape(key) + r'"\s*:\s*"', value)
    if not match:
        return None
    start = match.end() - 1
    escaped = False
    for index in range(start + 1, len(value)):
        char = value[index]
        if char == '"' and not escaped:
            try:
                text = json.loads(value[start : index + 1])
                return text.encode("utf-16", errors="surrogatepass").decode("utf-16", errors="ignore")
            except (ValueError, UnicodeError):
                return None
        escaped = char == "\\" and not escaped
    # A split escape or unicode code point is retained for the next delta.
    for trim in range(min(7, len(value) - start)):
        try:
            text = json.loads(value[start : len(value) - trim] + '"')
            return text.encode("utf-16", errors="surrogatepass").decode(
                "utf-16", errors="ignore"
            )
        except (ValueError, UnicodeError):
            continue
    return None
