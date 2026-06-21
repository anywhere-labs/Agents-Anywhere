# web-next Frontend Component Architecture

This document is for the frontend team that will continue the `web-next`
rewrite. It explains the product domains, component boundaries, API
dependencies, pure frontend behavior, and mock-data shape needed to build a
modular and pluggable frontend.

The goal has changed: `web-next` should preserve the current product behavior
and backend-driven workflows, but it no longer needs pixel-level visual parity
with the old `web/` frontend. The frontend should be built from shadcn/Radix
primitives and local business components composed on top of them.

The extracted demo in `_reference/demo-shadcn` is now the preferred reference
for layout and component composition. The old `web/` app remains the reference
for business behavior, route coverage, edge cases, and backend contracts.

How to use this document:

- Start from a business domain section and copy its API list into the domain
  API/mock implementation.
- Build the listed core components as reusable pieces before composing the page.
- Implement pure frontend behavior in hooks or feature modules, not inside
  visual components.
- Use the mock-data checklist to create fixture states before polishing visuals.
- Prefer shadcn primitives and demo composition patterns before introducing new
  custom shells.

## Goals

- Rebuild the frontend as composable business modules rather than page-local UI.
- Keep pages thin: route files choose the domain screen; domain modules own data,
  orchestration, and UI composition.
- Treat backend API shape as the source of component boundaries.
- Use shadcn/Radix components as the default UI foundation.
- Use `_reference/demo-shadcn` for sidebar, composer, panel, page, dialog, and
  mock-data composition patterns.
- Allow complex areas such as composer controls, timeline blocks, runtime panels,
  and admin settings to be extended by registration/config instead of rewriting
  each page.
- Make mock data first-class so frontend work can proceed without a fully live
  connector, terminal, file system, or OAuth provider.

## Shadcn Demo Adoption

The zip demo has been extracted to:

```text
web-next/_reference/demo-shadcn
```

Use it as the implementation baseline. Move or adapt its components into `src`
and replace mock data with real APIs, i18n, auth, and runtime behavior.

Demo pieces to adopt as composition references:

- `components/demo.tsx`
  - `SidebarProvider` + `SidebarInset` app composition.
  - Route/page switching through a workspace context.
- `components/app-sidebar.tsx`
  - shadcn `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarMenu`,
    `SidebarFooter`.
  - `DropdownMenu` account menu.
  - `Avatar` for square user avatar.
  - session row hover actions.
- `components/task-composer.tsx`
  - card-like composer built with `Textarea`, `Button`, `DropdownMenu`.
  - attachment bar.
  - cascading device/agent and model/reasoning selectors.
- `components/session-view.tsx`
  - `ResizablePanelGroup` for chat + docked runtime panels.
  - shadcn `Dialog` for takeover confirmation.
  - dock/popout panel state model.
- `components/workspace-picker.tsx`
  - `DropdownMenu` for quick workspace selection.
  - `Dialog` + `ScrollArea` for filesystem browsing.
- `components/panels/*`
  - shared `PanelHeader`.
  - small panel bodies for files, terminal, preview.
- `components/pages/*`
  - full-screen settings/team/service/device pages using Cards, Tables, Tabs,
    forms, badges, and action menus.
- `lib/api.ts`
  - typed mock fixtures that mirror API pseudocode.
- `components/ui/*`
  - broad shadcn primitive set that should be preferred over custom UI shells.

Rules for using the demo:

- Keep real data loading and mutation logic in `src/features/*` APIs and hooks.
- Replace demo hardcoded strings with `next-intl` messages.
- Replace demo mock state with typed mock adapters where mock mode is needed.
- Keep demo layout density and shadcn semantics, but wire to real backend
  contracts from this document.
- Do not copy old custom menu/dialog/popover behavior if a shadcn primitive
  already covers it.

## API Contract Pseudocode

The shapes below are intentionally approximate. They are meant to guide
component design and mock data, not replace backend OpenAPI schemas.

### API Client

All domain functions should use the shared API client style:

```ts
type ApiResult<T> = Promise<T>;

function request<T>(path: string, options: {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  token?: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}): ApiResult<T>;

type ApiError = {
  status: number;
  kind: "network" | "unauthorized" | "forbidden" | "notFound" | "validation" | "server" | "http";
  detail: string;
  code?: string;
};
```

Components should consume domain functions instead of raw paths. Mock APIs
should implement the same function signatures.

### Auth API

```ts
type UserRole = "admin" | "member";

type AuthConfig = {
  needsBootstrap: boolean;
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauthEnabled: boolean;
  oauthProviderLabel?: string | null;
  setupTokenExpiresAt?: string | null;
};

type AuthResponse = {
  userId: string;
  role: UserRole;
  accessToken: string;
  tokenType: "bearer" | string;
};

type AuthMe = {
  userId: string;
  role: UserRole;
  disabled: boolean;
  avatar?: string | null;
};

function getAuthConfig(): Promise<AuthConfig>;
// GET /auth/config

function getPasswordSalt(input: { userId: string }): Promise<{ salt: string }>;
// POST /auth/password-salt

function login(input: {
  userId: string;
  password?: string;
  passwordVerifier?: string;
}): Promise<AuthResponse>;
// POST /auth/login
// frontend normally derives passwordVerifier from password + salt

function register(input: {
  userId: string;
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
  setupToken?: string;
}): Promise<AuthResponse>;
// POST /auth/register

function startOAuth(input: { returnTo: string }): Promise<{ authorizeUrl: string }>;
// GET /auth/oauth/start?returnTo=...

function finalizeOAuth(input: {
  pendingToken: string;
  userId?: string;
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
  setPassword?: boolean;
}): Promise<{ auth: AuthResponse }>;
// POST /auth/oauth/finalize

function getMe(token: string): Promise<AuthMe>;
// GET /auth/me

function updateAvatar(token: string, file: File): Promise<AuthMe>;
// PUT /auth/me/avatar

function deleteAvatar(token: string): Promise<AuthMe>;
// DELETE /auth/me/avatar

function changePassword(token: string, input: {
  oldPassword?: string;
  oldPasswordVerifier?: string;
  newPassword?: string;
  newPasswordVerifier?: string;
  newPasswordSalt?: string;
}): Promise<void>;
// POST /auth/change-password
```

### Dashboard API

