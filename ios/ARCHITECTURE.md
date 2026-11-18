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
It does not know sessions, runtimes, or UI state. The project defaults to
`MainActor` isolation; the transports, `V2RealtimeAPI` and every wire type in
`Domain` are declared `nonisolated`, so HTTP responses and socket frames decode
off the main actor and arrive on it already typed. Keep new DTOs `nonisolated`.

## API

`Agents Anywhere/API/V2` maps one method to one Server resource. Request and
response bodies use explicit domain models from `Agents Anywhere/Domain`.
The API layer does not validate user workflows or mutate app state.

The initial resource clients are:

- `V2ProjectAPI`
- `V2ConnectorAPI`
- `V2SessionAPI`
- `V2RuntimeAPI`
- `V2AttachmentAPI`
- `V2ModelConfigAPI`
- `V2RealtimeAPI`

## Business

`Agents Anywhere/Business` composes API calls into user-visible operations:

- `V2DashboardService` loads connector/project/paginated-session resources and opens dashboard
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

`Repositories` owns coalesced reads, subscriptions, memory/disk caches, authoritative
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
  stable rendered rows once the previous reveal batch ends (about every 257 ms,
  roughly 4 Hz; text after a pause publishes at once). Its idle clock sleeps. Initial/recovered history
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

## Projects, startup and device setup

`V2DashboardRepository` is the canonical project/device/session list. Global active,
archived and project lists each own a cursor. A revision fence prevents late HTTP
reads from undoing dashboard pushes or explicit mutations; expanded page membership
survives replacement of the global first page. Counts belong to the server.

`V2RestorationStore` holds the last navigation destination and a profile bound to
the saved server and credential fingerprint. The token stays in Keychain;
`AppState` keeps an in-memory copy so view bodies never perform a Keychain read.
`V2LocalStore` serializes versioned, bounded archives off the main actor, with
atomic writes, iOS data protection and backup exclusion. Launch reads local state
before rendering the restored page; profile validation, dashboard refresh and
session recovery run afterwards. Connectivity failures keep that page available.
Only a definitive authentication rejection transitions to signed out.
Protocol 1.2 offline reads (`deviceOffline`, `historySource: unavailable`) never
replace retained content or move its cursor; an offline read without retained
content is not a baseline and is not archived. `session.catchup_required`, the
device returning online and live timeline frames received while history was
unavailable recover from the repository's own cursor. Signing out invalidates
the store synchronously and deletes every account's directory; signing in
removes other accounts' directories. Rules: [session cache](../docs/session-cache.md).

`DeviceAgentModel` distinguishes available types from configured instances.
`AgentSetupCoordinator` owns pending pairing observations at account scope, so
closing the pairing form cannot cancel discovery. Phone offline/background states
pause its reads; returning online resumes them. Configuration changes use native
controls and refresh instance inventory after uncertain outcomes before retry.

`NewSessionSubmission` stages a local navigation destination and user bubble before
creation. The creation response binds the same client message and attachment
previews to the server ID. The local destination never makes session API requests.
Normal sends stage before upload; accepted, confirmed and uncertain are distinct.
No persisted record is an automatic write outbox.

## Model configuration

The dashboard snapshot carries every runtime instance (with its maturity, model
connection capability and status, and write-only `secretFields`) and the
`modelConfig` overview, including the channel state (`modelConfig.channel`):
the current channel, each runtime's override, desired and actual channel, and
its switch progress. `V2DashboardRepository` keeps the latest pushed values;
`ModelConfigModel` issues single requests through `V2ModelConfigAPI`. Channel
writes (current channel, per-runtime override, switch now, retry) answer with
the channel state, which the page shows until the next push replaces it; an
answer older than the latest push is dropped. `ChannelPresentation` groups
runtimes by device, sets apart runtimes without a model connection, and counts
the switch summary. Rows render from the channel state and declared
capabilities only. Keys are write-only: the runtime configuration sheet never
shows a saved gateway key, an empty key keeps it on the same origin,
and a new address needs it again. `TokensLinkCoordinator` opens the Tokens
Anywhere link in `ASWebAuthenticationSession` and closes it once a snapshot
shows the new link, because the flow never calls back into the app.
Once linked, the page shows the Anywhere account: `TokensAccountModel` reads
the account, balance and usage on request (again when the app returns to the
foreground), edits a draft of the pushed model choices and saves it in one
request. `TokensAccountPresentation` sums yuan amounts as integer
ten-thousandths, never as floating point.

## Port preview

Preview 1.0 (`contracts/preview/1.0`) lives under `/api/v3/previews`;
`V3PreviewAPI` names that path itself and the HTTP transport passes `/api/v3`
paths through instead of adding `/api/v2`. `port.listening` (the device's whole
list) and `port.closed` arrive on the session socket; the repository hands them
to `V2SessionModel.listeningPorts`, keeping only this session's ports, before
any recovery logic, so they never acknowledge or move the cursor. A device
going offline clears the list. `PortPreviewStore` (account scope) creates a
preview on demand and exchanges a fresh one-time ticket for every open, which
`SessionPortPreviewCard` shows in `SFSafariViewController`; a 404 or
`preview_disabled` hides the card for the rest of the app run.

## End-to-end encryption (e2ee 1.0)

