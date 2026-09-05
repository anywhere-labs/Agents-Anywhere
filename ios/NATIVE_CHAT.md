# Native chat integration

Base: `codex/ios-api-alignment` at `95693c24`, containing the API, observable
session repository, cache and mobile recovery work on top of current `v2`.
Approved UI reference: the local Untitled Project prototype at `b7ece2a`.

## Integration boundaries

- Keep the existing authentication, account, device management and sidebar.
- Replace the chat placeholder with real session history and runtime actions.
- Reuse the approved Liquid Glass composer, IME handling, Markdown block layout,
  30 Hz presentation clock, glyph reveal and smooth return-to-bottom behavior.
- Keep received session projections separate from displayed rows. Initial history
  and reconnection snapshots must not replay a token animation over old content.
- Use server catalogs, selection IDs, capabilities and notices; no mock replies,
  fake model catalogs or simulated successful actions in the application.
- Build a native New Session page around device, configured runtime and workspace
  selection. Its design is exploratory; it shares the approved composer and
  options sheet instead of copying ChatGPT's home screen.
- Preserve drafts and attachments within their account/session scope. Never
  replay an ambiguous write after connectivity changes.

## Validation

Run production client-core tests headlessly and a single coherent unsigned iOS
build after integration. Do not start a server or simulator; the user runs Xcode.
Record exact results and remaining device checks here before delivery.
