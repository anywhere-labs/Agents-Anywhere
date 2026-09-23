# Production realtime hotfix

Source change: a4e1e762 (relative to ff10cb1e for application files).
Base image: agents-anywhere:cluster-a-c4be624b,
sha256:889e0809bc057de3010e3d85348a80235ad8f52268af77051ece56f8e2b26557.

The production image uses only the five modified Python files, patched against
files extracted from that base image. It does not replace production with current
main. The exact source patch is realtime.patch. Extract /app/server/agent_server
from a stopped base-image container into a build context under
server/agent_server, then apply the patch from that context with git apply.
Copy the five patched files into their corresponding /app/server paths in a
Dockerfile FROM the base image. Include server/scripts/check_realtime_recovery.py
as /app/server/check_realtime_recovery.py for isolated deployment probes.

Run the probe with the existing runtime env file and Python as the entrypoint.
It uses a random channel prefix and disconnects only its own named Redis clients.
Never kill production Redis clients to test recovery.

Final tag: agents-anywhere:realtime-a4e1e762.
All nodes received the same normalized build context. Build-layer metadata differs
on worker-2; both resulting image variants passed the real Redis recovery probe.

Rollback: set AGENTS_ANYWHERE_SERVER_IMAGE in the existing Compose .env back to
agents-anywhere:cluster-a-c4be624b and run compose up -d --no-build --pull never
server, retaining the worker-3 overlay on that host. The previous image and .env
backup remain on each machine. Keep the 14 GiB memory limit. No migration ran.