```ts
type ConnectorStatus = "online" | "offline";

type ConnectorView = {
  id: string;
  userId: string;
  name: string;
  status: ConnectorStatus;
  lastSeenAt?: string | null;
  runtimeCapabilities: {
    version: number;
    lastDiscoveredAt?: string | null;
    attached: Record<string, {
      attachedAt: string;
      report: {
        selected?: { source: string; path: string; version?: string };
        checked?: Array<{ source: string; path: string; status: "ok" | "failed" | "missing"; reason?: string }>;
        error?: { code: string; message: string };
      };
    }>;
    disabled: string[];
  };
};

type SessionView = {
  id: string;
  connectorId: string;
  connectorStatus: ConnectorStatus;
  runtime: string;
  title?: string | null;
  cwd?: string | null;
  status: "idle" | "running" | "waiting_approval" | "error";
  takeover: boolean;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  lastReadSeq: number;
  updatedSeq: number;
  effectiveRunMode?: "chat" | "terminal" | null;
  runtimeSettings?: Record<string, unknown> | null;
};

function listConnectors(token: string): Promise<{ connectors: ConnectorView[] }>;
// GET /connectors

function createConnector(token: string, input: { name: string }): Promise<{ connector: ConnectorView; token?: string }>;
// POST /connectors

function getConnector(token: string, connectorId: string): Promise<{ connector: ConnectorView }>;
// GET /connectors/{connector_id}

function updateConnector(token: string, connectorId: string, patch: { name?: string }): Promise<{ connector: ConnectorView }>;
// PATCH /connectors/{connector_id}

function deleteConnector(token: string, connectorId: string): Promise<void>;
// DELETE /connectors/{connector_id}

function revokeConnector(token: string, connectorId: string): Promise<{ connector: ConnectorView }>;
// POST /connectors/{connector_id}/revoke

function getConnectorPreferences(token: string, connectorId: string): Promise<Record<string, unknown>>;
// GET /connectors/{connector_id}/preferences

function listSessions(token: string): Promise<{ sessions: SessionView[] }>;
// GET /sessions

function createSession(token: string, input: {
  connectorId: string;
  runtime: string;
  title?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
}): Promise<{ session: SessionView; connectorResult?: unknown }>;
// POST /sessions

function patchSession(token: string, sessionId: string, patch: {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}): Promise<{ session: SessionView }>;
// PATCH /sessions/{session_id}

function markSessionRead(token: string, sessionId: string): Promise<{ session: SessionView }>;
// POST /sessions/{session_id}/read

function bulkArchive(token: string, input: { sessionIds: string[]; archived: boolean }): Promise<{ sessions: SessionView[] }>;
// POST /sessions/bulk-archive

function bulkRead(token: string, input: { sessionIds: string[] }): Promise<{ sessions: SessionView[] }>;
// POST /sessions/bulk-read

function dashboardEventsUrl(token: string): string;
// GET /sessions/events/dashboard as EventSource
```

### Session Detail API

```ts
type TimelineItem = {
  id: string;
  sessionId: string;
  turnId?: string | null;
  type: "turn.start" | "turn.end" | "message" | "tool" | "artifact" | "system";
  status: "pending" | "running" | "waiting_approval" | "done" | "failed" | "cancelled" | "interrupted";
  role?: "user" | "assistant" | "system" | "tool" | null;
  content: Record<string, unknown>;
  source: Record<string, unknown>;
  orderSeq: number;
  revision: number;
  contentHash: string;
  updatedSeq: number;
};

type Approval = {
  id: string;
  sessionId: string;
  turnId?: string | null;
  status: "pending" | "approved" | "approved_for_session" | "rejected" | "cancelled" | "expired";
  kind: "command" | "file_change" | "permission" | "tool_call" | "input_request" | "unknown";
  targetItemId?: string | null;
  title: string;
  description?: string | null;
  payload: unknown;
  choices: Array<"approve" | "approve_for_session" | "reject" | "cancel">;
  updatedSeq: number;
};

function getSessionState(token: string, sessionId: string, input?: {
  afterSeq?: number;
  limit?: number;
}): Promise<{
  session: SessionView;
  items: TimelineItem[];
  approvals: Approval[];
  nextSeq: number;
  hasMore: boolean;
}>;
// GET /sessions/{session_id}/state?afterSeq=0&limit=500

function sessionEventsUrl(token: string, sessionId: string): string;
// GET /sessions/{session_id}/events as EventSource

function sendSessionMessage(token: string, sessionId: string, input: {
  content: string;
  attachments?: Array<{ fileId: string }>;
  clientMessageId?: string;
}): Promise<{ ok: boolean; result?: unknown }>;
// POST /sessions/{session_id}/messages

function uploadSessionAttachments(token: string, sessionId: string, files: File[]): Promise<{
  attachments: Array<{
    fileId: string;
    sessionId: string;
    name: string;
    size: number;
    sha256: string;
    mediaType: string;
    downloadUrl: string;
    openUrl: string;
  }>;
}>;
// POST /sessions/{session_id}/attachments

function getAttachment(token: string, sessionId: string, fileId: string): Promise<Blob | Metadata>;
// GET /sessions/{session_id}/attachments/{file_id}

function openAttachmentUrl(sessionId: string, fileId: string): string;
// GET /sessions/{session_id}/attachments/{file_id}/open

function interruptSession(token: string, sessionId: string): Promise<{ ok: boolean }>;
// POST /sessions/{session_id}/interrupt

function syncSession(token: string, sessionId: string): Promise<{ ok: boolean }>;
// POST /sessions/{session_id}/sync

function enableTakeover(token: string, sessionId: string): Promise<{ session: SessionView }>;
// POST /sessions/{session_id}/takeover

function disableTakeover(token: string, sessionId: string): Promise<{ session: SessionView }>;
// DELETE /sessions/{session_id}/takeover

function resolveApproval(token: string, approvalId: string, input: {
  status: "approved" | "approved_for_session" | "rejected";
}): Promise<{ ok: boolean }>;
// POST /approvals/{approval_id}/resolve
```

### Runtime Config API

