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
    "workspace.refresh": ("Workspaces", "refresh"),
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


def service_prefix(connector_id: str, connection_id: str) -> str:
    identity = hashlib.sha256(f"{connector_id}:{connection_id}".encode()).hexdigest()
    return f"aa.remote.v1.c{identity}"


def service_names(connector_id: str, connection_id: str) -> dict[str, str]:
    prefix = service_prefix(connector_id, connection_id)
    return {
        domain: f"{prefix}.{domain}" for domain in REMOTE_SERVICE_DOMAINS
    }
