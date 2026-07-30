# Protocol 1.0 Contract

The Server Pydantic wire models are the source of truth for these artifacts.
Files under `schemas/` and `manifest.json` are generated and must not be edited
by hand.

Regenerate the contract from the repository root:

```bash
cd server
uv run python -m scripts.export_protocol_schemas
```

The `fixtures/valid` and `fixtures/invalid` directories are reviewed compatibility
examples shared by the Server, Connector, and Web test suites. Extensible
capability identifiers and catalog metadata remain strings and JSON objects;
only well-known identifiers may enable product behavior.

Protocol version `1.0` is independent of the application version and database
schema revision.