```ts
type RuntimeConfigField = {
  key: string;
  label: string;
  type: "string" | "enum" | "boolean" | "object";
  description?: string | null;
  options?: Array<{ value: string | boolean; label: string; description?: string | null }>;
  runtimeOptionsSource?: string | null;
  visibleWhen?: Record<string, unknown> | null;
  allowSessionOverride: boolean;
  hidden: boolean;
  fields?: RuntimeConfigField[];
};

type RuntimeConfigSchema = {
  runtime: string;
  schemaVersion: number;
  fields: RuntimeConfigField[];
};

function getRuntimeConfigSchema(token: string, runtime: string): Promise<{
  runtime: string;
  schema: RuntimeConfigSchema;
}>;
// GET /agents/{runtime}/config-schema

function getAgentModes(token: string, runtime: string): Promise<{ options: unknown[] }>;
// GET /agents/{runtime}/modes

function getAgentModels(token: string, runtime: string): Promise<{ options: unknown[] }>;
// GET /agents/{runtime}/models

function getAgentEfforts(token: string, runtime: string): Promise<{ options: unknown[] }>;
// GET /agents/{runtime}/efforts

function getUserAgentDefaults(token: string): Promise<Record<string, unknown>>;
// GET /agents/defaults

function patchUserAgentDefaults(token: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
// PATCH /agents/defaults

function getConnectorAgentSettings(token: string, connectorId: string, runtime: string): Promise<{
  connectorId: string;
  runtime: string;
  settings: Record<string, unknown>;
  effectiveRunMode?: "chat" | "terminal" | null;
}>;
// GET /connectors/{connector_id}/agents/{runtime}/settings

function patchConnectorAgentSettings(token: string, connectorId: string, runtime: string, patch: Record<string, unknown>): Promise<{
  settings: Record<string, unknown>;
}>;
// PATCH /connectors/{connector_id}/agents/{runtime}/settings

function deleteConnectorAgentSettings(token: string, connectorId: string, runtime: string): Promise<void>;
// DELETE /connectors/{connector_id}/agents/{runtime}/settings

function getSessionRuntimeSettings(token: string, sessionId: string): Promise<{
  sessionId: string;
  runtime: string;
  runtimeSettings: Record<string, unknown>;
  runtimeSettingsOverride?: Record<string, unknown> | null;
  effectiveRunMode?: "chat" | "terminal" | null;
}>;
// GET /sessions/{session_id}/runtime-settings

function patchSessionRuntimeSettings(token: string, sessionId: string, settings: Record<string, unknown>): Promise<{
  runtimeSettings: Record<string, unknown>;
  runtimeSettingsOverride?: Record<string, unknown> | null;
  effectiveRunMode?: "chat" | "terminal" | null;
}>;
// PATCH /sessions/{session_id}/runtime-settings
```

### Connector-Scoped File System API

```ts
type FsEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other" | string;
  size?: number | null;
  modifiedAt?: string | null;
};

function fsList(token: string, connectorId: string, input: {
  root: string;
  path?: string | null;
}): Promise<{ ok: boolean; result: { path: string; entries: FsEntry[]; truncated?: boolean } }>;
// POST /connectors/{connector_id}/fs/list

function fsReadText(token: string, connectorId: string, input: {
  root: string;
  path: string;
  maxBytes?: number;
}): Promise<{
  path: string;
  name: string;
  size: number;
  sha256: string;
  encoding: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}>;
// POST /connectors/{connector_id}/fs/readText?root=...

function fsReadBinary(token: string, connectorId: string, input: {
  root: string;
  path: string;
}): Promise<{ ok: boolean; result: {
  path: string;
  name: string;
  size: number;
  sha256: string;
  transferId: string;
  token: string;
  downloadUrl: string;
} }>;
// POST /connectors/{connector_id}/fs/read?root=...

function fsDownloadTransfer(token: string, connectorId: string, transferId: string): Promise<Blob>;
// GET /connectors/{connector_id}/fs/transfers/{transfer_id}

function fsWrite(token: string, connectorId: string, input: {
  root: string;
  path: string;
  content: string;
  ifMatch?: string;
}): Promise<{ ok: boolean; result: { path: string; bytesWritten: number; sha256: string } }>;
// POST /connectors/{connector_id}/fs/write?root=...
```

### Connector-Scoped Terminal API

```ts
type TerminalView = {
  terminalId: string;
  sessionId: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  purpose: "user" | "primary_claude";
  pid?: number | null;
  status: "starting" | "running" | "exited";
  exitCode?: number | null;
  scrollbackSeq: number;
  ephemeralGroupId?: string | null;
};

function listTerminals(token: string, connectorId: string): Promise<{ terminals: TerminalView[] }>;
// GET /connectors/{connector_id}/terminals

function createTerminal(token: string, connectorId: string, input: {
  root: string;
  cols: number;
  rows: number;
  label?: string;
  cwd?: string;
  shell?: string;
  command?: string;
  args?: string[];
  profile?: string;
  ephemeralGroupId?: string;
}): Promise<{ terminal: TerminalView }>;
// POST /connectors/{connector_id}/terminals?root=...

function renameTerminal(token: string, connectorId: string, terminalId: string, input: {
  label: string;
}): Promise<{ terminal: TerminalView }>;
// PATCH /connectors/{connector_id}/terminals/{terminal_id}

function closeTerminal(token: string, connectorId: string, terminalId: string): Promise<{ terminal: TerminalView }>;
// DELETE /connectors/{connector_id}/terminals/{terminal_id}

function resizeTerminal(token: string, connectorId: string, terminalId: string, input: {
  cols: number;
  rows: number;
}): Promise<{ terminal: TerminalView }>;
// POST /connectors/{connector_id}/terminals/{terminal_id}/resize

function terminalStreamUrl(token: string, connectorId: string, terminalId: string, fromSeq?: number): string;
// WS /connectors/{connector_id}/terminals/{terminal_id}/stream?fromSeq=0&token=...

type TerminalWsClientToServer =
  | { type: "input"; data: string } // base64 terminal input
  | { type: "resize"; cols: number; rows: number };

type TerminalWsServerToClient =
  | { type: "output"; data: string } // base64 terminal output
  | { type: "exit"; exitCode?: number };
```

### Pairing And Connector Ingress API

```ts
function startPairing(token: string, input?: {
  name?: string;
}): Promise<{ pairingCode: string; expiresAt: string; pollToken: string }>;
// POST /pairing/start

function pollPairing(token: string, input: {
  pollToken: string;
}): Promise<{ status: "pending" | "claimed" | "expired"; connector?: ConnectorView }>;
// POST /pairing/poll

function claimPairing(input: {
  pairingCode: string;
  connectorName: string;
  deviceInfo?: Record<string, unknown>;
}): Promise<{ connectorId: string; connectorToken: string }>;
// POST /pairing/claim

function connectorAuth(input: {
  connectorId: string;
  connectorToken: string;
}): Promise<{ accessToken: string; tokenType: string }>;
// POST /connector/auth

function connectorIngest(connectorToken: string, input: unknown): Promise<unknown>;
// POST /connector/ingest
```

### Admin API

