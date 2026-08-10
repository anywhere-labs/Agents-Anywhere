# iOS v2 Client Architecture

The iOS v2 client uses one-way dependencies:

```text
SwiftUI / AppState
        |
        v
Business use-case services
        |
        v
Typed API resources
        |
        v
HTTP and WebSocket transports
```

## Network

`Agents Anywhere/Network` owns URL construction, authentication injection,
JSON transport, multipart upload, raw WebSocket frames, and transport errors.
It does not know sessions, runtimes, or UI state.

## API

`Agents Anywhere/API/V2` maps one method to one Server resource. Request and
response bodies use explicit domain models from `Agents Anywhere/Domain`.
The API layer does not validate user workflows or mutate app state.

The initial resource clients are:

- `V2ConnectorAPI`
- `V2SessionAPI`
- `V2RuntimeAPI`
- `V2AttachmentAPI`
- `V2RealtimeAPI`

## Business

`Agents Anywhere/Business` composes API calls into user-visible operations:

- `V2DashboardService` loads connector/session resources and opens dashboard
  updates.
- `V2SessionDetailService` hydrates a session, pages timeline history, sends or
  steers messages, interrupts work, changes selections, and recovers events.
- `V2SessionCreationService` validates and creates new sessions, including the
  pre-session inline attachment exception.
- `V2AttachmentService` owns session-scoped upload/download behavior.
- `V2RuntimeInteractionService` owns live catalogs, capabilities, commands,
  and notice responses.

Business services return domain values or throw explicit errors. They do not
own SwiftUI state, caching, navigation, or optimistic timeline reduction.

## Migration rule

The existing `APIClient` remains only while current views are migrated. New v2
features must depend on `V2ClientServices`; they must not add more session or
runtime methods to the old client. Once all call sites use the new services,
the legacy session/runtime models and methods can move to `_deprecated` and be
removed.
