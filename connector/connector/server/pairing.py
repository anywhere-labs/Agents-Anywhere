from __future__ import annotations

from urllib.parse import urlparse

import httpx

from connector.server.urls import api_v2_url


async def resolve_pair_server_url(
    value: str | None,
    *,
    timeout: float = 10,
    missing_message: str = "server is required",
) -> str:
    if not value:
        raise ValueError(missing_message)
    normalized = value.strip().rstrip("/")
    if not normalized:
        raise ValueError(missing_message)

    parsed = urlparse(normalized)
    if parsed.scheme:
        if parsed.scheme in {"http", "https"}:
            return normalized
        if "://" in normalized:
            raise ValueError("server URL must use http or https")

    candidates = [f"https://{normalized}", f"http://{normalized}"]
    errors: list[str] = []
    for candidate in candidates:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(f"{candidate}/api/v2/health")
                if response.status_code < 500:
                    return candidate
                errors.append(f"{candidate}: HTTP {response.status_code}")
        except httpx.RequestError as exc:
            errors.append(f"{candidate}: {exc}")
    joined = "; ".join(errors)
    raise ValueError(f"could not reach server over https or http ({joined})")


async def start_pairing(
    client: httpx.AsyncClient,
    server_url: str,
    timeout: float,
) -> dict[str, object]:
    response = await client.post(
        api_v2_url(server_url, "/pairing/start"),
        json={"serverUrl": server_url, "ttlSeconds": int(timeout)},
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("pairing start response must be an object")
    return payload


async def poll_pairing(
    client: httpx.AsyncClient,
    server_url: str,
    pairing_id: str,
) -> dict[str, object]:
    response = await client.post(
        api_v2_url(server_url, "/pairing/poll"),
        json={"pairingId": pairing_id},
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("pairing poll response must be an object")
    return payload
