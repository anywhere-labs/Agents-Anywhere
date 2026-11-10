# Agents Anywhere — self-hosted setup plan

Target: **Mac mini `192.168.1.200` = Server**, **Windows PC `192.168.1.2` = Connector (work machine)**,
work from Windows and continue from the mobile app.

---

## Investigation notes (what the repo actually says)

Facts collected with read-only inspection, used to shape the plan:

- **This Mac**: `Peters-Mac-mini`, macOS 26.6.2, `en0` = `192.168.1.200`. **No Docker, no `uv`, no Node** installed yet. Repo is at `/Users/peterlafontaine/Documents/Agents-Anywhere`, branch `main`, clean.
- **Version state**: `main` is unreleased **2.2.0** (schema `v2_47`), and `docs/releases/2.2.0.md` says installers/PyPI/npm are *not published yet*. Latest released tag is **`v2.1.0`** (`git tag --sort=-v:refname` → `v2.1.0`, `v2.0.3`, `v2.0.0`). Download table in `README.md` currently links 2.0.3 packages; in-app update serves the site's current build.
- **Server topology**: the production image (`docker/docker-compose.postgres.yml`) runs PostgreSQL 17 + Redis 8 + a one-shot `migrate-next` + `server-next`, and the FastAPI process serves **the statically exported `web-next` build and `/api/v2` from one origin** on port `8000`, published as `${AGENTS_ANYWHERE_WEB_PORT:-5174}`. This matters because Desktop/iOS "assume a self-hosted server exposes its Web app at the same origin" (`desktop-workbench/README.md`).
- **Desktop does not need CORS** for a self-hosted server: it proxies `/api/v2/*` through Electron Main (`desktop-workbench/electron/main.ts`, `shouldProxyApiPath` / `proxyDesktopApi`). Default `AGENT_SERVER_CORS_ORIGIN_REGEX` is localhost-only, which would otherwise be a problem.
- **Mobile cleartext is already allowed** for LAN HTTP:
  - Android: `android/app/src/main/res/xml/network_security_config.xml` → `cleartextTrafficPermitted="true"`; manifest also sets `usesCleartextTraffic`.
  - iOS: `ios/Agents Anywhere/Info.plist` has `NSAllowsLocalNetworking` **and** explicit `NSExceptionAllowsInsecureHTTPLoads` for `192.168.0.0/16`, `10/8`, `172.16/12`, `127/8`, `169.254/16`, `fc00::/7`, `fe80::/10`, `::1`. **No exception for `100.64.0.0/10`**, i.e. a raw Tailscale IP over plain `http://` is blocked on iOS.
- **Browser-over-HTTP caveat**: the Web UI at `http://192.168.1.200:5174` is *not* a secure context, so `crypto.subtle` is `undefined`. `web-next/src/components/session/session-creation.ts:91` (`sha256Hex`, used when sending attachments) would throw. Desktop (Electron) and the native mobile apps are not affected. A valid HTTPS origin removes this limitation.
- **Bootstrap/auth**: on an empty database the server prints a `setup-token:` banner to stderr (`server/agent_server/core/setup_token.py`, TTL 15 min, regenerated on expiry/restart). The first user created with it becomes admin **and registration is turned off** (`instance_settings_facade.py`).
- **Connector ownership**: one Connector per OS user (`~/.agents-anywhere/connector-runtime.json`); a second configured start exits with code 2. On Windows the Desktop app hides to tray and keeps the Connector running. So the Windows machine should run the **Desktop app only**, not Desktop + CLI connector.
- **Server URL is sticky**: connector config stores the server origin (`connector/README.md` → "do not include `/api/v2`"), and Desktop stores the server in `desktop-server.json`. Changing `http://…` → `https://…` later means re-pairing the connector and re-entering the server on every client.
- **Secrets hygiene**: `.gitignore` ignores `.env.local` and `.env.*.local` but **not** a plain `.env`. Keep deployment env vars outside the repo or in an ignored name.
- **Schema/upgrade discipline**: `migrate-next` runs `... migrations upgrade` before `server-next` starts; never run two different schema-writing Server versions against one database.

