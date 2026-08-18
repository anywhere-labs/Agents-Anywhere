# DSH Bridge Protocol 1.0

These schemas and fixtures define the line-level JSON-RPC contract shared by the
Agents Anywhere Connector and `@agents-anywhere/dsh-bridge`. Transport tests own
UTF-8 framing, newline handling, and the 8 MiB frame limit.

Protocol `1.x` may add optional fields and notifications. Runtime IDs, required
fields, method semantics, error codes, and identity algorithms require a major
version when changed incompatibly.