```ts
type AdminUser = {
  userId: string;
  role: "admin" | "member";
  disabled: boolean;
  avatar?: string | null;
  createdAt: string;
  updatedAt: string;
};

type InstanceSettings = {
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauth?: {
    enabled: boolean;
    provider: string;
    label: string;
    authorizeUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    clientId: string;
    scopes: string;
    usernameClaim: string;
    subjectClaim: string;
    emailClaim: string;
    nameClaim: string;
    clientSecret?: string;
  } | null;
};

function listUsers(token: string): Promise<{ users: AdminUser[] }>;
// GET /admin/users

function createUser(token: string, input: {
  userId: string;
  role: "admin" | "member";
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
}): Promise<AdminUser>;
// POST /admin/users

function updateUser(token: string, userId: string, patch: {
  role?: "admin" | "member";
  disabled?: boolean;
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
}): Promise<AdminUser>;
// PATCH /admin/users/{user_id}

function deleteUser(token: string, userId: string): Promise<void>;
// DELETE /admin/users/{user_id}

function getSettings(token: string): Promise<InstanceSettings>;
// GET /admin/settings

function updateSettings(token: string, patch: {
  registrationOpen?: boolean;
  oauthRegistrationOpen?: boolean;
  oauth?: InstanceSettings["oauth"];
}): Promise<InstanceSettings>;
// PATCH /admin/settings

function getServiceInfo(token: string): Promise<{
  endpoint: string;
  version: string;
  database: string;
  databasePath?: string | null;
  startedAt: string;
  uptimeSeconds: number;
}>;
// GET /admin/service

function getAdminRuntimeSchema(token: string, runtime: string): Promise<{ schema: RuntimeConfigSchema }>;
// GET /admin/agents/{runtime}/config-schema

function putAdminRuntimeSchema(token: string, runtime: string, schema: RuntimeConfigSchema): Promise<{ schema: RuntimeConfigSchema }>;
// PUT /admin/agents/{runtime}/config-schema
```

## Complete Pages And Business Flows

### Public/Auth Pages

1. Login page
   - Load `getAuthConfig`.
   - If `needsBootstrap`, route user to bootstrap registration.
   - Submit user ID and password through `login`.
   - If OAuth is enabled, show OAuth button and call `startOAuth`.
   - Store `AuthResponse.accessToken`, then load dashboard.

2. Register page
   - Available only when registration is open or bootstrap setup token is valid.
   - Validate user ID and password locally.
   - Generate verifier/salt on frontend.
   - Call `register`.
   - Store token and route to dashboard.

3. Bootstrap page
   - Same as register, but requires `setupToken`.
   - First user should become admin according to backend behavior.

4. OAuth callback/finalize page
   - Parse pending token or callback parameters.
   - Display provider identity if available.
   - Branches:
     - known user: confirm "this is me" and finalize.
     - user chooses to input user ID: button text should become "it's not me";
       collect user ID and password if needed.
     - new OAuth registration: optionally ask for user ID/password depending on
       server policy.
   - Call `finalizeOAuth` and store returned auth token.

### Authenticated Dashboard Pages

1. Dashboard home/new session
   - Load `getMe`, `listConnectors`, and `listSessions`.
   - Subscribe to dashboard SSE.
   - Show sidebar and `NewSessionHome`.
   - User selects connector/runtime/workspace/model/effort/permission.
   - User can attach files before initial send.
   - Flow:
     - `createSession`
     - `enableTakeover`
     - optional `patchSessionRuntimeSettings`
     - optional `uploadSessionAttachments`
     - optional `sendSessionMessage`
     - route to created session.

2. Session detail page
   - Load session state with `getSessionState(sessionId, afterSeq=0)`.
   - Subscribe to `sessionEventsUrl`.
   - Incrementally reload with `afterSeq=nextSeq`.
   - Render timeline, approvals, runtime side panels, and in-session composer.
   - User can:
     - send message
     - attach files
     - interrupt running turn
     - toggle takeover
     - change session runtime settings
     - approve/reject approvals
     - open file previews
     - open files/terminal/preview side panels or popout windows.

3. Device detail page
   - Show connector status and runtime capabilities.
   - Show attached runtimes and selected executable path/version.
   - Allow connector rename/revoke/delete where permitted.
   - Allow connector-agent settings editing through runtime schema.

4. Pair device flow
   - Admin/user starts pairing from dashboard.
   - Call `startPairing`.
   - Show pairing code and expiry.
   - Poll with `pollPairing`.
   - On claimed, refresh connectors and close dialog.
   - Expired state offers restart.

5. Settings page
   - Full-screen page, not a small embedded card.
   - Left nav, right detail pane.
   - Sections:
     - account/profile/avatar/password
     - auth/registration
     - OAuth provider config
     - runtime defaults
     - preview/runtime panel behavior
   - Admin-only settings use `getSettings` and `updateSettings`.
   - Account settings use `/auth/me` endpoints.
   - Pure local settings such as preview behavior persist in local storage.

6. Team page
   - Full-screen admin page.
   - Load `listUsers`.
   - Create user dialog.
   - Row action menu:
     - edit user
     - disable/enable
     - promote/demote admin
     - reset password
     - delete with confirmation
   - Use `createUser`, `updateUser`, `deleteUser`.

7. Service page
   - Full-screen admin page.
   - Load `getServiceInfo`.
   - Show endpoint, version, DB type/path, uptime, server time.
   - Optional runtime schema admin editor can use admin schema endpoints.

### Connector/Runtime Background Flows

1. Dashboard SSE
   - Open once after authentication.
   - On event, merge connector/session patches into dashboard state.
   - If SSE fails, fall back to delayed refresh.

2. Session SSE
   - Open per active session.
   - On message, call `getSessionState(afterSeq=currentNextSeq)`.
   - Merge by item ID and sort by `orderSeq`.
   - Replace approvals list from response.
   - If SSE fails, retry refresh after a small delay.

3. Attachment flow
   - Validate file count and size on frontend.
   - Upload to session.
   - Send message with returned `{ fileId }` refs.
   - Render attachment chips and preview/download links.

4. Runtime settings flow
   - Load schema and current settings.
   - Filter fields by visibility and `allowSessionOverride`.
   - Patch changes optimistically.
   - Reconcile with response.

## Complex Component Behavior

### Timeline

Responsibilities:

- Render backend timeline items in stable order.
- Map item kinds to UI blocks:
  - `message` + `role=user`: right-aligned user message with attachments.
  - `message` + `role=assistant`: markdown block, optional hidden header when
    adjacent assistant chunks belong together.
  - `tool`: compact tool/command/file/approval bar plus expandable card.
  - `artifact`: artifact notice or preview link.
  - `system`: system notice, errors, turn start/end.
  - unknown content: safe fallback card with minimal debug summary.
- Attach approvals to their target item by `targetItemId`.
- Render detached approvals separately if no target item exists.
- Keep markdown behavior complete and product-compatible:
  - paragraphs, lists, task lists, blockquotes
  - code blocks with syntax highlighting
  - inline code
  - links and file preview links visually distinct
  - diff blocks with additions/deletions.

