from __future__ import annotations


class ConnectorNetworkError(RuntimeError):
    """Network failure while talking to the Agents Anywhere backend."""

    code = "connector_network_error"
    retryable = True
