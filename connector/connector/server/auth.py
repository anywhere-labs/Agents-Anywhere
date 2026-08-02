from __future__ import annotations

ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 60.0


class ConnectorAuthenticationError(RuntimeError):
    """Connector credentials are invalid or revoked; do not retry."""
