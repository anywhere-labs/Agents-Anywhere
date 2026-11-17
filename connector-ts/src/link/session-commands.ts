// Slash command catalog per session: each time the Runtime reports commands.updated (ACP
// available_commands_update), the session layer emits it as a runtime.status fact through LiveEvents. The link
// keeps the latest one per session for `catalogs.commands` in Runtime/catalogs; the client API reads the same one.
export { MAX_COMMAND_CATALOGS, SessionCommandCatalog, type SessionCommand } from '../sync/client-api/commands.js'
