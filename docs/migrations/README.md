# Migration Documentation

This directory contains operator and client migration guides. Migration guides
describe released or code-backed behavior transitions. Refactor plans and target
architecture documents remain under `docs/runtime-protocol/` and `docs/api/`.

## Active migration set

- [Main to v2](./main-to-v2/README.md): coordinated migration from the current
  `main` deployment model to the v2 Server, Connector, and client contracts.
- [Event recovery v2](./event-recovery-v2.md): durable event recovery contract.
- [Legacy storage v2.3](./legacy-storage-v2_3.md): historical v2.3 removal of
  legacy Server storage. Later revisions are covered by the main-to-v2 guide.

Start with the main-to-v2 overview. Its deployment and acceptance documents are
the release gates; the component documents explain how to update code and data.
