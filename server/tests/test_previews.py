"""Port preview control plane (``contracts/preview/1.0``): API, device commands, frps plugin, preview-auth."""

from __future__ import annotations

import asyncio
import json

import fakeredis
import httpx
import pytest
from device_link_helpers import eventually, offline, server, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import LinkError
from agent_server.core.e2ee_settings import E2eeSettings
from agent_server.core.preview_access import COOKIE_NAME
from scripts.v3_fake_device import connect_device

DOMAIN = "preview.test"
TOKEN = "t" * 40


@pytest.fixture
def preview_env(monkeypatch):
    monkeypatch.setenv("AGENT_SERVER_PREVIEW_DOMAIN", DOMAIN)
    monkeypatch.setenv("AGENT_SERVER_PREVIEW_INTERNAL_TOKEN", TOKEN)
    monkeypatch.delenv("AGENT_SERVER_PREVIEW_FRPS_ADDR", raising=False)


def _proxy(slug: str, login: str, preview_token: str, preview_id: str, **extra) -> dict:
    return {
        "content": {
            "user": {"user": "", "metas": {"token": login}, "run_id": "r1"},
            "proxy_name": slug,
            "proxy_type": "http",
            "subdomain": slug,
            "metas": {"previewId": preview_id, "previewToken": preview_token},
            **extra,
        }
    }


def test_previews_open_through_the_device_and_frps(mesh_router: RouterProcess, monkeypatch, preview_env) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)

            def handle(method: str, p: dict):
                if method == "preview.open" and p["port"] == 9999:
                    return LinkError(code="preview_port_not_allowed", message="nothing listens")
                return {"previewId": p.get("previewId"), "port": p.get("port"), "localIP": "127.0.0.1"}

            device.state.command_handler = handle
            plugin = f"/api/v3/internal/preview/frps/{TOKEN}"
            try:
                created = await client.post(
                    "/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 5173}
                )
                assert created.status_code == 200, created.text
                preview = created.json()
                slug = preview["slug"]
                assert preview["state"] == "open" and preview["url"] == f"https://{slug}.{DOMAIN}"
                assert preview["plaintextNotice"] is False
                method, sent = device.state.command_log[-1]
                assert method == "preview.open" and sent["slug"] == slug and sent["port"] == 5173
                assert sent["frpsAddr"] == f"wss://frp.{DOMAIN}"
                frp_token = sent["frpToken"]

                # frps: login and the proxy registration check the Server's token.
                login = await client.post(f"{plugin}?op=Login", json={"op": "Login", "content": {"metas": {"token": frp_token}}})
                assert login.json() == {"reject": False, "unchange": True}
                forged = await client.post(f"{plugin}?op=Login", json={"content": {"metas": {"token": frp_token + "x"}}})
                assert forged.json()["reject"] is True
                assert (await client.post("/api/v3/internal/preview/frps/wrong?op=Login", json={})).status_code == 404
                good = _proxy(slug, frp_token, frp_token, preview["previewId"])
                assert (await client.post(f"{plugin}?op=NewProxy", json=good)).json()["reject"] is False
                hijack = _proxy(slug, frp_token, frp_token, preview["previewId"], custom_domains=["aa.example.com"])
                assert (await client.post(f"{plugin}?op=NewProxy", json=hijack)).json()["reject"] is True
                other = _proxy("aaaaaaaaaa", frp_token, frp_token, preview["previewId"])
                assert (await client.post(f"{plugin}?op=NewProxy", json=other)).json()["reject"] is True

                # Reopening the same port keeps the id and the slug.
                again = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 5173})
                assert again.json()["previewId"] == preview["previewId"] and again.json()["slug"] == slug

                # A one-time ticket becomes the preview cookie once.
                ticket = await client.post(f"/api/v3/previews/{preview['previewId']}/ticket", headers=headers)
                assert ticket.status_code == 200
                ticket_url = ticket.json()["ticketUrl"]
                assert ticket_url.startswith(f"https://{slug}.{DOMAIN}/__aa/ticket?t=")
                code = ticket_url.split("t=", 1)[1]
                internal = {"Authorization": f"Bearer {TOKEN}"}
                redeemed = await client.post(
                    "/api/v3/internal/preview/redeem", headers=internal, json={"ticket": code, "slug": slug}
                )
                assert redeemed.status_code == 200, redeemed.text
                assert redeemed.json()["cookie"] and redeemed.json()["maxAge"] <= 8 * 3600
                replay = await client.post(
                    "/api/v3/internal/preview/redeem", headers=internal, json={"ticket": code, "slug": slug}
                )
                assert replay.status_code == 403
                assert (
                    await client.post("/api/v3/internal/preview/redeem", json={"ticket": code, "slug": slug})
                ).status_code == 401

                # The device refuses a port it cannot share; the preview does not stay open.
                refused = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 9999})
                assert refused.status_code == 409 and refused.json()["detail"]["code"] == "preview_port_not_allowed"

                # At most eight open previews per device.
                for port in range(3000, 3007):
                    opened = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": port})
                    assert opened.status_code == 200, opened.text
                full = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 4000})
                assert full.status_code == 409 and full.json()["detail"]["code"] == "preview_limit_reached"
                listed = (await client.get("/api/v3/previews", headers=headers)).json()["previews"]
                assert len(listed) == 8

                # The port stops listening: the preview closes and frps refuses it from then on.
                await app.state.previews.on_device_event(device_id, "port.closed", {"deviceId": device_id, "port": 5173})
                closed = await app.state.store.get_preview(preview["previewId"])
                assert closed["state"] == "closed" and closed["closeReason"] == "port_closed"
                assert (await client.post(f"{plugin}?op=NewProxy", json=good)).json()["reject"] is True
                gone = await client.post(f"/api/v3/previews/{preview['previewId']}/ticket", headers=headers)
                assert gone.status_code == 404

                # Stopping one sends preview.close.
                stop = await client.delete(f"/api/v3/previews/{listed[1]['previewId']}", headers=headers)
                assert stop.status_code == 200 and stop.json()["state"] == "closed"
                assert stop.json()["closeReason"] == "user_closed"
                assert device.state.command_log[-1][0] == "preview.close"
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.rpc, device_id))
            down = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 8080})
            assert down.status_code == 409 and down.json()["detail"]["code"] == "connector_offline"

            # Offline past the grace period: the sweeper closes what is left.
            service = app.state.previews
            start = service._clock()
            assert await service.sweep() == 0
            service._clock = lambda: start + 601
            assert await service.sweep() >= 1
            assert (await client.get("/api/v3/previews", headers=headers)).json()["previews"] == []

    asyncio.run(scenario())