`Network/E2EE` implements the client side of `contracts/e2ee/1.0`; every
primitive comes from CryptoKit. `NoiseHandshake` and friends are the Noise state
machine (S8). `E2EEFormats` holds the byte formats (client ID, fingerprint,
prologues, framing, display envelopes, sealed segments, input digests, the
`aa-pair://` link) and is pinned by `aa-formats.json`. `E2EETransportSession`
fragments, rekeys (2^20 frames or one hour, only between messages) and checks
frame counters. `ClientSecureChannel` is an actor: frames from the tunnel reach
it in order through one reader task, and it encrypts synchronously before
handing frames to `E2EETunnelLink.send`, which keeps their order, so nonces
cannot be reordered by actor reentrancy. It sends nothing before `ready`.

`ClientTrustStore` keeps the client identity key, each device's pinned key and
directory key, and the sticky "this device requires encryption" policy in the
Keychain (`AfterFirstUnlockThisDeviceOnly`, never synchronized). Only an
in-channel `close` from the device (revoked / not paired) drops a pin; a
`ClientTunnelEnd` relayed by the Server is reported (`E2EEError.fromDevice ==
false`) and never changes trust records or policy.

`URLSessionE2EETunnel` multiplexes routes on `WS /api/v3/tunnel` after a
`POST /api/v2/ws-ticket {scope: {dashboard: true}}`. `V2E2EEService` reads the
Server mode from `auth/config`, pairs, reconnects with KK and chooses each
device's transport: `route(for:)`, `transport(for:plain:)` (an `HTTPTransport`
that existing API resources accept), `sessionEvents(...)` and `sendCommand(...)`
(which registers the input digest first).

Every API resource except account and E2EE bookkeeping shares one
`E2EERoutingHTTPTransport`. It classifies each request like the Server's
required-mode gate (`E2EEContentTarget`): metadata, including `/api/v3`
resources such as port previews, goes out as plain HTTP;
session content (everything under `/sessions/{id}/` except `meta`,
`runtime/state` and `runtime/capabilities`), session creation and device files,
shell and terminals ask `V2E2EEService.route(for:)` with the session's
`connectorId` (dashboard first, else the plaintext `meta`). The answer is plain,
the secure channel (30-second timeout, `e2ee_timeout`; writes register a
command first) or an error such as `e2ee_not_paired`, which the session page
turns into a pairing entry; plaintext is never sent then.
`E2EERoutingRealtimeAPI` swaps the session WebSocket for the channel's
`subscribe` and emits `session.subscribed` itself so the repository recovers as
usual. In an encrypted route, attachment uploads are sealed per file (random
key, sealed segments with the plaintext SHA-256 as object ID) and sent with
`x-aa-sealed: segments-v1` as `attachment.bin` / `application/octet-stream`;
the keys, real names and media types stay in memory (a restart means sealing
and uploading again) and travel inside the
channel as `sealedAttachmentKeys` in the body of the message that references
the files. Device files download chunk by chunk through the channel
(`TunnelFileChunk`). Attachments of user messages are read from the device
through the channel with `GET /sessions/{id}/blobs/{fileId}`, the same chunked
route as timeline blobs (below). Download URLs, file previews and renaming
(`displayUser` sealed with the directory key) are refused in encrypted routes
until the Server supports them.

## Timeline blobs

On v3 devices large content fields of a timeline item live in the device's blob
store; the item keeps a preview or placeholder and lists them in `blobRefs`
(JSON pointer into `content`, `blobId`, size, media type). `V2AttachmentService`
reads `GET /sessions/{id}/blobs/{ref}` in 4 MiB chunks until `eof`, checking
offset and total size, and refuses blobs above the caller's limit before
downloading them. The route is session content, so it goes through the secure
channel in encrypted routes. `SessionBlobStore` (per chat model) loads a ref on
request and keeps a bounded copy: text up to 4 MiB replaces the tool output
preview or shows in a code panel, images up to 20 MiB show as a thumbnail that
opens the full image, anything else or larger opens as a file (up to 64 MiB).

Session lists and pages show the protocol 1.2 display envelopes
(`displayDevice`, `displayUser`). `V2SessionDisplayResolver` (account scope) opens
them where sessions enter `V2DashboardRepository` (HTTP inventory, dashboard
push, PATCH answers, cache restore) and in the observations
`V2SessionRepository` publishes, and writes the result into `title` / `cwd`, so
views and file browsing read them as before. An envelope whose `mode` is neither
`plain` nor `sealed` counts as absent. Normal mode prefers plain envelopes
and keeps the Server's fields they omit. Once any envelope is sealed, only sealed
ones count: the AD uses the session's `connectorId` and the slot of its field,
the key is the device's current-epoch directory key. The title is the opened
`displayUser.title` (a `displayUser` that does not open never falls back to the
device's title), else the opened `displayDevice.title`; `cwd` comes only from an
opened `displayDevice`, never from the Server's plaintext. When any envelope
does not open the session is locked and an unknown title shows the locked
placeholder. Opened payloads are cached in memory per (session, slot,
`keyId`, payload); `ClientTrustStore.observeDevices` (pairing, a new
`e2ee.directory_key`, forgetting a device) makes both repositories resolve
again. A session without a project whose sealed `displayDevice` opened is
matched to a project of the same device (exact path, else the longest
whole-segment prefix; only `X:\` paths ignore case) and assigned with
`PATCH /sessions/{id}/meta {projectId}`; each session is sent at most once per
app run and failures only reach the debug log.

## Migration boundary

Retired session/runtime API methods, models and the chat placeholder live in
`ios/_deprecated`, outside the application target. The remaining `APIClient`
facade supports the existing shell through `V2ClientServices`; new session and
runtime features use the typed resources and scoped services directly. Do not
restore legacy routes or introduce view-owned transport/cache implementations.
