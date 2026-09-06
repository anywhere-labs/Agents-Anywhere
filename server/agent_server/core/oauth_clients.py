from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FirstPartyOAuthClient:
    client_id: str
    name: str
    redirect_uri: str


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

FIRST_PARTY_OAUTH_CLIENTS = {
    client.client_id: client
    for client in (MOBILE_OAUTH_CLIENT, DESKTOP_OAUTH_CLIENT)
}


def first_party_oauth_client(client_id: str) -> FirstPartyOAuthClient | None:
    return FIRST_PARTY_OAUTH_CLIENTS.get(client_id)