def test_previews_are_hidden_without_a_preview_domain(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_PREVIEW_DOMAIN", raising=False)

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, _token = await user_and_device(app, client)
            response = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 5173})
            assert response.status_code == 404
            assert response.json()["detail"]["code"] == "preview_domain_not_configured"

            monkeypatch.setenv("AGENT_SERVER_PREVIEW_DOMAIN", DOMAIN)
            monkeypatch.setenv("AGENT_SERVER_PREVIEW_INTERNAL_TOKEN", TOKEN)
            app.state.e2ee_settings = E2eeSettings(mode="required", preview="deny")
            denied = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 5173})
            assert denied.status_code == 404 and denied.json()["detail"]["code"] == "preview_disabled"

            # A v2 Connector cannot run frpc.
            app.state.e2ee_settings = E2eeSettings(mode="required")
            v2 = await client.post("/api/v3/previews", headers=headers, json={"deviceId": device_id, "port": 5173})
            assert v2.status_code == 409 and v2.json()["detail"]["code"] == "device_upgrade_required"

    asyncio.run(scenario())


def test_port_events_reach_the_session_socket_and_new_subscribers(preview_env) -> None:
    from conftest import make_test_client

    from agent_server.core.auth import create_user_access_token

    with make_test_client() as client:
        app = client.app
        store = app.state.store
        user = client.portal.call(lambda: store.create_user(user_id="user_pv", password="password-pv"))
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        device_id = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()["connector"]["id"]
        client.post(
            "/projects", headers=headers, json={"connectorId": device_id, "name": "repo", "workspacePath": "/repo"}
        ).raise_for_status()
        client.portal.call(lambda: store.set_connector_link_contract(device_id, "device-meshcall/1.0"))
        session = client.portal.call(
            lambda: store.upsert_connector_session(
                connector_id=device_id, session_id="sess_pv", runtime="codex", runtime_id="codex",
                external_session_id="thr_pv", title="t", cwd="/repo", last_activity_at=None,
            )
        )
        previews = app.state.previews

        def ticket() -> str:
            return client.post(
                "/ws-ticket", headers=headers, json={"clientId": "web_pv", "scope": {"sessionId": session.id}}
            ).json()["ticket"]

        listening = {
            "deviceId": device_id,
            "ports": [
                {"port": 5173, "pid": 1, "processName": "node", "sessionId": session.id},
                {"port": 8000, "pid": 2, "processName": "python", "sessionId": "sess_other"},
            ],
        }
        with client.websocket_connect(f"/sessions/{session.id}/ws?ticket={ticket()}&protocol=1.2") as ws:
            assert ws.receive_json()["type"] == "session.subscribed"
            client.portal.call(previews.on_device_event, device_id, "port.listening", listening)
            event = ws.receive_json()
            assert event["type"] == "port.listening" and event["sequence"] == 0
            assert [p["port"] for p in event["payload"]["ports"]] == [5173]

        # A new subscriber hears what is listening right away.
        with client.websocket_connect(f"/sessions/{session.id}/ws?ticket={ticket()}&protocol=1.2") as ws:
            assert ws.receive_json()["type"] == "session.subscribed"
            replay = ws.receive_json()
            assert replay["type"] == "port.listening" and replay["payload"]["ports"][0]["port"] == 5173
            client.portal.call(previews.on_device_event, device_id, "port.closed", {"deviceId": device_id, "port": 5173})
            closed = ws.receive_json()
            assert closed["type"] == "port.closed" and closed["payload"]["port"] == 5173
            # Listening again after a close is delivered too.
            client.portal.call(previews.on_device_event, device_id, "port.listening", listening)
            assert ws.receive_json()["type"] == "port.listening"
            # The device goes offline: its ports are gone.
            client.portal.call(previews.on_presence, device_id, False)
            assert ws.receive_json()["payload"]["ports"] == []