Data handling:

```ts
function mergeTimeline(current: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.orderSeq - b.orderSeq);
}
```

Scroll behavior:

- Track whether user is pinned near the bottom.
- If pinned, auto-scroll after new items or item revisions.
- If user scrolled up, do not steal scroll; show "scroll to latest" control.
- Running sessions show a compact streaming indicator.

Interactions:

- Tool bars/cards can expand/collapse locally.
- Approval buttons call `resolveApproval`.
- Preview links call `onOpenFile(path)`.
- Attachment links open or download through attachment APIs.

Mock requirements:

- multi-turn conversation
- streaming assistant revisions
- command tool with stdout/stderr
- file edit diff
- pending approval and resolved approval
- markdown list/code/table/link examples
- artifact with file preview path
- error/system item

### In-Session Composer

Responsibilities:

- Let user continue an existing session.
- Respect `takeover`, connector online state, current session status, and
  pending approvals.
- Provide attachment, permission, model/effort, takeover, send, interrupt.

State:

```ts
type ComposerState = {
  text: string;
  files: File[];
  draggingFiles: boolean;
  attachmentError?: string | null;
};
```

Rules:

- User can send only when connector is online, takeover is on, and session is
  idle or error.
- If session is running/waiting and text box is empty, send button becomes
  interrupt.
- Enter sends, Shift+Enter inserts newline.
- Paste image creates a file attachment.
- Drag/drop attaches files.
- Max 5 files and 25 MB per file unless backend changes limits.
- Reset draft only after send has been triggered successfully.
- Runtime settings controls patch session runtime settings.

### Workspace Picker

Responsibilities:

- Choose workspace/root for new session.
- Offer default home, recent workspaces, and manual connector filesystem browse.

Inputs:

```ts
type WorkspacePickerProps = {
  connector: ConnectorView | null;
  sessions: SessionView[];
  token: string;
  value: string | null;
  onValueChange: (cwd: string | null) => void;
};
```

Behavior:

- Trigger shows label and full path:
  - no value: Home/default path
  - selected value: basename plus full path
- Recent workspaces come from sessions matching selected connector and unique
  `cwd`, sorted by recent activity.
- Manual mode:
  - input path
  - Enter loads directory
  - parent button navigates upward
  - check button confirms current path
  - directory rows navigate into directory
  - file rows are disabled
- Uses connector-scoped `fs/list` with `{ root: target, path: "." }`.
- Closes on outside click and Escape.
- Menu max height responds to viewport.

Mock requirements:

- connector missing/offline disabled state
- home path resolution
- recent workspace list
- manual path success
- manual path error
- empty directory
- Windows path and POSIX path examples

### Files Panel

Responsibilities:

- Browse files for the active session workspace using connector-scoped FS.
- Open files into preview panel.
- Be dockable in side panel or detached window.

Inputs:

```ts
type FilesPanelProps = {
  api: RuntimeApi;
  activeFile: { name: string; path: string } | null;
  onPickFile(file: { name: string; path: string }): void;
  onClose(): void;
  onPopOut?(): void;
  onDock?(): void;
  detached?: boolean;
};
```

Behavior:

- On mount or API scope change, load `"."`.
- Header actions:
  - parent directory
  - refresh
  - pop out or dock
  - close
- Path bar:
  - editable input
  - Enter/open button loads path
- Body:
  - directories sorted before files
  - `..` parent row when available
  - directory click loads directory
  - file click calls `onPickFile`
  - active file row highlighted
  - show loading, empty, and error states
- Path normalization must support Windows drive paths and POSIX paths.

Mock requirements:

- directory tree
- file sizes
- parent/root edge cases
- permission/list error
- active file highlight

### Preview Panel

Responsibilities:

- Display a selected file from Files Panel, timeline links, or artifact links.
- Support side panel and detached window.
- Default open behavior should be configurable.

Behavior:

- Open preview links as detached window by default.
- Setting can change default to side panel.
- If opening in side panel or docking back from detached mode, optionally close
  existing side tabs according to runtime preferences.
- Text files use `fsReadText`.
- Binary files use `fsReadBinary` and `downloadUrl`.
- Large/truncated text must show truncation message.
- Links that open preview must look clickable: underline and external/preview
  icon cue.

Mock requirements:

- text file
- markdown file
- image/binary file
- large truncated text file
- file read error

### Terminal Panel

Responsibilities:

- Provide interactive terminals scoped to connector + workspace root.
- Support multiple terminal tabs.
- Support side panel and detached window.

Inputs:

```ts
type TerminalPanelProps = {
  api: RuntimeApi;
  onClose(): void;
  onPopOut?(): void;
  onDock?(): void;
  detached?: boolean;
};
```

Behavior:

- Create a fresh terminal on mount with:
  - `cols: 80`
  - `rows: 24`
  - `ephemeralGroupId`
- Close all panel-created terminals on unmount.
- Add button creates another terminal in the same ephemeral group.
- Tab click switches active terminal.
- Tab close closes terminal server-side then removes local tab.
- xterm setup:
  - dynamic import xterm and addons
  - fit to container
  - connect websocket with `streamUrl(terminalId, 0)`
  - client input frame: `{ type: "input", data: btoa(data) }`
  - resize frame: `{ type: "resize", cols, rows }`
  - output frame writes `atob(message.data)`
  - exit frame removes/closes terminal layer
- ResizeObserver refits xterm and sends resize only when cols/rows changed.
- WebSocket failure shows terminal error status.

Mock requirements:

- successful terminal create
- multiple terminals
- output frames
- input capture
- resize frames
- terminal exit
- websocket error

### Runtime Panel Layout

Responsibilities:

- Host files, terminal, and preview panels with shadcn `ResizablePanelGroup`
  where possible.

Behavior:

- Supported visible states:
  - none
  - files only
  - terminal only
  - files + terminal stacked
  - files/terminal plus preview
  - detached windows for files/terminal/preview
- Runtime side width is resizable and bounded.
- When files and terminal share the side panel, vertical ratio is resizable.
- When preview is also visible, horizontal ratio between left runtime column and
  preview is resizable.
- Popping out files/terminal removes that kind from the side panel.
- Docking back restores the corresponding side panel.
- Preferences can close side tabs when preview opens in side mode or when a
  detached panel docks back.

### Menus, Dialogs, And Shared Controls

Shadcn primitive mapping:

- App shell: `SidebarProvider`, `Sidebar`, `SidebarInset`, `SidebarMenu`.
- Menus: `DropdownMenu`, `ContextMenu`, `Menubar` when applicable.
- Search/select: `Command`, `Popover`, `Select`, `Combobox`.
- Dialogs: `Dialog` for forms/wizards, `AlertDialog` for destructive
  confirmation, `Sheet` for side-drawer workflows.
