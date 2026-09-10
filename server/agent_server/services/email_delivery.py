"""Instance-owned Resend configuration and verification mail delivery.

No provider credentials or raw provider errors are exposed to public clients.
OTP issuance, expiry and consumption belong to the account repository.
"""

from __future__ import annotations

import json
import re
from email.utils import parseaddr
from typing import Any, Protocol

import httpx

from agent_server.core.email_settings import EmailSettingsUpdate, EmailSettingsView


class EmailSettingsStore(Protocol):
    async def get_setting(self, key: str) -> str | None: ...

    async def set_setting(self, key: str, value: str) -> None: ...


EMAIL_SETTING_KEY = "email_verification"
RESEND_SEND_URL = "https://api.resend.com/emails"


class EmailDeliveryError(Exception):
    """Safe, user-facing delivery failure without provider response contents."""


async def get_email_settings(db: EmailSettingsStore) -> dict[str, Any]:
    raw = await db.get_setting(EMAIL_SETTING_KEY)
    try:
        value = json.loads(raw) if raw else {}
    except ValueError as exc:
        raise EmailDeliveryError("Email service configuration is invalid.") from exc
    if not isinstance(value, dict):
        raise EmailDeliveryError("Email service configuration is invalid.")
    return {
        "enabled": value.get("enabled") is True,
        "fromAddress": str(value.get("fromAddress") or ""),
        "apiKey": str(value.get("apiKey") or ""),
    }


def public_email_settings(value: dict[str, Any]) -> EmailSettingsView:
    return EmailSettingsView(
        enabled=value.get("enabled") is True,
        fromAddress=str(value.get("fromAddress") or ""),
        apiKeyConfigured=bool(value.get("apiKey")),
    )


async def update_email_settings(db: EmailSettingsStore, patch: EmailSettingsUpdate) -> EmailSettingsView:
    value = await get_email_settings(db)
    if patch.enabled is not None:
        value["enabled"] = patch.enabled
    if patch.fromAddress is not None:
        sender = patch.fromAddress.strip()
        if sender and not _valid_sender(sender):
            raise ValueError("Enter a valid sender email address.")
        value["fromAddress"] = sender
    if patch.clearApiKey:
        if patch.apiKey and patch.apiKey.strip():
            raise ValueError("Cannot replace and clear the API key together.")
        value["apiKey"] = ""
    elif patch.apiKey and patch.apiKey.strip():
        api_key = patch.apiKey.strip()
        if not api_key.isascii() or any(char.isspace() for char in api_key):
            raise ValueError("Enter a valid Resend API key.")
        value["apiKey"] = api_key
    if value["enabled"] and (not value["apiKey"] or not _valid_sender(value["fromAddress"])):
        raise ValueError("A Resend API key and sender address are required to enable verification.")
    await db.set_setting(EMAIL_SETTING_KEY, json.dumps(value, separators=(",", ":")))
    return public_email_settings(value)


def _valid_sender(value: str) -> bool:
    if any(char in value for char in "\r\n"):
        return False
    _name, address = parseaddr(value)
    return bool(re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", address))


async def send_verification_email(db: EmailSettingsStore, email: str, code: str) -> None:
    settings = await get_email_settings(db)
    if not settings["enabled"] or not settings["apiKey"] or not _valid_sender(settings["fromAddress"]):
        raise EmailDeliveryError("Email verification service is not configured.")
    if not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("Verification code must contain six digits.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
            response = await client.post(
                RESEND_SEND_URL,
                headers={"Authorization": f"Bearer {settings['apiKey']}"},
                json={
                    "from": settings["fromAddress"],
                    "to": [email],
                    "subject": "Agents Anywhere · 邮箱验证码 / Email verification",
                    "text": (
                        f"你的 Agents Anywhere 邮箱验证码是：{code}\n"
                        f"Your Agents Anywhere verification code is: {code}\n\n"
                        "验证码 10 分钟内有效，请勿分享。若非本人操作，请忽略此邮件。\n"
                        "This code expires in 10 minutes. Do not share it. "
                        "If you did not request this email, you can ignore it."
                    ),
                },
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict) or not result.get("id"):
                raise EmailDeliveryError("Email provider did not confirm delivery. Please try again later.")
    except (httpx.HTTPError, ValueError) as exc:
        raise EmailDeliveryError(
            "Unable to send verification email. Please try again later or contact the administrator."
        ) from exc
