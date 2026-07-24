"""Generic ACP (Agent Client Protocol) transport for multi-agent support."""

from connector.acp.adapter import AcpAdapter
from connector.acp.manifest import AgentManifest, load_builtin_manifests

__all__ = ["AcpAdapter", "AgentManifest", "load_builtin_manifests"]