- Forms: `Field`, `Label`, `Input`, `Textarea`, `InputGroup`, `Switch`,
  `Checkbox`, `RadioGroup`, `NativeSelect`.
- Layout: `Card`, `Tabs`, `Table`, `ScrollArea`, `ResizablePanelGroup`,
  `Separator`.
- Feedback: `Alert`, `Badge`, `Skeleton`, `Spinner`, `Empty`, `Sonner`.
- User identity: `Avatar`.
- Microcopy/help: `Tooltip`, `HoverCard`, `Kbd`.

Dialog contract:

- title
- optional subtitle
- close button top right
- body div
- optional footer
- footer is right aligned
- footer has one emphasis action and any number of secondary actions
- no divider line

Menu contract:

- Use shared primitive for focus, Escape, outside click, and positioning.
- Menu item height, icon size, font size, padding, and separators should follow
  shadcn defaults unless a business workflow requires a specialized variant.
- Row action menus should close after selecting any item.

Button contract:

- Emphasis button:
  - dark mode: white background, black text
  - light mode: black background, white text
- Normal button:
  - neutral border/background
  - no yellow emphasis in `web-next`.

## Current Business Domains

### Auth

Pages:

- Login
- Register
- Bootstrap first admin
- OAuth callback/finalization

Core components:

- `AuthShell`: full-screen auth layout, brand, top links, theme control, server
  URL pill.
- `AuthFlow`: decides login/register/bootstrap/OAuth continuation states.
- `CredentialForm`: user ID, password, submit, password visibility.
- `OAuthEntry`: provider sign-in button, callback loading/error states.
- `OAuthFinalizeForm`: handles "this is me", "input user ID", and password
  confirmation or password creation.
- `PasswordStrength`: pure frontend password feedback.

API dependencies:

- `GET /auth/config`
- `POST /auth/password-salt`
- `POST /auth/login`
- `POST /auth/register`
- `GET /auth/oauth/start`
- `POST /auth/oauth/finalize`
- `GET /auth/me`
- Future account UI may use:
  - `PUT /auth/me/avatar`
  - `DELETE /auth/me/avatar`
  - `POST /auth/change-password`
  - mobile login endpoints under `/auth/mobile-login/*`

Pure frontend behavior:

- User ID normalization and validation.
- Password verifier generation before sending credentials.
- Password strength display.
- Token/session storage.
- Redirect after login/logout.
- Theme toggle.
- OAuth finalize branching UI.

Mock data:

- `AuthConfig`: registration state, bootstrap state, OAuth provider availability.
- `AuthMe`: current user, role, avatar URL.
- OAuth finalization states:
  - provider account matched current user
  - provider account requires user ID
  - password required
  - password creation required
  - invalid/expired callback

### Dashboard Shell

Pages:

- Home/new session
- Session route
- Device route
- Settings route
- Team route
- Service route

Core components:

- `DashboardShell`: full-height layout with sidebar and main outlet.
- `Sidebar`: brand, global actions, device list, session list, account menu.
- `SidebarSection`: repeatable section shell.
- `SessionList`: pinned/recent/archived views, read state, status.
- `DeviceList`: online/offline connector rows.
- `AccountMenu`: user head, settings/team/service/sign-out actions.
- `DashboardRouteOutlet`: maps hash/app route to business screen.

API dependencies:

- `GET /connectors`
- `GET /sessions`
- `GET /sessions/events/dashboard`
- `PATCH /sessions/{session_id}`
- `POST /sessions/{session_id}/read`

Pure frontend behavior:

- Hash or app-router route parsing.
- Sidebar collapsed state.
- Optimistic session pin/archive/read updates.
- SSE merge of connector and session patches.
- Search/filter state.
- Account menu open/close, keyboard and outside-click behavior through Radix
  menu primitives.

Mock data:

- Connector list with online/offline states and runtime capabilities.
- Session list with running, idle, waiting approval, unread, pinned, archived.
- Dashboard SSE events for:
  - new session
  - session patch
  - connector status change
  - unread update

### New Session

Core components:

- `NewSessionHome`: headline, composer, workspace picker.
- `HomeComposer`: prompt textarea, attachments, permission picker, device/agent
  picker, model/effort picker, send button.
- `DeviceAgentPicker`: two-column device/agent selection.
- `ModelEffortPicker`: two-column model/effort selection using runtime schema.
- `WorkspacePicker`: recent workspace, default workspace, manual path, connector
  file browser.
- `AttachmentPicker`: file input, paste images, drag-and-drop, chips.

API dependencies:

- `GET /connectors`
- `GET /sessions`
- `POST /sessions`
- `POST /sessions/{session_id}/takeover`
- `PATCH /sessions/{session_id}/runtime-settings`
- `POST /sessions/{session_id}/attachments`
- `POST /sessions/{session_id}/messages`
- `GET /agents/{runtime}/config-schema`
- `GET /connectors/{connector_id}/agents/{runtime}/settings`
- `POST /connectors/{connector_id}/fs/list`

Pure frontend behavior:

- Composer textarea autosize.
- Attachment validation, preview URLs, paste and drag/drop.
- Client message ID generation.
- Runtime settings draft before session creation.
- Workspace picker state and file-browser breadcrumb.
- Derived defaults from selected connector/runtime.

Mock data:

- Online connector with `runtimeCapabilities.attached`.
- Runtime schema with model, effort, permission, run mode fields.
- File-system entries for workspace picker.
- Attachment upload response.
- Session creation response and subsequent session message response.

### Session Detail

Core components:

- `SessionDetailView`: data loader, SSE subscription, runtime panel wiring.
- `SessionContentPanel`: scrollable conversation/timeline column.
- `TimelineEntryRenderer`: maps backend timeline item to display block.
- `UserMessageBlock`: user prompt and attachments.
- `AssistantMarkdownBlock`: markdown content.
- `ToolBar`: compact bar for command/file/tool events.
- `CommandBar`: command execution summary.
- `FileChangeBar`: file change summary and preview entry.
- `ApprovalBar`: pending approval summary.
- `ToolCard`: expanded details for tool calls, commands, diffs, artifacts.
- `SystemBlock`: turn start/end, errors, sync notices.
- `InSessionComposer`: ongoing prompt input, attachments, permission/model
  controls, send/interrupt.

API dependencies:

