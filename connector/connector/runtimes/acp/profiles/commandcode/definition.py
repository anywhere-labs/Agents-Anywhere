"""Command Code's installed ACP CLI."""

from ...domain.agents import AcpAgentDefinition, Executable
from ...domain.dialect import AcpDialect

PERMISSION_MODE = "command-code-permission-mode"


class CommandCodeDialect(AcpDialect):
    """Command Code exposes its permission policy through ACP session modes."""

    def __init__(self):
        self.modes: dict[str, dict] = {}
        self.options: dict[str, list[dict]] = {}

    def verify_session(self, session_id, result):
        modes = result.get("modes")
        if modes and modes.get("availableModes"):
            self.modes[session_id] = {
                "id": PERMISSION_MODE,
                "name": "Permission mode",
                "category": "permission",
                "type": "select",
                "currentValue": modes["currentModeId"],
                "options": [
                    {"value": mode["id"], "name": mode["name"]}
                    for mode in modes["availableModes"]
                ],
            }

    def adapt_configuration(self, session_id, options):
        self.options[session_id] = options
        mode = self.modes.get(session_id)
        if mode and not any(option.get("category") == "permission" for option in options):
            return [*options, mode]
        return options

    def translate_update(self, session_id, update):
        mode = self.modes.get(session_id)
        if update.get("sessionUpdate") == "current_mode_update" and mode:
            self.modes[session_id] = {**mode, "currentValue": update["currentModeId"]}
            return {
                "sessionUpdate": "config_option_update",
                "configOptions": self.options.get(session_id, []),
            }
        return update

    async def configure(self, client, session_id, key, value):
        if key != PERMISSION_MODE:
            return None
        await client.connection.set_session_mode(session_id=session_id, mode_id=value)
        self.modes[session_id] = {**self.modes[session_id], "currentValue": value}
        return client.configuration[session_id]

COMMAND_CODE = AcpAgentDefinition(
    runtime_type="commandcode",
    display_name="Command Code",
    # npm publishes cmdc on every platform. cmd can resolve to cmd.exe on Windows.
    executable=Executable(
        "cmdc",
        candidates=("~/.local/bin/cmdc",),
        windows_npm_entry="command-code/dist/index.mjs",
    ),
    arguments=("--no-auto-update", "acp"),
    check=("--no-auto-update", "acp", "--help"),
    version=("--version",),
    native_inventory=False,
    dialect=lambda _context: CommandCodeDialect(),
)
