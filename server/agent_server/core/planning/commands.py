from __future__ import annotations


def parse_plan_command(text: str) -> dict | None:
    value = text.lstrip()
    if not value.startswith("/plan"):
        return None
    suffix = value[5:]
    if suffix and not suffix[0].isspace():
        return None
    content = suffix[2:] if suffix.startswith("\r\n") else suffix[1:]
    return (
        {"command": "exit_plan"}
        if suffix.strip() == "off"
        else {"command": "submit_task", "content": content}
        if suffix.strip()
        else {"command": "enter_plan"}
    )