- `GET /sessions/{session_id}/state`
- `GET /sessions/{session_id}/events`
- `POST /sessions/{session_id}/messages`
- `POST /sessions/{session_id}/attachments`
- `POST /sessions/{session_id}/interrupt`
- `POST /sessions/{session_id}/takeover`
- `DELETE /sessions/{session_id}/takeover`
- `GET /sessions/{session_id}/runtime-settings`
- `PATCH /sessions/{session_id}/runtime-settings`
- `POST /approvals/{approval_id}/resolve`
- Attachment open/download:
  - `GET /sessions/{session_id}/attachments/{file_id}`
  - `GET /sessions/{session_id}/attachments/{file_id}/open`

Pure frontend behavior:

- Timeline merge by `updatedSeq`, `orderSeq`, and revision.
- Preserve scroll position and "follow latest" behavior.
- Markdown rendering, code highlighting, diff rendering.
- Collapsible timeline cards.
- Preview link detection and click handling.
- Approval optimistic state.
- In-session composer autosize and file attachment state.
- Takeover status and interrupt state.

Mock data:

- Session state pages with `items`, `approvals`, `nextSeq`, `hasMore`.
- SSE event stream for timeline item append/update and approval update.
- Timeline item fixtures:
  - user message
  - assistant markdown
  - command bar and expanded card
  - file change bar and diff card
  - approval pending/resolved
  - system error
  - artifact/file preview link
- Attachment blobs and file metadata.

### Runtime Panels

Panels:

- Files panel
- Terminal panel
- Preview panel

Important boundary:

Runtime panels must use connector-scoped interfaces. Do not design new runtime
UI around session-scoped terminal or file APIs. A session can provide the active
connector ID and root/cwd, but file and terminal operations belong to the
connector.

Core components:

- `RuntimePanelLayout`: visible panels, side/docked/popped states, resize grips.
- `RuntimePanelHeader`: title, pop out, dock, close, refresh actions.
- `FilesPanel`: path bar, file list, editor/preview entry.
- `TerminalPanel`: terminal tabs, create/rename/close/resize, stream.
- `PreviewPanel`: file preview, external/open-in-side behavior.
- `RuntimeWindow`: detached browser window shell.
- `RuntimePreferences`: default preview target and side-tab behavior.

API dependencies:

- Files:
  - `POST /connectors/{connector_id}/fs/list`
  - `POST /connectors/{connector_id}/fs/read`
  - `POST /connectors/{connector_id}/fs/readText`
  - `POST /connectors/{connector_id}/fs/write`
  - `GET /connectors/{connector_id}/fs/transfers/{transfer_id}`
- Terminals:
  - `GET /connectors/{connector_id}/terminals`
  - `POST /connectors/{connector_id}/terminals`
  - `PATCH /connectors/{connector_id}/terminals/{terminal_id}`
  - `DELETE /connectors/{connector_id}/terminals/{terminal_id}`
  - `POST /connectors/{connector_id}/terminals/{terminal_id}/resize`
  - terminal websocket/stream endpoint from connector terminal routing
- Optional shell tasks:
  - `POST /connectors/{connector_id}/shell/exec`
  - `POST /connectors/{connector_id}/shell/tasks`
  - `GET /connectors/{connector_id}/shell/tasks/{task_id}/wait`

Pure frontend behavior:

- Panel layout ratios and persisted preferences.
- Popped-out window lifecycle and dock-back behavior.
- Side tab closing policy when preview or detached panels return to side.
- Terminal fit/resize scheduling.
- File preview type detection.
- Text decoding and large file truncation messaging.
- Unsaved file edit state if file writing is enabled.

Mock data:

- File tree with directories, text files, binary files, large/truncated file.
- File read text and binary transfer response.
- Terminal list/create/rename/close responses.
- Terminal stream mock emitting prompt, output, and resize behavior.
- Preview settings mock for default external vs side behavior.

### Device And Agent Management

Pages/flows:

- Device detail
- Pair device
- Attached agent/runtime management
- Connector preferences

Core components:

- `DeviceDetailPage`: connector summary, status, runtime capabilities.
- `PairDeviceDialog`: pairing token/code, polling and success/error states.
- `AgentRuntimeCard`: runtime status, selected executable, checked paths.
- `RuntimeConfigForm`: schema-driven settings editor.
- `ConnectorPreferencesForm`: connector-level preferences.

API dependencies:

- `GET /connectors`
- `POST /connectors`
- `GET /connectors/{connector_id}`
- `PATCH /connectors/{connector_id}`
- `DELETE /connectors/{connector_id}`
- `POST /connectors/{connector_id}/revoke`
- `GET /connectors/{connector_id}/preferences`
- Pairing:
  - `POST /pairing/start`
  - `POST /pairing/claim`
  - `POST /pairing/poll`
- Runtime config:
  - `GET /agents/{runtime}/config-schema`
  - connector-agent settings endpoints under
    `/connectors/{connector_id}/agents/{runtime}/settings`

Pure frontend behavior:

- Pairing countdown and polling.
- Runtime capability display from `ConnectorView.runtimeCapabilities`.
- Schema-driven forms and validation.
- Connector status formatting and relative times.

Mock data:

- Online/offline connectors.
- Runtime capability reports for Codex, Claude, and missing runtimes.
- Pairing pending/claimed/expired.
- Runtime schema and settings for each runtime.

### Team

Core components:

- `TeamPage`: full-screen admin page.
- `UserTable`: rows with avatar, user ID, role, status, created/updated times.
- `UserActionsMenu`: edit, disable/enable, promote/demote, delete.
- `UserEditorDialog`: user ID, role, password reset.
- `CreateUserDialog`.
- `DeleteUserConfirmDialog`.

API dependencies:

- `GET /admin/users`
- `POST /admin/users`
- `PATCH /admin/users/{user_id}`
- `DELETE /admin/users/{user_id}`

Pure frontend behavior:

- Table sorting/filtering if added.
- Dialog draft state.
- Password generation/validation.
- Optimistic row update after mutation.
- Role-based access hiding for non-admin users.

Mock data:

- Admin and member users.
- Active and disabled users.
- Users with avatar and without avatar.
- Mutation success and validation errors.

### Service

Core components:

- `ServicePage`: full-screen admin page.
- `ServiceStatusSummary`: version, environment, storage, server time.
- `ServiceHealthList`: subsystems and states.
- `RuntimeConfigAdmin`: optional schema editor for runtimes.

API dependencies:

- `GET /admin/service`
- Optional runtime schema admin:
  - `GET /admin/agents/{runtime}/config-schema`
  - `PUT /admin/agents/{runtime}/config-schema`

Pure frontend behavior:

- Status formatting.
- Read-only display unless admin editing is explicitly enabled.
- Copyable diagnostic values.

