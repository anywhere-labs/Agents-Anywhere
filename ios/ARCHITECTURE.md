# iOS v2 Client Architecture

The iOS v2 client separates wire values, account-scoped state and presentation:

```text
SwiftUI views
        |
        v
Observable session / chat / New Session models
        |
        v
Session repository and projection (session workflows)
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

## State and presentation

`V2ClientServices` owns one normalized server/account/credential lifetime. It
constructs the services, session repository, connectivity monitor and
`NewSessionModel`. `AppState` routes authentication, dashboard updates and app
lifecycle changes into that scope. Signing out invalidates retained observable
models and cancels their outstanding work.

`Repositories` owns coalesced reads, subscriptions, in-memory caches, authoritative
session projections and event recovery. `Models/Session` exposes stable
`@MainActor @Observable` session, runtime and timeline references for SwiftUI.
The repository publishes local pending sends through the same observation stream
as network updates. Views never own a second session socket or network reducer.

`Models/Chat` adds UI-specific ownership without changing wire DTOs:

- `ComposerDraft` owns text, attachments and composition state. Session and New
  Session drafts remain scoped independently from transient view instances.
- `SessionChatModel` coordinates actual message, attachment, selection and notice
  actions through the existing repository and services.
- `SessionTimelinePresentation` receives repository projections and publishes
  stable rendered rows at 30 Hz. Its idle clock sleeps. Initial/recovered history
  and live token appends have distinct presentation semantics.
- `SessionNoticeStore` owns stable form drafts and response submission state;
  authoritative runtime notices determine blocking and completion.
- `NewSessionModel` calls device/preparation/creation services directly and owns
  the selected device/Agent pair, account-scoped preferences, preflight checks
  and uncertain-creation protection.

`Views/Chat` contains native SwiftUI layouts, the persistent UIKit text editor
bridge, sheet/picker presentation and Textual Markdown rendering. Theme colors
come from the existing `AppTheme`. See [NATIVE_CHAT.md](NATIVE_CHAT.md) for UI
behavior, protocol support, verified checks and manual device validation.

## Migration boundary

Retired session/runtime API methods, models and the chat placeholder live in
`ios/_deprecated`, outside the application target. The remaining `APIClient`
facade supports the existing shell through `V2ClientServices`; new session and
runtime features use the typed resources and scoped services directly. Do not
restore legacy routes or introduce view-owned transport/cache implementations.
