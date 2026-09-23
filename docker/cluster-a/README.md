# Cluster A

See MIGRATION.md and migration-state.json for the current production migration and
application readiness state. deployed.json is the earlier alpha snapshot.

Four Docker workers bind HTTP to 127.0.0.1:8000, including the static Web UI,
API and WebSockets. All four workers each run eight FastAPI processes using their compose.worker-N.yml overlays. Each application process has one extra
event-preparation worker (32 across the cluster). All containers have a 14 GiB
memory limit. PostgreSQL and Redis run on 192.168.1.35 and accept LAN traffic only.
All workers must share their database,
Redis, token secret and S3 configuration; instance IDs differ by node.

The 32 application processes allow at most 272 pooled PostgreSQL connections:
workers 1 and 2 each allow 5 persistent + 2 overflow connections per process;
workers 3 and 4 each allow 5 persistent + 5 overflow. This leaves 28 connections
under the configured 300-connection server limit. Redis requires AOF with appendfsync everysec and
maxmemory-policy noeviction because it buffers accepted Timeline writes.

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