Mock data:

- Healthy service.
- Degraded service.
- Missing OAuth/runtime config warnings.

### Settings

Core components:

- `SettingsPage`: full-screen page with left navigation and right detail pane.
- `SettingsNav`: account, auth, OAuth, runtime preferences, preview behavior.
- `SettingsSection`: title/subtitle/body.
- `SettingRow`: label, description, control.
- `OAuthProviderForm`: provider, client ID, secret placeholder/update.
- `PreviewBehaviorSettings`: default preview target and side-tab behavior.
- `AccountSettings`: avatar, password, user info.

API dependencies:

- `GET /admin/settings`
- `PATCH /admin/settings`
- Account endpoints:
  - `GET /auth/me`
  - `PUT /auth/me/avatar`
  - `DELETE /auth/me/avatar`
  - `POST /auth/change-password`

Pure frontend behavior:

- Local settings navigation.
- Draft forms before save.
- Secret-field placeholder behavior.
- Runtime panel preferences in local storage.
- Theme and locale choice if kept frontend-only.

Mock data:

- Settings with registration open/closed.
- OAuth disabled/enabled/partially configured.
- Successful save and validation error.
- Account avatar upload/remove.

## Cross-Cutting Modules

### API Layer

Use `src/lib/api` as the only HTTP foundation. Domain APIs should be thin
classes under `src/features/<domain>/api.ts`.

Rules:

- Components must not call `fetch` directly except for binary downloads or
  browser APIs that cannot go through `ApiClient`.
- Normalize errors into `ApiError`.
- Domain APIs return typed payloads that match backend response models.
- Keep endpoint path construction inside domain APIs.
- Expose SSE URL helpers from domain APIs, but keep EventSource lifecycle in
  hooks/components.
- Add mock adapters at the domain API boundary, not inside visual components.

Recommended extension:

```text
src/features/auth/api.ts
src/features/auth/mock.ts
src/features/dashboard/api.ts
src/features/dashboard/mock.ts
src/features/runtime/api.ts
src/features/runtime/mock.ts
src/features/admin/api.ts
src/features/admin/mock.ts
```

### Component Plugin Points

The UI should be pluggable in these places:

- Composer controls:
  - permission picker
  - device/agent picker
  - model/effort picker
  - attachment picker
  - send/interrupt button
- Timeline renderers:
  - map `TimelineItem.type`, `role`, and content subtype to renderer.
  - unknown items must fall back to a safe debug/system card.
- Tool cards:
  - command
  - file change
  - approval
  - artifact
  - generic JSON/tool call
- Runtime panels:
  - files
  - terminal
  - preview
  - future browser/process/log panels
- Settings sections:
  - account
  - auth
  - OAuth
  - runtime defaults
  - preview behavior
  - connector preferences

Prefer registry objects over switch statements when the list is expected to
grow. Keep the registry typed so unsupported keys fail at compile time.

Example shape:

```ts
type TimelineRenderer = {
  canRender(item: TimelineItem): boolean;
  render(props: TimelineRenderProps): React.ReactNode;
};

export const timelineRenderers: TimelineRenderer[] = [
  userMessageRenderer,
  assistantMarkdownRenderer,
  commandToolRenderer,
  fileChangeRenderer,
  approvalRenderer,
  fallbackRenderer,
];
```

### Mock Strategy

Mocks should model API behavior, not just component props. This lets component
work continue without a live backend or connector.

Recommended files:

```text
src/mocks/fixtures/auth.ts
src/mocks/fixtures/connectors.ts
src/mocks/fixtures/sessions.ts
src/mocks/fixtures/timeline.ts
src/mocks/fixtures/runtime.ts
src/mocks/fixtures/admin.ts
src/mocks/mock-api.ts
```

Mock requirements:

- Fixtures must use the same TypeScript types as real API responses.
- Include happy paths, empty states, loading states, validation errors, network
  errors, and permission errors.
- SSE should be mocked as a small event emitter or fake EventSource adapter.
- File and terminal mocks should be connector-scoped.
- Runtime schema mocks must include enough options to exercise model/effort and
  permission menus.
- Mock data should include Chinese and English display strings only where the
  backend actually returns display strings; frontend UI labels still come from
  i18n messages.

## Data Ownership Rules

- Auth token and current user: auth/session module.
- Connectors and sessions list: dashboard data hook.
- Active route and sidebar UI state: dashboard shell.
- Active session state and timeline: session detail module.
- Composer draft state: composer module, reset only after successful send.
- Runtime panel layout and preview preferences: runtime module/local storage.
- Admin page form drafts: page-local or admin feature hooks.
- Theme and locale: layout/common shell.

## Component Design Rules

- Visual components receive data and callbacks; they should not know endpoint
  URLs.
- Business containers call domain APIs and pass typed props to visual
  components.
- Dialogs use a shared shell:
  - title
  - optional subtitle
  - close button at top right
  - body div
  - optional footer, right-aligned, one emphasis action and any secondary
    actions
  - no divider lines
- Menus and popovers should use shared primitives for positioning, focus,
  outside-click, and Escape behavior.
- Every repeated bar/card/control in session detail should be a named component:
  command bar, file bar, approval bar, tool card, markdown block, user message
  block.
- Do not add page-specific button/input styles when common variants can express
  the state.
- Keep the app work-focused: compact enough for repeated operations, restrained
  borders, semantic shadcn tokens, and mono text for paths, device names, command
  output, and code-like values.

## Suggested Implementation Order

1. Freeze domain API contracts in `features/*/api.ts` and add mock adapters.
2. Extract common primitives: dialog, action menu, popover, icon button, form
   field, setting row, panel header, empty/loading/error states.
3. Rebuild dashboard shell from reusable sidebar, device list, session list,
   account menu, and route outlet.
4. Rebuild new-session composer from pluggable composer controls.
5. Rebuild session detail around timeline renderer registries.
6. Rebuild runtime panels with connector-scoped APIs and detachable panel shell.
7. Rebuild settings/team/service as full-screen admin pages using shared admin
   page shells and dialogs.
8. Add mock pages or stories for each module using shadcn demo composition.
9. Run typecheck/build and functional comparison before replacing old pages.

## Acceptance Checklist For Each Module

- Uses typed domain API or mock API only.
- Has fixture coverage for empty/loading/error/success states.
- Has i18n for all frontend-owned strings.
- Has keyboard behavior for menus/dialogs/forms.
- Can render without a live backend in mock mode.
- Uses shadcn primitives and matches the approved demo-driven composition
  direction.
- Does not duplicate modal/menu/button/composer implementations locally.
- Keeps connector-scoped runtime operations connector-scoped.
