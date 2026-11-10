# Agents Anywhere — self-hosted server (this Mac)

Server: `http://192.168.1.200:5174` (Web + API on one origin, LAN only).
Source: `/Users/peterlafontaine/Documents/aa-server` (git worktree, tag `v2.1.0`).
Secrets: `~/agents-anywhere/server.env` (mode 600) — never commit.

## Stack

```bash
cd ~/Documents/aa-server
COMPOSE="docker compose --env-file $HOME/agents-anywhere/server.env -f docker/docker-compose.postgres.yml"
$COMPOSE up -d                 # start (postgres + redis + migrate + server)
$COMPOSE ps                    # status; port 5174 published on all interfaces
$COMPOSE logs -f server-next   # server log (also: setup-token banner)
$COMPOSE down                  # stop, keep data volumes
```

Container engine is **Docker Desktop** 4.98 (context `desktop-linux`, 8 CPU / 4 GB VM).
`docker context ls` must show `desktop-linux *` — if the CLI ever points elsewhere, run
`docker context use desktop-linux`.

Docker Desktop must be running as a logged-in GUI session (`open -a Docker`). Enable
*Settings → General → Start Docker Desktop when you sign in* plus macOS automatic login so
the stack survives a reboot without manual steps.

Migrated from Colima on 2026-11-06: PostgreSQL dump + files snapshot were restored into
the Docker Desktop volumes and verified (schema `v2_44`, 27 tables). The pre-migration
artifacts are kept in `~/agents-anywhere/migration/`; the Colima VM was deleted.

## Health

```bash
curl -s http://192.168.1.200:5174/api/v2/health        # {"status":"ok","version":"2.1.0"}
curl -s http://192.168.1.200:5174/api/v2/health/ready  # database schemaVersion 2.44 + redis ok
```

## Backups

```bash
~/agents-anywhere/backup.sh                  # now: pg dump + files/redis volume snapshots
ls -lh ~/agents-anywhere/backups/            # pg-*.sql.gz, files-*.tar.gz, redis-aof-*.tar.gz
tail ~/agents-anywhere/backups/backup.log    # nightly run log (LaunchAgent, 03:00)
launchctl print gui/$UID/com.agentsanywhere.backup | head -5
```

The LaunchAgent inherits the docker context from `~/.docker/config.json`; there is no
`DOCKER_HOST` override (that was only needed for Colima).

Retention is 14 days. Restore of `pg-*.sql.gz` into a scratch `postgres:17-alpine`
container was verified (27 tables, `alembic_version = v2_44`).

## Upgrade

```bash
~/agents-anywhere/backup.sh
cd ~/Documents/aa-server
git fetch --tags
git checkout <new-tag>        # attach HEAD to the tag, e.g. v2.2.0 once released
cd ~/Documents/aa-server && docker compose --env-file $HOME/agents-anywhere/server.env \
  -f docker/docker-compose.postgres.yml up -d --build
docker compose ... logs migrate-next | tail   # confirm schema revision before server-next
```

Never run an old and a new Server image against the same database at once. Upgrade the
Windows Desktop/Connector to the same release line.

## Later: Tailscale HTTPS (deferred, deliberately not set up)

```bash
brew install tailscale && sudo tailscale up
sudo tailscale set --operator=$USER
tailscale serve --bg https:443 http://127.0.0.1:5174
```

Then set `AGENT_SERVER_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net` in `server.env`,
restart `server-next`, and re-enter the new address on Desktop + mobile (one-time connector
rebind). Use the MagicDNS HTTPS name — iOS blocks plain HTTP to `100.64.0.0/10`.

## Known trade-offs in this pass

- LAN only: no port forward, no tunnel. Off-LAN clients cannot connect.
- Docker Desktop needs a logged-in GUI session; without automatic login the stack stays down
  after a reboot even though the containers are set to `restart: unless-stopped`.
- Web UI over plain HTTP is not a secure context → `crypto.subtle` is missing, so sending
  attachments from a *browser* may fail. Desktop and the mobile apps are unaffected.
- macOS automatic login and sleep settings must be set by the user (`pmset`, router
  DHCP reservation) — they need sudo / router access.



