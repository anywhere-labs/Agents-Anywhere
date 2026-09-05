# iOS API alignment

Backend baseline: `origin/v2` at `c1913284` (2026-09-05).

This change aligns the native client's transport, typed resources, and business
services before the next UI implementation. The existing navigation and pages
remain the presentation baseline.

## Contract boundaries

- Authentication and account identity follow the current email account contract.
- Connector discovery distinguishes runtime types from configured instances.
  Instance creation sends a name, configuration, and the requested active state
  in one request; catalog requests target the selected instance.
- Session metadata and creation carry the runtime type and instance separately.
  History, runtime state, capabilities, selections, notices, takeover, sync, and
  attachments use their current resource endpoints.
- Dashboard and session updates use single-use WebSocket tickets. Session event
  recovery retains the server cursor and snapshot-required signal. Unknown
  extension events remain available to the future UI reducer.
- File browsing preserves structured RPC errors and supports native text reads
  alongside the existing web preview flow.
- Retired session/runtime calls belong in `_deprecated`, outside the app target.

Terminal, Connector execution, server administration, and a new presentation
implementation are outside this client-core alignment.

## Validation approach

Add headless Swift tests that compile the production client core, intercept real
URLSession requests, and decode fixtures produced by the current Python backend
models. Verify request methods, namespaced paths, query/body shapes, runtime
identity, nullable selections, error responses, and WebSocket frames without
starting a server or simulator. Record the final results and handoff here.