def test_preview_auth_checks_cookies_locally_and_redeems_tickets(preview_env) -> None:
    from agent_server.core.preview_access import COOKIE, sign, state_key
    from agent_server.preview_auth.app import create_app

    redis = fakeredis.FakeAsyncRedis()
    slug = "abcdefghij"
    host = f"{slug}.{DOMAIN}"
    now = [1_000_000.0]
    redeem_calls: list[dict] = []

    def server_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        body = json.loads(request.content)
        redeem_calls.append(body)
        if body["ticket"] != "good":
            return httpx.Response(403, json={"detail": {"code": "preview_ticket_invalid"}})
        cookie = sign(TOKEN, COOKIE, {"s": slug, "u": "user_1", "p": "pv_1", "exp": int(now[0] + 3600)})
        return httpx.Response(200, json={"cookie": cookie, "maxAge": 3600})

    server = httpx.AsyncClient(transport=httpx.MockTransport(server_handler), base_url="http://server")
    app = create_app(redis=redis, server=server, clock=lambda: now[0])

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://auth") as client:
            def verify(cookie: str | None = None, **extra) -> httpx.Response:
                headers = {"X-Forwarded-Host": host, **extra}
                if cookie is not None:
                    headers["Cookie"] = cookie
                return client.get("/verify", headers=headers)

            # Unknown or closed slug.
            closed = await verify(None, **{"Sec-Fetch-Mode": "navigate"})
            assert closed.status_code == 404
            await redis.set(
                state_key("agents-anywhere", slug),
                json.dumps({"previewId": "pv_1", "userId": "user_1", "visibility": "private", "exp": now[0] + 7200}),
            )
            app.state.auth._cache.clear()

            # No cookie: a navigation goes to sign-in, a module request gets 401.
            nav = await verify(None, **{"Sec-Fetch-Mode": "navigate"})
            assert nav.status_code == 302
            assert (await verify(None, **{"Sec-Fetch-Mode": "cors"})).status_code == 401

            # Ticket -> cookie -> requests pass without calling the Server.
            bad = await client.get("/__aa/ticket", params={"t": "bad"}, headers={"X-Forwarded-Host": host})
            assert bad.status_code == 403
            good = await client.get("/__aa/ticket", params={"t": "good"}, headers={"X-Forwarded-Host": host})
            assert good.status_code == 302 and good.headers["location"] == "/"
            set_cookie = good.headers["set-cookie"]
            assert set_cookie.startswith(f"{COOKIE_NAME}=")
            for attribute in ("Secure", "HttpOnly", "SameSite=Lax", "Path=/"):
                assert attribute in set_cookie
            value = set_cookie.split(";", 1)[0].split("=", 1)[1]
            calls = len(redeem_calls)
            for _ in range(20):
                ok = await verify(f"{COOKIE_NAME}={value}; theme=dark")
                assert ok.status_code == 204
                assert ok.headers["x-aa-cookie"] == "theme=dark"
            assert len(redeem_calls) == calls

            # The cookie belongs to its slug.
            other = await client.get(
                "/verify", headers={"X-Forwarded-Host": f"zzzzzzzzzz.{DOMAIN}", "Cookie": f"{COOKIE_NAME}={value}"}
            )
            assert other.status_code == 404

            # Closing the preview (its Redis key goes) shuts it within the cache window.
            await redis.delete(state_key("agents-anywhere", slug))
            now[0] += 4
            assert (await verify(f"{COOKIE_NAME}={value}")).status_code == 404

            # A link preview needs no cookie.
            await redis.set(
                state_key("agents-anywhere", slug),
                json.dumps({"previewId": "pv_1", "userId": "user_1", "visibility": "link", "exp": now[0] + 60}),
            )
            now[0] += 4
            assert (await verify(None)).status_code == 204
            now[0] += 120
            assert (await verify(None)).status_code == 404

    asyncio.run(scenario())