Verdict on your split: **it works and is the right shape**. Mac mini as always-on Server, Windows as the machine with projects/tools is exactly the intended deployment (Server = auth/sessions/timeline/forwarding, Connector = executes agents). Scope for this pass: **LAN only** (`http://192.168.1.200:5174`), Tailscale/HTTPS deferred — see [Deferred](#deferred--tailscale--remote-access-later). Adjustments:

1. **Pin the release line** to `v2.1.0` for both server and clients instead of deploying `main` (2.2.0 has no published installers; a 2.0.3/2.1.0 Desktop against a 2.2.0 server is untested territory).
2. **Use the LAN address as the server URL now.** Pair the Windows Connector to `http://192.168.1.200:5174` and accept that the later HTTPS switch costs one connector rebind on Windows plus re-entering the server on each client — that is expected and is spelled out in the deferred section.
3. **No inbound exposure in this pass**: no router port forward, no tunnel. Phones and the PC only work while they are on the same LAN/Wi-Fi, and the Windows Desktop must stay logged in.
4. **Treat the Mac as a small server**: static DHCP lease, no sleep, Docker auto-start, backups — a sleeping Mac mini = everything offline.

---

## Proposed Changes

No source code changes. All changes are host-level configuration plus new files outside the repo (or with ignored names):

| # | Change | Location |
| --- | --- | --- |
| 1 | Install Docker Desktop (Apple Silicon) + enable "start at login", disable system sleep | Mac |
| 2 | Reserve `192.168.1.200` for the Mac mini in the router (DHCP reservation) | Router |
| 3 | Check out the release tag into a separate worktree so `main` stays clean | `~/Documents/aa-server` (git worktree of `v2.1.0`) |
| 4 | Deployment env file (secrets + public origin), name matching `.env.*.local` or kept outside the repo | `~/agents-anywhere/server.env` |
| 5 | *(Later)* Compose override binding the published port to one interface, used when HTTPS lands | `~/agents-anywhere/server.override.yml` |
| 6 | Run PostgreSQL + Redis + migrate + Server behind one origin on `:5174` | Mac, `docker compose -f docker/docker-compose.postgres.yml` |
| 7 | Bootstrap first admin with the `setup-token` from the container log; confirm registration is closed | Web UI `http://192.168.1.200:5174` |
| 8 | Install Windows Desktop 2.1.0 (bundles the Connector + Python/uv), sign in to the self-hosted server, bind the machine | Windows |
| 9 | Install Codex CLI and Claude Code on Windows so the Connector can discover runtimes | Windows (Node LTS + npm global) |
| 10 | Install the mobile app(s) and add the same server + account (LAN only) | Phone |
| 11 | Backup routine (`pg_dump` + files volume) and an upgrade procedure | Mac |

Deliberately **not** doing in this pass: modifying repo files, deploying `main`/2.2.0, editing `docker-compose.postgres.yml` in place, putting secrets inside the repo, exposing the Server to the internet (no port forward, no tunnel). **Tailscale/HTTPS is out of scope here and written down separately** so it can be picked up without re-deriving it.

---

## Step-by-Step Plan

### Phase 0 — Record the decisions (5 min)

Write down, before touching anything:

- Server URL for this pass: **`http://192.168.1.200:5174`** (LAN only). HTTPS/Tailscale is a later phase; record the address you actually used so the re-pair steps stay predictable.
- Release line: **v2.1.0** for Server + Desktop + mobile + Connector.
- Account: which email/password will be the admin (the first user becomes admin, registration closes afterwards; further users are admin-managed).

### Phase 1 — Mac mini as a server (30–45 min)

1. Router: add a DHCP reservation for this Mac's Ethernet MAC → `192.168.1.200`. Prefer wired `en0` over Wi-Fi.
2. Install **Docker Desktop for Apple Silicon**, start it, then:
   - Settings → General → **Start Docker Desktop when you sign in** on.
   - Turn on macOS automatic login for this user (Docker Desktop needs a GUI session; see the alternative below).
   - System Settings → Network → Firewall → allow Docker (and accept the "local network access" prompt).
3. Prevent sleep so the Server stays reachable:
   ```bash
   sudo pmset -a sleep 0 disksleep 0 womp 1
   pmset -g          # verify sleep/standby settings
   ```
   Also check *System Settings → Lock Screen / Battery → prevent automatic sleeping when display is off*.
4. Verify: `docker version`, `docker compose version`, `docker run --rm hello-world`.

> Alternative if you don't want a logged-in GUI session: `brew install colima docker docker-compose` and `brew services start colima` (headless, but slower image builds and slightly more manual). Docker Desktop is the lower-friction path; Colima is the more "server-like" one.

### Phase 2 — Release-tag checkout (5 min)

Keep the existing repo on `main` untouched:

```bash
cd ~/Documents
git -C Agents-Anywhere fetch --tags
git -C Agents-Anywhere worktree add ../aa-server v2.1.0
cd ../aa-server && git describe --tags   # → v2.1.0
```

### Phase 3 — Deployment config (10 min)

Create a secrets/env file **outside** the repo (`~/agents-anywhere/server.env`, mode 600):

```bash
mkdir -p ~/agents-anywhere && cd ~/agents-anywhere
umask 077
cat > server.env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
AGENT_SERVER_SECRET=$(openssl rand -hex 32)
AGENTS_ANYWHERE_WEB_PORT=5174
AGENT_SERVER_PUBLIC_ORIGIN=http://192.168.1.200:5174
REDIS_MAXMEMORY=256mb
EOF
```

Notes:
- `AGENT_SERVER_PUBLIC_ORIGIN` is what OAuth redirects and share links are built from; it must match what clients actually type.
- `AGENT_SERVER_CORS_ORIGINS` is **not** needed: Web is same-origin and Desktop proxies through Electron Main. Only add it if you later split Web/API onto different origins.
- Do not commit this file; it lives outside the repo on purpose.

### Phase 4 — Build and start the Server (20–40 min, mostly build time)

```bash
cd ~/Documents/aa-server
docker compose --env-file ~/agents-anywhere/server.env \
  -f docker/docker-compose.postgres.yml up -d --build
```

This builds `web-next` (static export) + the Python server image, starts PostgreSQL/Redis, runs `migrate-next` (creates schema up to the v2.1.0 revision), then starts `server-next`.

Checks:

```bash
docker compose --env-file ~/agents-anywhere/server.env -f docker/docker-compose.postgres.yml ps
curl -s http://192.168.1.200:5174/api/v2/health
curl -s http://192.168.1.200:5174/api/v2/health/ready
docker compose --env-file ~/agents-anywhere/server.env -f docker/docker-compose.postgres.yml logs migrate-next | tail -20
```

If the API is only reachable via `127.0.0.1`, the port publish got bound to loopback — the compose file publishes `${AGENTS_ANYWHERE_WEB_PORT:-5174}:8000` (all interfaces), so this should not happen; if it does, check macOS firewall first.

### Phase 5 — Bootstrap the admin (5 min)

```bash
docker compose --env-file ~/agents-anywhere/server.env -f docker/docker-compose.postgres.yml logs server-next \
  | grep -A 6 'first-run setup required'
```

Copy the `setup-token: …` value, open `http://192.168.1.200:5174`, choose the self-hosted/bootstrap setup page, create the admin account. Token TTL is 15 minutes; if it expires, call `/api/v2/auth/config` again or restart and re-read the log.

Then in admin settings confirm **registration is closed** (first admin creation turns it off automatically). Add any second account (e.g. a separate phone-only account) explicitly if you want one — otherwise use the same account everywhere.

### Phase 6 — Windows PC as the Connector host (30–45 min)

1. Install prerequisites on Windows:
   - **Node.js LTS** (`winget install OpenJS.NodeJS.LTS`), then
     `npm i -g @openai/codex @anthropic-ai/claude-code`
   - **Git for Windows** (Claude Code's bash tool and general shell work want it on `PATH`).
   - Sign in to Codex / Claude Code once in a normal terminal so their local credentials exist.
2. Install **Agents Anywhere Desktop 2.1.0 (x64)** and launch it.
3. On the login screen expand the self-hosted option, enter `http://192.168.1.200:5174`.
   - The app first calls `GET /api/v2/health` and requires `status: "ok"` with a 10 s timeout; a wrong scheme/path or an HTML page leaves you on the login screen.
   - Complete sign-in (browser-based OAuth with PKCE; the redirect returns to `agents-anywhere-desktop://oauth/callback`).
4. Follow the local-machine onboarding to bind this PC's Connector. Behind the scenes this registers a connector id/token and stores them in the Connector config (`%USERPROFILE%\.agents-anywhere\connector.json`).
5. Wait for the device to show **online** and for Codex / Claude Code to appear as available runtimes (they are discovered from `PATH`; if a runtime is missing, restart the app so it picks up the updated login-shell environment).
6. Add your project folder(s) as projects (drag a folder onto the sidebar), create a session, send a task.
7. Keep the app running in the tray. Do **not** additionally start a CLI Connector on the same Windows user (it would be refused with "connector already running", and mixing launch paths is unsupported).

Windows Firewall: no inbound rules needed — the Connector dials out to the Server.

### Phase 7 — Mobile (10 min)

1. Install the app: Android APK, or iOS/iPadOS from the App Store (TestFlight optional).
2. Add the server `http://192.168.1.200:5174`, sign in with the same account.
3. Verify the device from Phase 6 appears online and its sessions are visible.

LAN HTTP is fine for both apps (Android allows cleartext globally; iOS explicitly excepts `192.168.0.0/16`). Outside the LAN the address is simply unreachable — that limitation is accepted for this pass and removed in the deferred Tailscale phase.

### Phase 8 — Durability, updates, backups (20 min)

- **Autostart**: Docker Desktop autostart + `restart: unless-stopped` in the compose services covers container restarts. Verify by rebooting the Mac once and re-running the Phase 4 health checks.
- **Backups** (nightly via `launchd`/`cron`), covering all three stateful volumes:
  ```bash
  docker compose --env-file ~/agents-anywhere/server.env -f docker/docker-compose.postgres.yml \
    exec -T postgres-next pg_dump -U agents_anywhere agents_anywhere | gzip > ~/agents-anywhere/backups/pg-$(date +%F).sql.gz
  # files volume (uploads/attachments)
  docker run --rm -v agents-anywhere_agents-anywhere-files-next:/data:ro -v ~/agents-anywhere/backups:/out \
    alpine tar czf /out/files-$(date +%F).tar.gz -C /data .
  ```
  Redis is *not* a rebuildable cache: it carries accepted-but-unflushed Timeline writes (AOF `everysec`), so treat a Redis volume loss as possible recent-data loss and keep the AOF volume in backups too.
- **Upgrade**: stop nothing else, but back up first, then
  ```bash
  cd ~/Documents/aa-server && git fetch --tags && git checkout <new-tag>
  docker compose --env-file ~/agents-anywhere/server.env -f docker/docker-compose.postgres.yml up -d --build
  docker compose … logs migrate-next   # confirm the migration applied before server-next starts
  ```
  Never run an old and a new Server image against the same database at the same time; upgrade the Windows Desktop to the same release line so Connector and Server match.
- **Logs**: `docker compose … logs -f server-next` (setup tokens, auth errors); Desktop logs on Windows under `%APPDATA%\Agents Anywhere\logs`.

---

## Deferred — Tailscale / remote access (later)

Not part of this setup. Kept here so the later switch is mechanical and so you know what it will cost.

1. Install Tailscale on the Mac, Windows and phone, all in the same tailnet:
   ```bash
   brew install tailscale          # or the App Store build
   sudo tailscale up
   sudo tailscale set --operator=$USER
   tailscale serve --bg https:443 http://127.0.0.1:5174
   tailscale serve status          # → https://<host>.<tailnet>.ts.net
   ```
   This yields a **publicly-trusted certificate** on a MagicDNS name in front of the same-origin app — which is what iOS ATS and browser secure contexts require. A raw `http://100.x.y.z` is *not* usable on iOS (`100.64.0.0/10` has no ATS exception).
2. Update the env file and restart only the server:
   `AGENT_SERVER_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net`, then
   `docker compose --env-file ~/agents-anywhere/server.env -f docker/docker-compose.postgres.yml up -d server-next`.
3. Expect a **one-time rebind**: enter the new address on Windows Desktop (its onboarding rewrites the connector binding) and on each mobile client. If a connector was started by hand: `anywhere-cli configure --server-url https://<host>… --connector-id … --connector-token …`, then restart it.
4. Optional, once TLS terminates on the Mac: stop publishing `:5174` to the LAN via an override file instead of editing the repo file:
   ```yaml
   # ~/agents-anywhere/server.override.yml
   services:
     server-next:
       ports: ["127.0.0.1:5174:8000"]
   ```
   and append `-f ~/agents-anywhere/server.override.yml` to the compose command.
5. Then verify: `https://<host>.<tailnet>.ts.net/api/v2/health` → 200 from cellular, cert trusted with no profile install, `AGENT_SERVER_PUBLIC_ORIGIN` matches the HTTPS origin used in share links and OAuth redirects.

Alternative: Cloudflare Tunnel with your own domain. Same HTTPS benefits, but the instance becomes reachable from the public internet (auth still required) — a different trade-off than the tailnet-only Tailscale option.

---

## Verification Strategy

Run these in order; each has an expected result. Everything is on the real devices — there is no headless shortcut for install/OAuth/mobile behavior.

**A. Server up (Mac)**
1. `curl -s http://192.168.1.200:5174/api/v2/health` → HTTP 200, JSON, `"status": "ok"`.
2. `curl -s http://192.168.1.200:5174/api/v2/health/ready` → ready (DB + Redis reachable).
3. `docker compose … ps` → `postgres-next`, `redis-next`, `server-next` up; `migrate-next` exited 0.
4. `docker compose … logs migrate-next | tail` → target revision matches the v2.1.0 tag's `CURRENT_SCHEMA_REVISION`.
5. `curl -s http://192.168.1.200:5174/ | head` → the Web app HTML (not an error page). Important: a reverse proxy or wrong dir can return 200 with HTML from `/api/v2/health` too — always check the JSON body, not just the status.

**B. Reachability from the other devices**
6. On Windows PowerShell: `curl.exe -i http://192.168.1.200:5174/api/v2/health` → 200 JSON.
7. On the phone browser (LAN): the same URL renders the Web UI login page.
8. From the Mac: `nc -z 192.168.1.200 5174` succeeds; confirm the port is not bound to `127.0.0.1` only (`lsof -nP -iTCP:5174 -sTCP:LISTEN`).

**C. Admin and auth**
9. Setup token from the log creates the first admin; afterwards `GET /api/v2/auth/config` reports `registrationOpen: false`.
10. Sign out / sign in again on the Web UI succeeds (proves `AGENT_SERVER_SECRET` is stable and persisted, not regenerated per container).

**D. Connector round-trip (the real proof)**
11. Windows Desktop shows the device **online** and Codex + Claude Code as runtimes.
12. Create a session in a project on `D:\...` and send a message → reply streams in the Windows Desktop UI.
13. Open the same session on the phone → same timeline; send a follow-up from the phone → it executes on Windows and appears in the Desktop timeline (bidirectional, ~live).
14. Trigger an approval (e.g. a command that needs confirmation) → the card appears on the phone, approving it unblocks the run on Windows.
15. Open a terminal from a client → interactive shell on Windows; browse a project file and download it.
16. Upload an attachment from **Desktop** and from the **phone app** (both are fine over LAN HTTP). If you also test the **browser** at `http://192.168.1.200:5174`, an attachment send may fail because `crypto.subtle` is unavailable in a non-secure context — expected on plain HTTP; it is fixed when the deferred HTTPS phase lands.

**E. Resilience**
17. Reboot the Mac → wait for Docker Desktop → `docker compose … ps` all up (no manual command), session list still loads, the Windows Connector reconnects and shows online without restarting Desktop.
18. Put the Windows PC to sleep for a few minutes, wake it → the device returns online and queued messages arrive.
19. Restart `server-next` only → clients reconnect (WebSocket ticket renewal), no data loss in the timeline.
20. Kill the phone's network, send a message from Windows, restore the network → the phone catches up.

**F. Backup/restore drill**
21. Take a `pg_dump` + files-volume backup, spin a second compose project (`-p aa-restore`) from the same backup, and confirm a created session and an uploaded file are present. Restore is the only check that proves your backups are usable.

**G. LAN-only behavior (expected, not a bug)**
22. Phone off Wi-Fi (cellular) → clients fail to reach the server and show connection errors. That is the accepted scope of this pass; do not "fix" it with a port forward — the deferred Tailscale phase replaces it.

**Version alignment check** (do this once after both sides are installed): Desktop/Connector version from the app's About screen and the server tag must be in the same release line (2.1.0 ↔ v2.1.0). A mismatch is the most likely source of "feature missing" and "capability differs" reports.

**Explicitly out of scope for these checks** (state them when reporting success): any off-LAN access (deferred), real OAuth callback over HTTPS on physical iOS/Android devices, long-run stability (multi-day streaming load), multi-user permission behavior, and anything Android/iOS-build related (CI does not cover mobile, and this setup does not build them).

---

## Risk / caveat summary

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Deploying `main` (2.2.0) with 2.1.0 clients | Unreleased protocol features, no published connectors | Deploy tag `v2.1.0`; upgrade both sides together later |
| Mac sleeps or reboots without Docker autostart | All clients offline, Connector retries | `pmset sleep 0`, Docker autostart, auto-login, reboot test |
| DHCP hands out a different IP | Connector and clients point at nothing | Router reservation for `192.168.1.200` |
| Changing the server URL when Tailscale lands | One connector rebind on Windows + re-login on each client | Accepted; steps are pre-written in the Deferred section |
| Plain HTTP in a browser | `crypto.subtle` missing → attachment hashing fails in Web UI | Use Desktop/mobile for attachments; HTTPS comes with the deferred phase |
| No off-LAN access in this pass | Phone/laptop useless outside the house | Accepted scope; Tailscale phase later (raw `100.64/10` HTTP is ATS-blocked on iOS, so it must be the MagicDNS HTTPS name) |
| Losing the Redis volume | Possible loss of recently accepted Timeline writes | Keep AOF volume in backups; never treat Redis as disposable |
| Running Desktop + CLI Connector on the same Windows user | "connector already running", mixed ownership | Desktop only; one Connector per OS user |
| Secrets in the repo | Credential leak | Env file outside the repo, `git status` clean before/after |
