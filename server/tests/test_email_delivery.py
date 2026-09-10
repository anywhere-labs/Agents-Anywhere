from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from agent_server.core.email_settings import EmailSettingsUpdate
from agent_server.services import email_delivery


class SettingsStore:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get_setting(self, key: str) -> str | None:
        return self.values.get(key)

    async def set_setting(self, key: str, value: str) -> None:
        self.values[key] = value


def test_configuration_masks_key_preserves_blank_and_requires_complete_enabled_settings():
    async def exercise():
        db = SettingsStore()
        initial = await email_delivery.get_email_settings(db)
        assert initial == {"enabled": False, "apiKey": "", "fromAddress": ""}
        with pytest.raises(ValueError, match="required"):
            await email_delivery.update_email_settings(db, EmailSettingsUpdate(enabled=True))
        assert not db.values
        saved = await email_delivery.update_email_settings(db, EmailSettingsUpdate(
            enabled=True, apiKey="re_test_only", fromAddress="Agents Anywhere <mail@example.com>",
        ))
        assert saved.model_dump() == {
            "enabled": True, "fromAddress": "Agents Anywhere <mail@example.com>", "apiKeyConfigured": True,
        }
        kept = await email_delivery.update_email_settings(db, EmailSettingsUpdate(apiKey="   "))
        assert kept.apiKeyConfigured
        assert (await email_delivery.get_email_settings(db))["apiKey"] == "re_test_only"
        with pytest.raises(ValueError, match="required"):
            await email_delivery.update_email_settings(db, EmailSettingsUpdate(clearApiKey=True))
        assert (await email_delivery.get_email_settings(db))["enabled"]
        cleared = await email_delivery.update_email_settings(db, EmailSettingsUpdate(
            enabled=False, clearApiKey=True,
        ))
        assert not cleared.enabled and not cleared.apiKeyConfigured

    asyncio.run(exercise())


@pytest.mark.parametrize("sender", ["not-email", "mail@example.com\r\nBcc: victim@example.com"])
def test_invalid_sender_is_rejected_without_saving(sender):
    async def exercise():
        db = SettingsStore()
        with pytest.raises(ValueError, match="sender"):
            await email_delivery.update_email_settings(db, EmailSettingsUpdate(fromAddress=sender))
        assert not db.values

    asyncio.run(exercise())


def _mock_resend(monkeypatch, handler):
    original_client = httpx.AsyncClient
    monkeypatch.setattr(email_delivery.httpx, "AsyncClient", lambda **kwargs: original_client(
        transport=httpx.MockTransport(handler), **kwargs,
    ))


def test_resend_delivery_uses_server_key_and_single_recipient(monkeypatch):
    requests = []

    def handle(request):
        requests.append(request)
        assert str(request.url) == "https://api.resend.com/emails"
        assert request.headers["Authorization"] == "Bearer re_test_only"
        body = json.loads(request.content)
        assert body["to"] == ["person@example.com"]
        assert body["from"] == "mail@example.com"
        assert "123456" in body["text"]
        assert "re_test_only" not in body["text"]
        return httpx.Response(200, json={"id": "test-delivery-id"})

    _mock_resend(monkeypatch, handle)

    async def exercise():
        db = SettingsStore()
        await email_delivery.update_email_settings(db, EmailSettingsUpdate(
            enabled=True, apiKey="re_test_only", fromAddress="mail@example.com",
        ))
        await email_delivery.send_verification_email(db, "person@example.com", "123456")
        assert len(requests) == 1

    asyncio.run(exercise())


@pytest.mark.parametrize("status,body", [(403, {"message": "re_test_only private detail"}), (200, {})])
def test_delivery_failures_are_not_reported_as_success_or_expose_provider_details(monkeypatch, status, body):
    _mock_resend(monkeypatch, lambda request: httpx.Response(status, json=body))

    async def exercise():
        db = SettingsStore()
        await email_delivery.update_email_settings(db, EmailSettingsUpdate(
            enabled=True, apiKey="re_test_only", fromAddress="mail@example.com",
        ))
        with pytest.raises(email_delivery.EmailDeliveryError) as error:
            await email_delivery.send_verification_email(db, "person@example.com", "123456")
        assert "re_test_only" not in str(error.value)
        assert "private detail" not in str(error.value)

    asyncio.run(exercise())


def test_disabled_verification_never_sends_email(monkeypatch):
    def unexpected_request(request):
        pytest.fail("disabled verification must not call Resend")

    _mock_resend(monkeypatch, unexpected_request)
    with pytest.raises(email_delivery.EmailDeliveryError, match="not configured"):
        asyncio.run(email_delivery.send_verification_email(SettingsStore(), "person@example.com", "123456"))
