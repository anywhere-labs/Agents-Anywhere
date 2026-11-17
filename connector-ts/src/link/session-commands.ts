// Slash command catalog per session: each time the Runtime reports commands.updated (ACP
// available_commands_update), the session layer emits it as a runtime.status fact through LiveEvents. The
// composition root keeps the latest one per session; the client API reads it.
export { MAX_COMMAND_CATALOGS, SessionCommandCatalog, type SessionCommand } from '../sync/client-api/commands.js'
