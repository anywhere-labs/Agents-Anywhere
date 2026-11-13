from __future__ import annotations


class ConnectorNetworkError(RuntimeError):
    """Network failure while talking to the Agents Anywhere backend."""

    code = "connector_network_error"
    retryable = True


class ConnectorIngestClosedError(RuntimeError):
    """The notification queue has been closed without a specific failure."""
