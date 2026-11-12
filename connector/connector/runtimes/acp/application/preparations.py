class SessionPreparation:
    """Default ACP preparation transfers the already opened Agent session."""

    async def prepare(self, context):
        return await context["client"].open_session(context["workspace"].canonical_path)

    async def activate(self, context, session_id):
        return None
