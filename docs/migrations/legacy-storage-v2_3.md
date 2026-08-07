# Legacy Storage Removal (`v2_3`)

Schema revision `v2_3` makes `notices` the only durable Interaction store.
Connector approval prompts now enter the Server as `notice.upsert` interactions;
`approval.requested` is rejected. The reverse response transport is the runtime
protocol `interaction.respond` Connector RPC and is not a persistence contract.

## Upgrade behavior

Before the `approvals` table is removed, every Approval row is converted into
or merged with its stable Approval Interaction notice. The migration preserves
the Connector request identity under `context.approvalSource`, including
`requestId`, so a pending interaction remains actionable after deployment.

The migration then removes:

- the `approvals` table;
- archived v1 catalog/settings tables;
- `connectors.runtime_capabilities`;
- `sessions.runtime_settings_override`.

Required v1 source values were archived by `v2_2` in
`legacy_import_archive`. That archive remains durable. Mobile compatibility
responses may still contain an `approvals` field, but it is projected from open
Approval Interaction notices and is no longer stored separately.

Run the normal explicit migration command before starting the Server:

```bash
uv run python -m agent_server.infra.db.migrations upgrade
```

Downgrade is intentionally unsupported because it would recreate superseded
sources of truth.
