"""Stable Server-side routing for the versioned Connector MeshCall contract."""

import hashlib

REMOTE_SERVICE_DOMAINS = (
    "Connection",
    "RuntimeControl",
    "Sessions",
    "Workspaces",
    "Files",
    "Shell",
    "Terminals",
)

CONTROL_METHODS: dict[str, tuple[str, str]] = {
    "runtime.discover": ("RuntimeControl", "discover"),
    "runtime.configSchema": ("RuntimeControl", "configSchema"),
    "runtime.config": ("RuntimeControl", "config"),
    "runtime.validateConfig": ("RuntimeControl", "validateConfig"),
    "runtime.probeModelConnection": ("RuntimeControl", "probeModelConnection"),
    "runtime.start": ("RuntimeControl", "start"),
    "runtime.stop": ("RuntimeControl", "stop"),
    "runtime.capabilities": ("RuntimeControl", "capabilities"),
    "runtime.commands": ("RuntimeControl", "commands"),
    "runtime.modelCatalog": ("RuntimeControl", "modelCatalog"),
    "runtime.permissionCatalog": ("RuntimeControl", "permissionCatalog"),
    "session.discover": ("Sessions", "discover"),
    "session.create": ("Sessions", "create"),
    "session.sync": ("Sessions", "sync"),
    "session.state": ("Sessions", "state"),
    "session.capabilities": ("Sessions", "capabilities"),
    "session.notices": ("Sessions", "notices"),
    "session.selections.update": ("Sessions", "updateSelections"),
    "session.commands": ("Sessions", "commands"),
    "session.command.execute": ("Sessions", "executeCommand"),
    "session.send_message": ("Sessions", "sendMessage"),
    "session.steer": ("Sessions", "steer"),
    "session.interrupt": ("Sessions", "interrupt"),
    "interaction.respond": ("Sessions", "respondInteraction"),
    "session.goal.get": ("Sessions", "getGoal"),
    "session.goal.execute": ("Sessions", "executeGoal"),
    "session.goal.operation": ("Sessions", "goalOperation"),
    "session.goal.forget": ("Sessions", "forgetGoals"),
    "session.planning.get": ("Sessions", "getPlanning"),
    "session.planning.execute": ("Sessions", "executePlanning"),
    "session.planning.operation": ("Sessions", "planningOperation"),
    "session.configuration.get": ("Sessions", "getConfiguration"),
    "session.configuration.update": ("Sessions", "updateConfiguration"),
    "session.creation.begin": ("Sessions", "beginCreation"),
    "session.creation.get": ("Sessions", "getCreation"),
    "session.creation.respond": ("Sessions", "respondCreation"),
    "session.creation.cancel": ("Sessions", "cancelCreation"),
    "interaction.response.get": ("Sessions", "getInteractionResponse"),
    "session.tree": ("Sessions", "tree"),
    "session.position.select": ("Sessions", "selectPosition"),
    "session.close": ("Sessions", "close"),
    "session.recover": ("Sessions", "recover"),
    "session.agent.operate": ("Sessions", "operateAgent"),
    "workspace.refresh": ("Workspaces", "refresh"),
    "workspace.prepare": ("Workspaces", "prepare"),
    "workspace.preparation.get": ("Workspaces", "getPreparation"),
    "workspace.preparation.refresh": ("Workspaces", "refreshPreparation"),
    "workspace.preparation.cancel": ("Workspaces", "cancelPreparation"),
    "workspace.preparation.respond": ("Workspaces", "respondPreparation"),
    "workspace.preparation.reserve": ("Workspaces", "reservePreparation"),
    "fs.prepareDownload": ("Files", "prepareDownload"),
    "fs.uploadPreparedDownload": ("Files", "uploadPreparedDownload"),
    "fs.writeFile": ("Files", "writeFile"),
    "fs.readDir": ("Files", "readDir"),
    "fs.readText": ("Files", "readText"),
    "shell.exec": ("Shell", "execute"),
    "shell.task.start": ("Shell", "startTask"),
    "shell.task.cancel": ("Shell", "cancelTask"),
    "terminal.create": ("Terminals", "create"),
    "terminal.write": ("Terminals", "write"),
    "terminal.resize": ("Terminals", "resize"),
    "terminal.close": ("Terminals", "close"),
    "terminal.rename": ("Terminals", "rename"),
    "terminal.setPersistent": ("Terminals", "setPersistent"),
    "terminal.list": ("Terminals", "list"),
    "terminal.release": ("Terminals", "release"),
    "terminal.snapshot": ("Terminals", "snapshot"),
    "terminal.relay.connect": ("Terminals", "connectRelay"),
}


def service_prefix(connector_id: str, connection_id: str, link_id: str = "") -> str:
    identity = hashlib.sha256(f"{connector_id}:{connection_id}:{link_id}".encode()).hexdigest()
    return f"aa.remote.v1.c{identity}"


def service_names(connector_id: str, connection_id: str, link_id: str = "") -> dict[str, str]:
    prefix = service_prefix(connector_id, connection_id, link_id)
    return {
        domain: f"{prefix}.{domain}" for domain in REMOTE_SERVICE_DOMAINS
    }
