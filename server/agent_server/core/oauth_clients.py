from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class FirstPartyOAuthClient:
    client_id: str
    name: str
    redirect_uri: str
    client_secret: str | None = field(default=None, repr=False)

    def allows_redirect(self, uri: str) -> bool:
        if self.client_id != "agents-anywhere-dsh-plugin":
            return uri == self.redirect_uri
        # Native loopback ports are allocated by the OS. Keep the host, path
        # and scheme exact; no credentials, queries, fragments or DNS names.
        match = re.fullmatch(
            r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/oauth/callback", uri
        )
        return match is not None and 1024 <= int(match[1]) <= 65535


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
)

FIRST_PARTY_OAUTH_CLIENTS = {
    client.client_id: client
    for client in (MOBILE_OAUTH_CLIENT, DESKTOP_OAUTH_CLIENT, DSH_PLUGIN_OAUTH_CLIENT)
}


def first_party_oauth_client(client_id: str) -> FirstPartyOAuthClient | None:
    if client_id == "tokens-anywhere":
        secret = os.environ.get("AGENT_SERVER_TOKENS_ANYWHERE_CLIENT_SECRET", "")
        redirect = os.environ.get("AGENT_SERVER_TOKENS_ANYWHERE_REDIRECT_URI", "")
        if not secret and not redirect:
            return None
        uri = urlsplit(redirect)
        if (
            len(secret) < 32
            or len(os.environ.get("AGENT_SERVER_SECRET", "")) < 32
            or uri.scheme != "https"
            or not uri.hostname
            or uri.username is not None
            or uri.password is not None
            or uri.query
            or uri.fragment
            or any(char.isspace() for char in redirect)
        ):
            raise ValueError(
                "Tokens Anywhere OAuth requires strong secrets and an exact HTTPS callback URL"
            )
        return FirstPartyOAuthClient(
            client_id="tokens-anywhere",
            name="Tokens Anywhere",
            redirect_uri=redirect,
            client_secret=secret,
        )
    return FIRST_PARTY_OAUTH_CLIENTS.get(client_id)
