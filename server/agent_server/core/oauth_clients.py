from __future__ import annotations

import re
from dataclasses import dataclass

# Native loopback ports are allocated by the OS. Keep the host, path and scheme
# exact; no credentials, queries, fragments or DNS names.
_LOOPBACK_REDIRECT_RE = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/oauth/callback")


def allows_loopback_redirect(uri: str) -> bool:
    """Accept only an exact ``127.0.0.1`` callback on an unprivileged port.

    Shared by every first-party client that binds an ephemeral local port (the
    DSH and OpenCode plug-in client ids) so the boundary stays identical.
    """

    match = _LOOPBACK_REDIRECT_RE.fullmatch(uri)
    return match is not None and 1024 <= int(match[1]) <= 65535


@dataclass(frozen=True)
class FirstPartyOAuthClient:
    client_id: str
    name: str
    redirect_uri: str
    loopback: bool = False

    def allows_redirect(self, uri: str) -> bool:
        if self.loopback:
            return allows_loopback_redirect(uri)
        return uri == self.redirect_uri


MOBILE_OAUTH_CLIENT = FirstPartyOAuthClient(
    client_id="agents-anywhere-mobile",
    name="Agents Anywhere Mobile",
    redirect_uri="agents-anywhere://oauth/callback",
)

DESKTOP_OAUTH_CLIENT = FirstPartyOAuthClient(
    client_id="agents-anywhere-desktop",
    name="Agents Anywhere Desktop",
    redirect_uri="agents-anywhere-desktop://oauth/callback",
)

DSH_PLUGIN_OAUTH_CLIENT = FirstPartyOAuthClient(
    client_id="agents-anywhere-dsh-plugin",
    name="Agents Anywhere DSH Plugin",
    redirect_uri="http://127.0.0.1:{port}/oauth/callback",
    loopback=True,
)

OPENCODE_PLUGIN_OAUTH_CLIENT = FirstPartyOAuthClient(
    client_id="agents-anywhere-opencode-plugin",
    name="Agents Anywhere OpenCode Plugin",
    redirect_uri="http://127.0.0.1:{port}/oauth/callback",
    loopback=True,
)

FIRST_PARTY_OAUTH_CLIENTS = {
    client.client_id: client
    for client in (
        MOBILE_OAUTH_CLIENT,
        DESKTOP_OAUTH_CLIENT,
        DSH_PLUGIN_OAUTH_CLIENT,
        OPENCODE_PLUGIN_OAUTH_CLIENT,
    )
}


def first_party_oauth_client(client_id: str) -> FirstPartyOAuthClient | None:
    return FIRST_PARTY_OAUTH_CLIENTS.get(client_id)


def device_grant_oauth_client(client_id: str) -> FirstPartyOAuthClient | None:
    """The only first-party client allowed to use the device grant.

    Mobile and desktop sign in through their own redirect URIs, so the device
    authorization grant stays scoped to the OpenCode client id.  Any other
    client id, first-party or not, is treated as unknown by the device
    endpoints.

    Note: the OpenCode runtime no longer ships a plug-in to start this flow --
    the connector attaches to the host's own service and pairs with a connector
    token.  The grant and its approval page remain for a native initiator.
    """

    client = first_party_oauth_client(client_id)
    return client if client is OPENCODE_PLUGIN_OAUTH_CLIENT else None
