"""Authenticator-app two-step verification for password sign-in."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from agent_server.core.auth import create_signed_token, verify_signed_token
from agent_server.core.totp import (
    generate_recovery_codes,
    generate_secret,
    hash_recovery_code,
    looks_like_totp_code,
    matching_step,
    normalize_code,
    provisioning_uri,
)
from agent_server.infra.secret_box import SecretBox
from agent_server.services.repository_ports import TotpRepository

LOGIN_CHALLENGE_KIND = "totp_login"
LOGIN_CHALLENGE_TTL_SECONDS = 300
MAX_FAILED_ATTEMPTS = 5
LOCK_SECONDS = 300
DEFAULT_ISSUER = "Agents Anywhere"


class TotpError(ValueError):
    code = "totp_error"


class TotpNotEnabledError(TotpError):
    code = "totp_not_enabled"


class TotpAlreadyEnabledError(TotpError):
    code = "totp_already_enabled"


class TotpSetupMissingError(TotpError):
    code = "totp_setup_missing"


class TotpInvalidCodeError(TotpError):
    code = "totp_invalid_code"


class TotpLockedError(TotpError):
    code = "totp_locked"

    def __init__(self, retry_after: int) -> None:
        super().__init__("too many wrong codes; try again later")
        self.retry_after = max(1, retry_after)


@dataclass(frozen=True)
class TotpStatus:
    enabled: bool
    pending_setup: bool
    recovery_codes_remaining: int


@dataclass(frozen=True)
class TotpSetup:
    secret: str
    otpauth_uri: str


class TotpService:
    def __init__(
        self,
        repository: TotpRepository,
        *,
        secret_box: Callable[[], SecretBox] = SecretBox,
        issuer: str = DEFAULT_ISSUER,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._repository = repository
        self._secret_box = secret_box
        self._issuer = issuer
        self._clock = clock

    async def status(self, user_id: str) -> TotpStatus:
        record = await self._repository.totp_record(user_id)
        enabled = bool(record and record.get("enabled_at"))
        remaining = await self._repository.totp_recovery_codes_remaining(user_id) if enabled else 0
        return TotpStatus(
            enabled=enabled,
            pending_setup=bool(record and not record.get("enabled_at")),
            recovery_codes_remaining=remaining,
        )

    async def is_enabled(self, user_id: str) -> bool:
        record = await self._repository.totp_record(user_id)
        return bool(record and record.get("enabled_at"))

    async def begin_setup(self, user_id: str, *, account: str) -> TotpSetup:
        if await self.is_enabled(user_id):
            raise TotpAlreadyEnabledError("two-step verification is already enabled")
        secret = generate_secret()
        sealed = self._secret_box().seal(secret, context=self._context(user_id))
        try:
            await self._repository.save_pending_totp(user_id, sealed)
        except ValueError as exc:
            raise TotpAlreadyEnabledError(str(exc)) from exc
        return TotpSetup(
            secret=secret,
            otpauth_uri=provisioning_uri(secret, account=account, issuer=self._issuer),
        )

    async def confirm_setup(self, user_id: str, code: str) -> list[str]:
        record = await self._repository.totp_record(user_id)
        if record is None:
            raise TotpSetupMissingError("start two-step verification setup first")
        if record.get("enabled_at"):
            raise TotpAlreadyEnabledError("two-step verification is already enabled")
        secret = self._open_secret(user_id, record)
        step = matching_step(secret, code, now=self._clock())
        if step is None:
            raise TotpInvalidCodeError("the code is not valid")
        recovery_codes = generate_recovery_codes()
        enabled = await self._repository.enable_totp(
            user_id,
            step=step,
            recovery_code_hashes=[hash_recovery_code(item) for item in recovery_codes],
        )
        if not enabled:
            raise TotpAlreadyEnabledError("two-step verification is already enabled")
        return recovery_codes

    async def verify(self, user_id: str, code: str) -> None:
        """Accept a current authenticator code or an unused recovery code."""
        record = await self._repository.totp_record(user_id)
        if record is None or not record.get("enabled_at"):
            raise TotpNotEnabledError("two-step verification is not enabled")
        now = int(self._clock())
        locked_until = record.get("locked_until")
        if locked_until and int(locked_until) > now:
            raise TotpLockedError(int(locked_until) - now)
        if looks_like_totp_code(code):
            secret = self._open_secret(user_id, record)
            step = matching_step(
                secret, code, now=self._clock(), after_step=record.get("last_used_step")
            )
            if step is not None and await self._repository.accept_totp_step(user_id, step):
                return
        elif normalize_code(code) and await self._repository.consume_totp_recovery_code(
            user_id, hash_recovery_code(code)
        ):
            return
        locked = await self._repository.record_totp_failure(
            user_id, now=now, max_attempts=MAX_FAILED_ATTEMPTS, lock_seconds=LOCK_SECONDS
        )
        if locked is not None:
            raise TotpLockedError(locked - now)
        raise TotpInvalidCodeError("the code is not valid")

    async def disable(self, user_id: str, code: str) -> None:
        await self.verify(user_id, code)
        await self._repository.delete_totp(user_id)

    async def cancel_setup(self, user_id: str) -> None:
        record = await self._repository.totp_record(user_id)
        if record is not None and not record.get("enabled_at"):
            await self._repository.delete_totp(user_id)

    async def regenerate_recovery_codes(self, user_id: str, code: str) -> list[str]:
        await self.verify(user_id, code)
        recovery_codes = generate_recovery_codes()
        await self._repository.replace_totp_recovery_codes(
            user_id, [hash_recovery_code(item) for item in recovery_codes]
        )
        return recovery_codes

    async def reset(self, user_id: str) -> bool:
        """Remove two-step verification without a code (administrator recovery)."""
        return await self._repository.delete_totp(user_id)

    @staticmethod
    def create_login_challenge(user_id: str) -> str:
        return create_signed_token(
            LOGIN_CHALLENGE_KIND, {"userId": user_id}, LOGIN_CHALLENGE_TTL_SECONDS
        )

    @staticmethod
    def user_for_login_challenge(token: str) -> str | None:
        payload = verify_signed_token(LOGIN_CHALLENGE_KIND, token)
        if not payload:
            return None
        user_id = payload.get("userId")
        return user_id if isinstance(user_id, str) and user_id else None

    def _open_secret(self, user_id: str, record: dict) -> str:
        secret = self._secret_box().open(
            str(record["secret_sealed"]), context=self._context(user_id)
        )
        if secret is None:
            # The server secret changed since setup; the stored secret is unusable.
            raise TotpSetupMissingError("two-step verification secret can no longer be read")
        return secret

    @staticmethod
    def _context(user_id: str) -> str:
        return f"user_totp:{user_id}"
