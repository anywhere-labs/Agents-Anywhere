# Cluster A

See runtime-maintenance-2026-09-26.json for the latest rollout state, exact image,
backup location and validation results. MIGRATION.md, migration-state.json and
deployed.json retain earlier migration and deployment snapshots.

Six Docker workers bind HTTP to 127.0.0.1:8000, including the static Web UI,
API and WebSockets. All six workers each run eight FastAPI processes using their
compose.worker-N.yml overlays. Each application process has one extra
event-preparation worker (48 across the cluster). All containers have a 14 GiB
memory limit. PostgreSQL and Redis run on 192.168.1.35 and accept LAN traffic only.
All workers must share their database,
Redis, token secret and S3 configuration; instance IDs differ by node.

The 48 application processes allow at most 432 pooled PostgreSQL connections:
workers 1 and 2 each allow 5 persistent + 2 overflow connections per process;
workers 3 through 6 each allow 5 persistent + 5 overflow. This requires
PostgreSQL `max_connections` of at least 500, leaving 68 connections for
administration and other consumers under the configured 500-connection limit.
Do not start workers 5 and 6 while db-1 still uses 300. Redis requires AOF with
appendfsync everysec and maxmemory-policy noeviction because it buffers accepted
Timeline writes.

Build one image from a committed release and distribute that exact image to all
workers. Release archives live under /root/code/github/Agents-Anywhere-releases/<release> on each node.
Copy .env.example to .env, fill credentials, and chmod 600 .env. Never commit it.
Run commands in this directory:

```sh
docker compose --profile migration run --rm migrate
docker compose up -d server
docker compose ps
curl -f http://127.0.0.1:8000/api/v2/health/ready
```

Run the migration once before starting either worker on a fresh database. For
updates, follow docs/upgrading.md; do not mix incompatible writer versions.

Use the public S3 endpoint with virtual host addressing: attachment open URLs
are presigned using the configured endpoint and must be reachable by browsers.
No public origin is configured until the external routing domain is chosen.
DNS distribution alone does not provide an HTTP health-checking load balancer.

The HTTP port is intended for the separately managed TLS ingress. After ingress
is ready, restrict direct access to that ingress if required by the deployment.

Before starting Docker services, install worker-access.nft as
/etc/nftables.d/aa-worker-access.nft and worker-access.service as
/etc/systemd/system/aa-worker-access.service, then enable it with
systemctl enable --now aa-worker-access.service. The Compose bind allows only host-local access. As defense in depth, the ingress
filter also drops external TCP 8000 traffic. These independent
nftables rules run before Docker DNAT and also block IPv6 ingress to that port.
