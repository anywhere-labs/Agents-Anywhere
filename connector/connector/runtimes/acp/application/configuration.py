from dataclasses import asdict

from ..domain.configuration import ConfigurationSnapshot


class ConfigurationService:
    def __init__(self, store):
        self.store = store

    def snapshot(self, scope_id: str) -> ConfigurationSnapshot:
        data = self.store.get("configuration", scope_id) or {}
        return ConfigurationSnapshot(
            tuple(data.get("options", [])), data.get("revision", 0)
        )

    def observe(self, scope_id: str, options: list[dict]) -> dict:
        # ACP reserves its category enum. AA's provider-independent selection
        # category travels in namespaced metadata and survives SDK validation.
        normalized = []
        for option in options:
            category = option.get("_meta", {}).get("aa", {}).get("selectionCategory")
            normalized.append(
                {
                    **option,
                    **(
                        {"category": category}
                        if category in {"model", "permission", "effort"}
                        else {}
                    ),
                }
            )
        snapshot = self.snapshot(scope_id).replace_options(normalized)
        self.store.put("configuration", scope_id, asdict(snapshot))
        return {"revision": snapshot.revision, "options": list(snapshot.options)}

    async def update(
        self, scope_id: str, agent_session_id: str, client, values: dict
    ) -> dict:
        self.snapshot(scope_id).validate(values)
        for key, value in values.items():
            # Every response replaces the entire current configuration; retain
            # already applied options if a later request fails.
            response = await client.configure(agent_session_id, key, value)
            with self.store.transaction():
                self.observe(scope_id, response.get("configOptions", []))
        return {
            "revision": self.snapshot(scope_id).revision,
            "options": list(self.snapshot(scope_id).options),
        }
