from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class InstanceSettingsRepositoryMixin:
    async def get_setting(self, key: str, default: str | None = None) -> str | None:
        return await self.instance_settings.get(key, default)


    async def set_setting(self, key: str, value: str) -> None:
        await self.instance_settings.set(key, value)


    async def is_registration_open(self) -> bool:
        value = await self.get_setting(SETTING_REGISTRATION_OPEN)
        return value == "true"


    async def set_registration_open(self, value: bool) -> None:
        await self.set_setting(SETTING_REGISTRATION_OPEN, "true" if value else "false")


    async def is_oauth_registration_open(self) -> bool:
        value = await self.get_setting(SETTING_OAUTH_REGISTRATION_OPEN)
        return value == "true"


    async def set_oauth_registration_open(self, value: bool) -> None:
        await self.set_setting(SETTING_OAUTH_REGISTRATION_OPEN, "true" if value else "false")


    async def get_oauth_provider_config(self) -> dict[str, Any]:
        raw = await self.get_setting(SETTING_OAUTH_PROVIDER)
        value = _json_loads(raw)
        if not isinstance(value, dict):
            return {}
        return value


    async def get_oauth_provider_public_config(self) -> dict[str, Any] | None:
        value = await self.get_oauth_provider_config()
        if not value:
            return None
        return {key: val for key, val in value.items() if key != "clientSecret"}


    async def set_oauth_provider_config(self, patch: dict[str, Any]) -> dict[str, Any] | None:
        current = await self.get_oauth_provider_config()
        if patch.get("clientSecret") == "":
            patch = {key: val for key, val in patch.items() if key != "clientSecret"}
        elif patch.get("clientSecret") is None:
            patch = {key: val for key, val in patch.items() if key != "clientSecret"}
        next_value = {**current, **patch}
        if "enabled" not in next_value:
            next_value["enabled"] = False
        if not next_value.get("provider"):
            next_value["provider"] = "oidc"
        if not next_value.get("label"):
            next_value["label"] = "OAuth"
        await self.set_setting(SETTING_OAUTH_PROVIDER, _json_dumps(next_value))
        return {key: val for key, val in next_value.items() if key != "clientSecret"}


    async def bootstrap_first_admin(
        self,
        *,
        user_id: str,
        password: str | None = None,
        password_hash: str | None = None,
    ) -> UserView | None:
        """Atomic: if user table is empty, create the user as admin and turn registration off.

        Returns the new admin UserView, or None if the table already had users
        (caller should fall back to normal registration logic).
        """
        normalized = self.normalize_user_id(user_id)
        stored_password = password_hash or (hash_password(password) if password else None)
        if not stored_password:
            raise ValueError("password is required")
        now = utc_now()
        async with self._engine.begin() as conn:
            count_row = (
                await conn.execute(select(func.count()).select_from(users_t))
            ).first()
            if int(count_row[0]) > 0:
                return None
            try:
                await conn.execute(
                    insert(users_t).values(
                        id=normalized,
                        password_hash=stored_password,
                        role=ADMIN_ROLE,
                        disabled=0,
                        created_at=now,
                        updated_at=now,
                    )
                )
            except IntegrityError as exc:
                # Lost the race with a concurrent bootstrap.
                raise ValueError("user already exists") from exc
            await self.instance_settings.upsert_on_connection(
                conn,
                SETTING_REGISTRATION_OPEN,
                "false",
                now,
            )
        return await self.get_user(normalized)
