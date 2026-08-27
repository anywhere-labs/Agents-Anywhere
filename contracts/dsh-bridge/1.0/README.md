# DSH Bridge Protocol 1.0

These schemas and fixtures define the line-level JSON-RPC contract shared by the
Agents Anywhere Connector and `@agents-anywhere/dsh-bridge`. Transport tests own
UTF-8 framing, newline handling, and the 8 MiB frame limit.

Protocol `1.x` may add optional fields and notifications. Runtime IDs, required
fields, method semantics, error codes, and identity algorithms require a major
version when changed incompatibly.

Optional create-time work-mode support uses capability `catalog.agent_preset`,
method `catalog.listAgentPresets`, `session.createAndStart.params.agentPreset`,
and the read-only `agentPreset` field on Session meta/state.

Model catalogs may mark at most one model and one reasoning item within that
model as `default`. These flags project DSH's current default selection and the
Connector forwards them unchanged to AA clients.

Existing Session model changes use `session.updateSelections` with the complete
opaque model `selectionId` from the catalog. The Connector forwards that ID
unchanged. A successful Bridge response may normalize a base model selection to
the provider's concrete default reasoning effort; its returned `selections` map
is authoritative for the AA Session state. Failed updates do not change AA's
stored selection state.
