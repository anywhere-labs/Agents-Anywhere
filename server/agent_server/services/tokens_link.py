"""Tokens Anywhere link use cases: link, refresh, sync, rotate and unlink.

The link's refresh token is sealed in ``tokens_links``; access tokens live in
a short cache. Refreshing rotates the refresh token, so it runs under a row
lock and is retried at most once while the lock is held (§4.4).
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, Protocol

from loguru import logger

from agent_server.core.model_channel import TOKENS
from agent_server.core.model_config import (
    ModelPreferences,
    Offer,
    catalog_digest,
    effective_offers,
)
from agent_server.core.tokens_link import (
    ACCESS_TOKEN_MARGIN,
    BROWSER_TTL,
    KEEP_ALIVE_AFTER,
    PROFILE_NAME,
    RELINK_AFTER,
    TICKET_TTL,
    authorize_url,
    catalog_offers,
    code_challenge,
    key_ref,
    new_code_verifier,
    new_secret,
    normalize_tokens_url,
    price_index,
    public_account,
    secret_hash,
)
from agent_server.infra.secret_box import SecretBox, SecretBoxUnavailableError
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.tokens_access_cache import TokensAccessCache
from agent_server.infra.tokens_client import (
    TokenPair,
    TokensClient,
    TokensError,
    TokensInvalidGrantError,
    TokensUnauthorizedError,
    TokensUnavailableError,
)
from agent_server.services.model_channels import ModelChannelService
from agent_server.services.model_config import (
    ModelConfigConflictError,
    ModelConfigError,
    ModelConfigService,
)

SETTING_TOKENS_URL = "tokens_anywhere_url"
# Tokens Anywhere hands a managed key's secret out again only when it keeps
# it sealed, which needs its TOKENS_SECRETS_KEY.
KEY_NOT_KEPT = {"key_secret_not_kept", "secrets_key_missing"}
KEEP_ALIVE_INTERVAL = timedelta(days=1)
# Tokens Anywhere counts usage by Beijing date.
BEIJING = timezone(timedelta(hours=8))


class TokensLinkError(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.detail = {"code": code, "message": message}


class TokensLinkRepository(Protocol):
    async def get_setting(self, key: str, default: str | None = None) -> str | None: ...
    async def set_setting(self, key: str, value: str) -> None: ...
    async def create_tokens_link_state(self, row: dict[str, Any]) -> None: ...
    async def open_tokens_link_ticket(
        self, *, ticket_hash: str, browser_hash: str, now: str, expires_at: str
    ) -> dict[str, Any] | None: ...
    async def consume_tokens_link_state(
        self, *, state_hash: str, browser_hash: str, now: str
    ) -> dict[str, Any] | None: ...
    async def prune_tokens_link_states(self, *, before: str) -> None: ...
    async def save_tokens_link(self, row: dict[str, Any]) -> None: ...
    async def switch_tokens_account(
        self, row: dict[str, Any], *, expected_linked_at: str, profile_id: str,
        key_ref: dict[str, Any], catalog_digest: str,
    ) -> bool: ...
    async def get_tokens_link(self, user_id: str) -> dict[str, Any] | None: ...
    async def delete_tokens_link(self, user_id: str) -> None: ...
    async def count_tokens_links(self) -> int: ...
    async def list_tokens_links_to_refresh(self, *, refreshed_before: str) -> list[str]: ...
    def locked_tokens_link(self, user_id: str) -> Any: ...
    async def find_model_profile_by_source(self, *, user_id: str, source: str) -> dict[str, Any] | None: ...
    async def set_runtime_assignment_failed(
        self, connector_id: str, runtime_id: str, error: dict[str, Any]
    ) -> None: ...


TokensClientFactory = Callable[[str], TokensClient]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


class TokensLinkService:
    def __init__(
        self,
        store: TokensLinkRepository,
        model_config: ModelConfigService,
        *,
        client_factory: TokensClientFactory = TokensClient,
        access_cache: TokensAccessCache | None = None,
        broker: TimelineBroker | None = None,
        secret_box: Callable[[], SecretBox] = SecretBox,
    ) -> None:
        self._store = store
        self.model_config = model_config
        self._client_factory = client_factory
        self._cache = access_cache or TokensAccessCache()
        self._broker = broker
        self._secret_box = secret_box
        # Set by the caller: which runtimes use Anywhere, and rewriting them.
        self.channels: ModelChannelService | None = None
        model_config.set_tokens_key_provider(self.key_for_profile)

    # Instance setting.

    async def issuer(self) -> str | None:
        """The configured Tokens Anywhere origin, or None when there is none."""
        stored = await self._store.get_setting(SETTING_TOKENS_URL)
        if stored is not None:
            return stored or None
        configured = os.environ.get("AGENT_SERVER_TOKENS_URL", "").strip()
        if not configured:
            return None
        try:
            return normalize_tokens_url(configured)
        except ValueError:
            logger.warning("AGENT_SERVER_TOKENS_URL is not an origin; Tokens Anywhere stays off")
            return None

    async def admin_settings(self) -> dict[str, Any]:
        stored = await self._store.get_setting(SETTING_TOKENS_URL)
        return {
            "tokensUrl": await self.issuer(),
            "source": "setting" if stored is not None else ("environment" if await self.issuer() else None),
            "linkedAccounts": await self._store.count_tokens_links(),
            "secretConfigured": self._box_available(),
        }

    async def set_tokens_url(self, value: str | None) -> dict[str, Any]:
        """Change the address; refused while accounts are linked to the old one."""
        try:
            normalized = normalize_tokens_url(value) if value else ""
        except ValueError as exc:
            raise TokensLinkError("invalid_tokens_url", str(exc), status_code=422) from exc
        if (normalized or None) != await self.issuer() and await self._store.count_tokens_links():
            raise TokensLinkError(
                "tokens_links_exist", "linked accounts must unlink before the address changes"
            )
        await self._store.set_setting(SETTING_TOKENS_URL, normalized)
        return await self.admin_settings()

    # Reading.

    async def status(self, *, user_id: str) -> dict[str, Any]:
        """What every client shows about the link; no tokens or keys."""
        issuer = await self.issuer()
        link = await self._store.get_tokens_link(user_id)
        public_link = None
        if link is not None:
            issued = _parse(link["issuedAt"])
            public_link = {
                "status": link["status"],
                "issuer": link["issuer"],
                "account": link["account"],
                "linkedAt": link["linkedAt"],
                "relinkSoon": bool(issued and _now() - issued > RELINK_AFTER),
            }
        return {
            "available": issuer is not None,
            "tokensUrl": issuer,
            "secretConfigured": self._box_available(),
            "link": public_link,
        }

    async def overview(
        self,
        *,
        user_id: str,
        runtime_rows: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """The snapshot's ``modelConfig``: profiles, assignments, channels and the link."""
        overview, tokens = await asyncio.gather(
            self.model_config.overview(user_id=user_id, runtime_rows=runtime_rows),
            self.status(user_id=user_id),
        )
        channels = self._channels()
        await channels.recover_missing(user_id=user_id)
        channel = await channels.state(user_id=user_id, runtime_rows=runtime_rows)
        return {**overview, "channel": channel, "tokens": tokens}

    async def begin_link(self, *, user_id: str, redirect_uri: str) -> str:
        """Prepare a link; returns a one-time start ticket for the browser."""
        issuer = await self._require_issuer()
        box = self._box()
        current_link = await self._store.get_tokens_link(user_id)
        state, ticket, verifier = new_secret(), new_secret(), new_code_verifier()
        state_hash = secret_hash(state)
        now = _now()
        await self._store.prune_tokens_link_states(before=_iso(now))
        await self._store.create_tokens_link_state(
            {
                "state_hash": state_hash,
                "user_id": user_id,
                "ticket_hash": secret_hash(ticket),
                "browser_hash": None,
                "code_verifier_ciphertext": box.seal(
                    json.dumps({"verifier": verifier, "state": state, "linkedAt": current_link["linkedAt"] if current_link else None}),
                    context=f"tokens-link:{state_hash}",
                ),
                "issuer": issuer,
                "redirect_uri": redirect_uri,
                "created_at": _iso(now),
                "expires_at": _iso(now + TICKET_TTL),
                "quick_setup_json": None,
            }
        )
        return ticket

    async def open_ticket(self, ticket: str) -> tuple[str, str]:
        """Bind the link to this browser; returns the authorize URL and a browser secret."""
        box = self._box()
        browser = new_secret()
        now = _now()
        row = await self._store.open_tokens_link_ticket(
            ticket_hash=secret_hash(ticket),
            browser_hash=secret_hash(browser),
            now=_iso(now),
            expires_at=_iso(now + BROWSER_TTL),
        )
        if row is None:
            raise TokensLinkError("link_expired", "this link has expired; start again", status_code=400)
        sealed = box.open(row["codeVerifierCiphertext"], context=f"tokens-link:{row['stateHash']}")
        if sealed is None:
            raise TokensLinkError("link_expired", "this link has expired; start again", status_code=400)
        material = json.loads(sealed)
        url = authorize_url(
            row["issuer"],
            redirect_uri=row["redirectUri"],
            state=material["state"],
            challenge=code_challenge(material["verifier"]),
        )
        return url, browser

    async def complete(
        self,
        *,
        state: str | None,
        code: str | None,
        issuer: str | None,
        error: str | None,
        browser: str | None,
    ) -> str:
        """Finish a link from the callback; returns the issuer to send the browser to."""
        if not state or not browser:
            raise TokensLinkError("invalid_state", "this link was not started in this browser", status_code=400)
        box = self._box()
        row = await self._store.consume_tokens_link_state(
            state_hash=secret_hash(state), browser_hash=secret_hash(browser), now=_iso(_now())
        )
        if row is None:
            raise TokensLinkError("invalid_state", "this link was not started in this browser", status_code=400)
        if issuer != row["issuer"]:
            raise TokensLinkError("invalid_issuer", "the answer did not come from Tokens Anywhere", status_code=400)
        if error:
            code_name = "access_denied" if error == "access_denied" else "authorization_failed"
            raise TokensLinkError(code_name, "Tokens Anywhere did not authorize the link", status_code=400)
        if not code:
            raise TokensLinkError("authorization_failed", "Tokens Anywhere sent no code", status_code=400)
        sealed = box.open(row["codeVerifierCiphertext"], context=f"tokens-link:{row['stateHash']}")
        if sealed is None:
            raise TokensLinkError("link_expired", "this link has expired; start again", status_code=400)
        client = self._client_factory(row["issuer"])
        try:
            pair = await client.exchange_code(
                code=code, verifier=json.loads(sealed)["verifier"], redirect_uri=row["redirectUri"]
            )
        except TokensError as exc:
            raise TokensLinkError("exchange_failed", "Tokens Anywhere did not issue a token", status_code=502) from exc
        user_id = row["userId"]
        previous = await self._store.get_tokens_link(user_id)
        if (previous["linkedAt"] if previous else None) != json.loads(sealed).get("linkedAt"):
            raise TokensLinkError("link_expired", "the account changed; start authorization again", status_code=409)
        profile = await self._store.find_model_profile_by_source(user_id=user_id, source="tokens")
        replacement = None
        if previous is not None:
            # Preflight before changing the link: a cancelled authorization or
            # unavailable managed key leaves the existing account usable.
            try:
                replacement = await client.managed_key(pair.access_token)
            except TokensError as exc:
                raise TokensLinkError(exc.code, "could not obtain the new account key", status_code=502) from exc
        account: dict[str, Any] = {}
        try:
            account = public_account(await client.me(pair.access_token))
        except TokensError as exc:
            if previous is not None:
                raise TokensLinkError(exc.code, "could not read the new account", status_code=502) from exc
            logger.warning("tokens account lookup failed after linking user_id={}", user_id)
        now = _iso(_now())
        link_values = {
            "user_id": user_id, "issuer": row["issuer"], "account": account, "status": "linked",
            "refresh_token_ciphertext": box.seal(pair.refresh_token, context=f"tokens-refresh:{user_id}"),
            "linked_at": now, "refreshed_at": now, "issued_at": now,
            "quick_setup": None,
        }
        if replacement is not None and profile is not None:
            reference = key_ref(replacement["key"])
            preferences = ModelPreferences.model_validate(profile.get("preferences") or {})
            digest = catalog_digest(effective_offers(
                [Offer.model_validate(offer) for offer in profile["offers"]], preferences,
            ), reference)
            changed = await self._store.switch_tokens_account(
                link_values, expected_linked_at=previous["linkedAt"], profile_id=profile["id"],
                key_ref=reference, catalog_digest=digest,
            )
            if not changed:
                raise TokensLinkError("link_expired", "the account changed; start authorization again")
        else:
            await self._store.save_tokens_link(link_values)
        await self._cache.delete(user_id)
        await self._cache_access(user_id, pair, box)
        if replacement is not None and profile is not None:
            # The new key identity outdates every runtime on Anywhere; they are
            # rewritten through the switch, waiting for running tasks.
            await self._channels().refresh(user_id=user_id, rewrite=TOKENS)
            await self._publish(user_id)
            return row["issuer"]
        try:
            await self.sync(user_id=user_id)
        except (TokensLinkError, TokensError, ModelConfigError):
            # The link stands; the page offers to sync again.
            logger.warning("tokens catalog sync failed after linking user_id={}", user_id)
        await self._publish(user_id)
        return row["issuer"]

    # Tokens.

    async def access_token(self, *, user_id: str, force: bool = False) -> str:
        box = self._box()
        if not force:
            cached = await self._cache.get(user_id, box)
            if cached:
                return cached
        reauth = False
        token: str | None = None
        async with self._store.locked_tokens_link(user_id) as locked:
            row = locked.row
            if row is None:
                raise TokensLinkError("tokens_not_linked", "link Tokens Anywhere first")
            if row["status"] != "linked" or not row["refreshTokenCiphertext"]:
                raise TokensLinkError("reauth_required", "link Tokens Anywhere again")
            # Another worker may have refreshed while this one waited.
            token = None if force else await self._cache.get(user_id, box)
            if token is None:
                refresh = box.open(row["refreshTokenCiphertext"], context=f"tokens-refresh:{user_id}")
                pair = None
                if refresh is None:
                    reauth = True
                else:
                    try:
                        pair = await self._refresh_once_more(self._client_factory(row["issuer"]), refresh)
                    except TokensInvalidGrantError:
                        reauth = True
                if reauth:
                    await locked.require_reauth()
                else:
                    assert pair is not None
                    await locked.save_refresh_token(
                        box.seal(pair.refresh_token, context=f"tokens-refresh:{user_id}"),
                        refreshed_at=_iso(_now()),
                    )
                    await self._cache_access(user_id, pair, box)
                    token = pair.access_token
        if reauth:
            await self._cache.delete(user_id)
            await self._publish(user_id)
            raise TokensLinkError("reauth_required", "link Tokens Anywhere again")
        assert token is not None
        return token

    async def _refresh_once_more(self, client: TokensClient, refresh: str) -> TokenPair:
        try:
            return await client.refresh(refresh)
        except TokensUnavailableError:
            # Tokens Anywhere accepts the previous refresh token for 10 seconds;
            # one retry while the lock is held keeps an unknown outcome safe.
            await asyncio.sleep(1)
            return await client.refresh(refresh)

    async def _cache_access(self, user_id: str, pair: TokenPair, box: SecretBox) -> None:
        ttl = pair.expires_in - int(ACCESS_TOKEN_MARGIN.total_seconds())
        await self._cache.set(user_id, pair.access_token, ttl_seconds=ttl, box=box)

    async def _call(self, user_id: str, action: Callable[[TokensClient, str], Any]) -> Any:
        """Call Tokens Anywhere with an access token, refreshing once on a 401."""
        issuer = await self._link_issuer(user_id)
        client = self._client_factory(issuer)
        try:
            return await action(client, await self.access_token(user_id=user_id))
        except TokensUnauthorizedError:
            await self._cache.delete(user_id)
            return await action(client, await self.access_token(user_id=user_id, force=True))

    async def key_for_profile(self, user_id: str, profile: dict[str, Any]) -> str:
        """The managed key's secret, as ModelConfigService applies it."""
        try:
            body = await self._managed_key(user_id)
            if key_ref(body["key"]) != profile["keyRef"]:
                # A switch may have committed before cache invalidation reached
                # this worker. Never acknowledge delivery of the previous key.
                await self.access_token(user_id=user_id, force=True)
                body = await self._managed_key(user_id)
                if key_ref(body["key"]) != profile["keyRef"]:
                    raise ModelConfigConflictError("tokens_not_synced", "the account key changed; retry the update")
        except TokensError as exc:
            raise ModelConfigConflictError("tokens_unavailable", "Tokens Anywhere did not return the key") from exc
        except TokensLinkError as exc:
            raise ModelConfigConflictError(exc.code, exc.message) from exc
        return str(body["secret"])

    async def _managed_key(self, user_id: str) -> dict[str, Any]:
        try:
            return await self._call(user_id, lambda client, token: client.managed_key(token))
        except TokensError as exc:
            if exc.code in KEY_NOT_KEPT:
                raise TokensLinkError(
                    "key_not_kept",
                    "Tokens Anywhere did not keep this instance's key; link again after it sets TOKENS_SECRETS_KEY",
                ) from exc
            raise

    # Catalog and key.

    async def sync(self, *, user_id: str) -> dict[str, Any]:
        """Refresh the Tokens profile from what the managed key can reach."""
        issuer = await self._link_issuer(user_id)
        body = await self._managed_key(user_id)
        client = self._client_factory(issuer)
        secret = str(body["secret"])
        gateway = await self._gateway_origin(client, issuer)
        gateway_client = client if gateway == issuer else self._client_factory(gateway)
        try:
            openai_models = await gateway_client.models(secret, anthropic=False)
            anthropic_models = await gateway_client.models(secret, anthropic=True)
        except TokensUnauthorizedError as exc:
            raise TokensLinkError("key_rejected", "Tokens Anywhere refused this instance's key") from exc
        try:
            pricing = await client.pricing()
        except TokensError:
            pricing = {"groups": [], "profiles": {}}
        offers = catalog_offers(
            gateway,
            openai_models=openai_models,
            anthropic_models=anthropic_models,
            profiles=pricing["profiles"],
            prices=price_index(pricing),
        )
        if not offers:
            raise TokensLinkError("catalog_empty", "this key reaches no models yet")
        return await self.model_config.save_tokens_profile(
            user_id=user_id, name=PROFILE_NAME, offers=offers, key_ref=key_ref(body["key"])
        )

    async def _gateway_origin(self, client: TokensClient, issuer: str) -> str:
        """The gateway's origin from Tokens Anywhere's status, else the site's own."""
        try:
            configured = await client.api_base_url()
        except TokensError:
            return issuer
        try:
            return normalize_tokens_url(configured) if configured else issuer
        except ValueError:
            logger.warning("Tokens Anywhere reported an unusable apiBaseUrl; using its own origin")
            return issuer

    async def rotate_key(self, profile_id: str, *, user_id: str, allow_interrupt: bool) -> dict[str, Any]:
        """Rotate the managed key, then write the new secret everywhere it is used."""
        profile = await self._tokens_profile(user_id)
        if profile["id"] != profile_id:
            raise TokensLinkError("profile_read_only", "only the Tokens Anywhere profile has a managed key")
        key_id = str(profile["keyRef"].get("id") or "")
        if not key_id:
            raise TokensLinkError("tokens_not_synced", "sync Tokens Anywhere first")
        channels = self._channels()
        targets = await channels.runtimes_on(TOKENS, user_id=user_id)
        # The old key stops working at once, so refuse before rotating rather
        # than leave runtimes with running tasks on a dead key.
        if not allow_interrupt and await channels.would_interrupt(targets, user_id=user_id):
            raise TokensLinkError("busy", "tasks are running; allow interrupting them to rotate the key")
        try:
            await self._call(user_id, lambda client, token: client.rotate_key(token, key_id))
        except TokensError as exc:
            raise TokensLinkError("tokens_unavailable", "Tokens Anywhere did not rotate the key", status_code=502) from exc
        await self.sync(user_id=user_id)
        await channels.refresh(user_id=user_id, rewrite=TOKENS)
        return await channels.state(user_id=user_id)

    async def save_model_preferences(self, preferences: ModelPreferences, *, user_id: str) -> bool:
        """Save which models runtimes get; True when runtimes on Anywhere are rewritten."""
        await self.model_config.set_tokens_preferences(preferences, user_id=user_id)
        return await self._channels().refresh(user_id=user_id)

    # Account.

    async def account(self, *, user_id: str) -> dict[str, Any]:
        """The Tokens account, its balance, and where its console pages are."""
        issuer = await self._link_issuer(user_id)
        try:
            me = await self._call(user_id, lambda client, token: client.me(token))
            balance = await self._call(user_id, lambda client, token: client.balance(token))
        except TokensError as exc:
            raise TokensLinkError("tokens_unavailable", "Tokens Anywhere is unavailable", status_code=502) from exc
        return {
            "account": public_account(me),
            "balance": {key: balance.get(key) for key in ("balance", "available", "held", "bonus")},
            "links": {
                "console": f"{issuer}/console/",
                "billing": f"{issuer}/console/settings/billing/",
                "usage": f"{issuer}/console/usage/",
            },
        }

    async def usage(self, *, user_id: str, days: int) -> dict[str, Any]:
        """Settled usage of the whole Tokens account per day and model."""
        end = datetime.now(BEIJING).date()
        start = end - timedelta(days=days - 1)
        try:
            items = await self._call(
                user_id,
                lambda client, token: client.usage_daily(token, start=start.isoformat(), end=end.isoformat()),
            )
        except TokensError as exc:
            raise TokensLinkError("tokens_unavailable", "Tokens Anywhere is unavailable", status_code=502) from exc
        keep = ("date", "model", "requests", "inputTokens", "outputTokens", "cacheReadTokens",
                "cacheWrite5mTokens", "cacheWrite1hTokens", "amountCharged")
        return {"from": start.isoformat(), "to": end.isoformat(), "items": [{k: item.get(k) for k in keep} for item in items]}

    # Unlinking.

    async def unlink(self, *, user_id: str) -> dict[str, Any]:
        """Revoke and forget the link once no runtime uses or wants Anywhere."""
        link = await self._store.get_tokens_link(user_id)
        if link is None:
            raise TokensLinkError("tokens_not_linked", "Tokens Anywhere is not linked", status_code=404)
        # Revoking kills the key at once: switch the runtimes away first.
        if await self._channels().tokens_in_use(user_id=user_id):
            raise TokensLinkError("channel_in_use", "switch the runtimes on Anywhere to another channel first")
        revoked = False
        if link["refreshTokenCiphertext"]:
            refresh = self._box().open(link["refreshTokenCiphertext"], context=f"tokens-refresh:{user_id}")
            if refresh:
                try:
                    await self._client_factory(link["issuer"]).revoke(refresh)
                    revoked = True
                except TokensError:
                    logger.warning("tokens revoke failed during unlink user_id={}", user_id)
        await self._store.delete_tokens_link(user_id)
        await self._cache.delete(user_id)
        await self.model_config.detach_tokens_profile(user_id=user_id)
        await self._publish(user_id)
        return {"revoked": revoked}

    # Background.

    async def keep_alive(self) -> None:
        """Refresh links idle long enough that their refresh token could expire."""
        now = _now()
        await self._store.prune_tokens_link_states(before=_iso(now))
        for user_id in await self._store.list_tokens_links_to_refresh(
            refreshed_before=_iso(now - KEEP_ALIVE_AFTER)
        ):
            try:
                await self.access_token(user_id=user_id, force=True)
            except (TokensLinkError, TokensError):
                logger.warning("tokens keep-alive refresh failed user_id={}", user_id)

    async def run_keep_alive(self) -> None:
        while True:
            try:
                await self.keep_alive()
            except SecretBoxUnavailableError:
                pass
            except Exception:  # noqa: BLE001 - try again tomorrow
                logger.exception("tokens keep-alive failed")
            await asyncio.sleep(KEEP_ALIVE_INTERVAL.total_seconds())

    # Internals.

    async def _require_issuer(self) -> str:
        issuer = await self.issuer()
        if issuer is None:
            raise TokensLinkError("tokens_unconfigured", "Tokens Anywhere is not set up on this instance")
        return issuer

    async def _link_issuer(self, user_id: str) -> str:
        link = await self._store.get_tokens_link(user_id)
        if link is None:
            raise TokensLinkError("tokens_not_linked", "link Tokens Anywhere first")
        return link["issuer"]

    async def _tokens_profile(self, user_id: str) -> dict[str, Any]:
        profile = await self._store.find_model_profile_by_source(user_id=user_id, source="tokens")
        if profile is None:
            raise TokensLinkError("tokens_not_synced", "sync Tokens Anywhere first", status_code=404)
        return profile

    def _channels(self) -> ModelChannelService:
        if self.channels is None:
            raise RuntimeError("model channels are not wired to the Tokens link service")
        return self.channels

    def _box_available(self) -> bool:
        try:
            self._secret_box()
        except SecretBoxUnavailableError:
            return False
        return True

    def _box(self) -> SecretBox:
        try:
            return self._secret_box()
        except SecretBoxUnavailableError as exc:
            raise TokensLinkError(exc.code, str(exc)) from exc

    async def _publish(self, user_id: str) -> None:
        if self._broker is None:
            return
        try:
            await self._broker.publish_dashboard(user_id, {"type": "dashboard.changed", "serverTime": _iso(_now())})
        except Exception:  # noqa: BLE001 - a missed push is recovered by the next one
            logger.exception("tokens link dashboard publish failed user_id={}", user_id)
