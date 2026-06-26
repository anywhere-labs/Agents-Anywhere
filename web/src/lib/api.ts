export type UserRole = "admin" | "member";

export type AuthConfig = {
  needsBootstrap: boolean;
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauthEnabled: boolean;
  oauthProviderLabel: string | null;
  // ISO-8601 UTC timestamp; only present (non-null) while needsBootstrap=true.
  // Drives the bootstrap form's countdown. The token value itself stays in
  // the server log — never sent over HTTP.
  setupTokenExpiresAt: string | null;
  serverTime: string;
};

export type AuthResponse = {
  userId: string;
  role: UserRole;
  accessToken: string;
  tokenType: string;
  serverTime: string;
};

export type AuthMe = {
  userId: string;
  role: UserRole;
  disabled: boolean;
  avatar: string | null;
  serverTime: string;
};

export type HealthResponse = {
  status: string;
  serverTime: string;
};

export type AuthCredentials = {
  userId: string;
  password?: string;
  passwordVerifier?: string;
  passwordSalt?: string;
  // Only sent during the first-run bootstrap call.
  setupToken?: string;
};

export type AuthPasswordSaltResponse = {
  salt: string;
  serverTime: string;
};

export type OAuthProviderConfig = {
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
};

export type OAuthProviderConfigUpdate = OAuthProviderConfig & {
  clientSecret?: string;
};

export type OAuthStartResponse = {
  authorizeUrl: string;
  serverTime: string;
};

export type OAuthFinalizeResponse = {
  auth: AuthResponse;
  serverTime: string;
};

export type MobileLoginQrResponse = {
  userId: string;
  loginToken: string;
  expiresAt: string;
  serverTime: string;
};

export type MobileLoginStatus =
  | "pending_scan"
  | "pending_web_confirm"
  | "approved"
  | "rejected"
  | "expired"
  | "consumed";

export type MobileLoginStatusResponse = {
  status: MobileLoginStatus;
  userId: string | null;
  deviceName: string | null;
  expiresAt: string | null;
  requestedAt: string | null;
  approvedAt: string | null;
  serverTime: string;
};

export type AdminUser = {
  userId: string;
  role: UserRole;
  disabled: boolean;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminUserListResponse = {
  users: AdminUser[];
  serverTime: string;
};

export type InstanceSettings = {
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauth: OAuthProviderConfig | null;
};

export type ServiceInfo = {
  endpoint: string;
  version: string;
  database: string;
  databasePath: string | null;
  startedAt: string;
  uptimeSeconds: number;
  serverTime: string;
};

export type ConnectorStatus = "offline" | "online";

export type ConnectorView = {
  id: string;
  userId: string;
  name: string;
  deviceOs: "macos" | "windows" | "linux" | null;
  status: ConnectorStatus;
  lastSeenAt: string | null;
  // Per-device agent view. The API field name is `runtimeCapabilities`
  // for db/schema compat; the backend stores observed facts + desired
  // intent and exposes this attached/disabled view to the UI.
  runtimeCapabilities: DeviceAgentsState;
  createdAt: string;
  updatedAt: string;
};

// Mirrors the daemon's discovery report; see
// connector/connector/capabilities.py.
export type RuntimeCheckEntry = {
  source: string;
  path: string;
  status: "ok" | "failed" | "missing";
  reason?: string;
  stage?: string;
  version?: string;
};

export type RuntimeReport = {
  history?: "ok" | "ok_empty" | "unavailable";
  execution?: "ok" | "unavailable";
  selected?: { source: string; path: string; version?: string };
  checked?: RuntimeCheckEntry[];
  error?: { code: string; message: string };
  projectsDir?: string;
  historyCheck?: Record<string, unknown>;
};

export type AttachedAgent = {
  // Daemon's most recent discovery report for this runtime. Refreshed on
  // every full discovery push, but the agent stays attached even if the
  // report turns unhealthy — only an explicit Delete removes it.
  report: RuntimeReport;
  attachedAt: string;
};

export type DeviceAgentsState = {
  version: number;
  lastDiscoveredAt: string | null;
  // Agents the user has on this device. Keyed by runtime name.
  attached: Record<string, AttachedAgent>;
  // Runtimes the user has explicitly Deleted. Used by the server to filter
  // out daemon auto-rediscovery; the UI doesn't render these anywhere.
  disabled: string[];
};

export type RuntimeCapabilitiesResponse = {
  connectorId: string;
  runtimeCapabilities: DeviceAgentsState;
  serverTime: string;
};

export type ScanRuntimeResponse = RuntimeCapabilitiesResponse & {
  scanned: { runtime: string; report: RuntimeReport };
};

export type ConnectorListResponse = {
  connectors: ConnectorView[];
  serverTime: string;
};

export type DashboardEvent = {
  type: "dashboard.sync" | "dashboard.changed";
  serverTime: string;
};

export type ConnectorCreateResponse = {
  connector: ConnectorView;
  // Plaintext token — only returned at create time, never again.
  connectorToken: string;
  tokenPrefix: string;
};

export type ConnectorRevokeResponse = ConnectorCreateResponse & {
  serverTime: string;
};

export type PairingClaimResponse = {
  status: string;
  connector: ConnectorView | null;
};

export type ConnectorResponse = {
  connector: ConnectorView;
  serverTime: string;
};

export type SessionStatusValue =
  | "idle"
  | "running"
  | "waiting_approval"
  | "error";

export type SessionView = {
  id: string;
  connectorId: string;
  connectorStatus: ConnectorStatus;
  runtime: string;
  externalSessionId: string | null;
  title: string | null;
  cwd: string | null;
  status: SessionStatusValue;
  takeover: boolean;
  pinned: boolean;
  pinnedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  unread: boolean;
  lastReadSeq: number;
  lastSyncedAt: string | null;
  sourceObservedAt: string | null;
  lastActivityAt: string | null;
  lastItemAt: string | null;
  lastItemOrderSeq: number | null;
  sortAt: string | null;
  updatedSeq: number;
  effectiveRunMode?: "chat" | "terminal" | null;
  runtimeSettings?: Record<string, unknown> | null;
  runtimeSettingsOverride?: Record<string, unknown> | null;
};

export type AgentCatalogEntry = {
  runtime: string;
  key: string;
  displayLabel: string;
  description: string | null;
  isDefault: boolean;
  sortOrder: number;
  efforts: AgentCatalogEntry[];
};

export type AgentCatalogResponse = {
  runtime: string;
  entries: AgentCatalogEntry[];
  serverTime: string;
};

export type UserAgentDefaultRuntime = {
  runtime: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  models: AgentCatalogEntry[];
};

export type UserAgentDefaultsResponse = {
  runtimes: Record<string, UserAgentDefaultRuntime>;
  serverTime: string;
};

export type AgentCatalogEntryUpdate = {
  key: string;
  displayLabel: string;
  description?: string | null;
  sortOrder?: number;
  efforts?: AgentCatalogEntryUpdate[];
};

export type UserAgentDefaultRuntimeUpdate = {
  models?: AgentCatalogEntryUpdate[];
};

export type UserAgentDefaultsUpdate = {
  runtimes: Record<string, UserAgentDefaultRuntimeUpdate>;
};

export type RuntimeConfigOption = {
  value: string | boolean;
  label: string;
  description?: string | null;
  efforts?: RuntimeConfigOption[] | null;
};

export type RuntimeConfigField = {
  key: string;
  label: string;
  type: "string" | "enum" | "boolean" | "object";
  description?: string | null;
  options?: RuntimeConfigOption[] | null;
  runtimeOptionsSource?: string | null;
  visibleWhen?: Record<string, unknown> | null;
  allowSessionOverride: boolean;
  hidden: boolean;
  fields?: RuntimeConfigField[] | null;
};

export type RuntimeConfigSchema = {
  runtime: string;
  schemaVersion: number;
  fields: RuntimeConfigField[];
};

export type RuntimeConfigSchemaResponse = {
  runtime: string;
  schema: RuntimeConfigSchema;
  serverTime: string;
};

export type RuntimeSettingsResponse = {
  connectorId?: string | null;
  sessionId?: string | null;
  runtime: string;
  settings: Record<string, unknown>;
  runtimeSettings?: Record<string, unknown> | null;
  runtimeSettingsOverride?: Record<string, unknown> | null;
  effectiveRunMode?: "chat" | "terminal" | null;
  defaultRunModeConfigured: boolean;
  schemaVersion: number;
  serverTime: string;
};

export type ConnectorPreferencesResponse = {
  connectorId: string;
  preferences: Record<string, unknown>;
  serverTime: string;
};

export type SessionListResponse = {
  sessions: SessionView[];
  serverTime: string;
};

export type SessionResponse = {
  session: SessionView;
  serverTime: string;
};

export type SessionPatch = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
};

export type BulkArchiveResponse = {
  sessions: SessionView[];
  notFound: string[];
  serverTime: string;
};

export type ArchiveAllScope = "active" | "archived" | "all";

export type ArchiveAllResponse = {
  sessions: SessionView[];
  affected: number;
  serverTime: string;
};

export type TimelineType =
  | "turn.start"
  | "turn.end"
  | "message"
  | "tool"
  | "artifact"
  | "system";

export type TimelineStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TimelineRole = "user" | "assistant" | "system" | "tool";

export type TimelineItem = {
  id: string;
  sessionId: string;
  turnId: string | null;
  type: TimelineType;
  status: TimelineStatus;
  role: TimelineRole | null;
  content: Record<string, unknown>;
  source: Record<string, unknown>;
  orderSeq: number;
  revision: number;
  contentHash: string;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "approved_for_session"
  | "rejected"
  | "cancelled"
  | "expired";

export type ApprovalKind =
  | "command"
  | "file_change"
  | "permission"
  | "tool_call"
  | "input_request"
  | "unknown";

export type Approval = {
  id: string;
  sessionId: string;
  turnId: string | null;
  status: ApprovalStatus;
  kind: ApprovalKind;
  targetItemId: string | null;
  title: string;
  description: string | null;
  payload: unknown;
  choices: Array<"approve" | "approve_for_session" | "reject" | "cancel">;
  source: Record<string, unknown>;
  updatedSeq: number;
  createdAt: string;
  resolvedAt: string | null;
};

export type SessionStateResponse = {
  session: SessionView;
  items: TimelineItem[];
  approvals: Approval[];
  nextSeq: number;
  hasMore: boolean;
  serverTime: string;
};

export type TakeoverResponse = {
  session: SessionView;
};

export type RpcResponsePayload = {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string } | null;
};

export type FsEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size?: number | null;
};

export type FsListResult = {
  path: string;
  entries: FsEntry[];
  truncated: boolean;
};

export type RpcResponse<T> = {
  ok: boolean;
  result: T;
  error?: { code: string; message: string } | null;
};

export type AttachmentRef = { fileId: string };

export type UploadedAttachment = {
  fileId: string;
  sessionId: string;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
  createdAt: string;
  downloadUrl: string;
  openUrl: string;
};

export type UserUploadResponse = {
  attachments: UploadedAttachment[];
  serverTime: string;
};

export type ApprovalResolveStatus =
  | "approved"
  | "approved_for_session"
  | "rejected"
  | "cancelled";

// FastAPI's `detail` is sometimes a structured object (e.g. ConnectorRpcError
// returned `{code, message}` before we flattened it server-side). Anything we
// can't reduce to a meaningful string we render as a stable fallback instead
// of leaking `[object Object]` into the UI.
function extractErrorDetail(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const obj = detail as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (typeof obj.code === "string" && obj.code) return obj.code;
    try {
      return JSON.stringify(detail);
    } catch {
      return "";
    }
  }
  return detail == null ? "" : String(detail);
}

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const BASE = "";

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (token) headers.set("authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "network error");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const detail = extractErrorDetail(payload) || `HTTP ${res.status}`;
    throw new ApiError(res.status, detail);
  }

  return payload as T;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
  authConfig: () => request<AuthConfig>("/auth/config"),
  passwordSalt: (userId: string) =>
    request<AuthPasswordSaltResponse>("/auth/password-salt", {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  login: (creds: AuthCredentials) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(creds),
    }),
  register: (creds: AuthCredentials) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(creds),
    }),
  startOAuth: (returnTo: string) =>
    request<OAuthStartResponse>(
      `/auth/oauth/start?returnTo=${encodeURIComponent(returnTo)}`,
    ),
  finalizeOAuth: (body: {
    pendingToken: string;
    userId?: string;
    password?: string;
    passwordVerifier?: string;
    passwordSalt?: string;
    setPassword?: boolean;
  }) =>
    request<OAuthFinalizeResponse>("/auth/oauth/finalize", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  me: (token: string) => request<AuthMe>("/auth/me", {}, token),
  changePassword: (
    token: string,
    body: {
      oldPassword?: string;
      oldPasswordVerifier?: string;
      newPassword?: string;
      newPasswordVerifier?: string;
      newPasswordSalt?: string;
    },
  ) =>
    request<void>(
      "/auth/change-password",
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  updateAvatar: (token: string, body: { avatar: string }) =>
    request<AuthMe>(
      "/auth/me/avatar",
      { method: "PUT", body: JSON.stringify(body) },
      token,
    ),
  clearAvatar: (token: string) =>
    request<AuthMe>("/auth/me/avatar", { method: "DELETE" }, token),
  createMobileLoginQr: (token: string) =>
    request<MobileLoginQrResponse>(
      "/auth/mobile-login/qr",
      { method: "POST", body: "{}" },
      token,
    ),
  mobileLoginStatus: (token: string, loginToken: string) =>
    request<MobileLoginStatusResponse>(
      "/auth/mobile-login/status",
      { method: "POST", body: JSON.stringify({ loginToken }) },
      token,
    ),
  confirmMobileLogin: (token: string, loginToken: string, approved = true) =>
    request<MobileLoginStatusResponse>(
      "/auth/mobile-login/confirm",
      { method: "POST", body: JSON.stringify({ loginToken, approved }) },
      token,
    ),
  listUsers: (token: string) =>
    request<AdminUserListResponse>("/admin/users", {}, token),
  createUser: (
    token: string,
    body: {
      userId: string;
      password?: string;
      passwordVerifier?: string;
      passwordSalt?: string;
      role: UserRole;
    },
  ) =>
    request<AdminUser>(
      "/admin/users",
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  updateUser: (
    token: string,
    userId: string,
    body: {
      role?: UserRole;
      disabled?: boolean;
      password?: string;
      passwordVerifier?: string;
      passwordSalt?: string;
    },
  ) =>
    request<AdminUser>(
      `/admin/users/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      token,
    ),
  deleteUser: (token: string, userId: string) =>
    request<void>(
      `/admin/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      token,
    ),
  getSettings: (token: string) =>
    request<InstanceSettings>("/admin/settings", {}, token),
  updateSettings: (
    token: string,
    body: {
      registrationOpen?: boolean;
      oauthRegistrationOpen?: boolean;
      oauth?: OAuthProviderConfigUpdate;
    },
  ) =>
    request<InstanceSettings>(
      "/admin/settings",
      { method: "PATCH", body: JSON.stringify(body) },
      token,
    ),
  getServiceInfo: (token: string) =>
    request<ServiceInfo>("/admin/service", {}, token),
  listConnectors: (token: string) =>
    request<ConnectorListResponse>("/connectors", {}, token),
  createConnector: (token: string, body: { name?: string } = {}) =>
    request<ConnectorCreateResponse>(
      "/connectors",
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  getConnector: (token: string, id: string) =>
    request<ConnectorResponse>(
      `/connectors/${encodeURIComponent(id)}`,
      {},
      token,
    ),
  updateConnector: (token: string, id: string, body: { name?: string }) =>
    request<ConnectorResponse>(
      `/connectors/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      token,
    ),
  deleteConnector: (token: string, id: string) =>
    request<void>(
      `/connectors/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      token,
    ),
  revokeConnector: (token: string, id: string) =>
    request<ConnectorRevokeResponse>(
      `/connectors/${encodeURIComponent(id)}/revoke`,
      { method: "POST", body: "{}" },
      token,
    ),
  claimPairing: (
    token: string,
    body: {
      code: string;
      name: string;
      serverUrl?: string | null;
      connectorId?: string | null;
      connectorToken?: string | null;
    },
  ) =>
    request<PairingClaimResponse>(
      "/pairing/claim",
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  createSession: (
    token: string,
    body: {
      connectorId: string;
      runtime: string;
      title?: string;
      cwd?: string;
      approvalPolicy?: string;
      sandbox?: string;
    },
  ) =>
    request<{ session: SessionView; connectorResult: unknown }>(
      "/sessions",
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  connectorFsList: (
    token: string,
    connectorId: string,
    body: { root: string; path?: string | null },
  ) =>
    request<RpcResponse<FsListResult>>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/list`,
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  listSessions: (token: string) =>
    request<SessionListResponse>("/sessions", {}, token),
  patchSession: (token: string, sessionId: string, body: SessionPatch) =>
    request<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      token,
    ),
  bulkArchiveSessions: (token: string, ids: string[], archived: boolean) =>
    request<BulkArchiveResponse>(
      `/sessions/bulk-archive`,
      { method: "POST", body: JSON.stringify({ ids, archived }) },
      token,
    ),
  bulkReadSessions: (token: string, ids: string[]) =>
    request<BulkArchiveResponse>(
      `/sessions/bulk-read`,
      { method: "POST", body: JSON.stringify({ ids }) },
      token,
    ),
  archiveAllDeviceSessions: (
    token: string,
    connectorId: string,
    archived: boolean,
    scope: ArchiveAllScope,
  ) =>
    request<ArchiveAllResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/sessions/archive-all`,
      { method: "POST", body: JSON.stringify({ archived, scope }) },
      token,
    ),
  markSessionRead: (token: string, sessionId: string) =>
    request<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/read`,
      { method: "POST", body: "{}" },
      token,
    ),
  getSessionState: (
    token: string,
    sessionId: string,
    afterSeq = 0,
    limit = 200,
  ) =>
    request<SessionStateResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/state?afterSeq=${afterSeq}&limit=${limit}`,
      {},
      token,
    ),
  // SSE URL — EventSource can't set Authorization headers, so the user
  // access token rides as a query param. Backend verifies it before
  // subscribing to the broker.
  sessionEventsUrl: (token: string, sessionId: string) =>
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token)}`,
  dashboardEventsUrl: (token: string) =>
    `${BASE}/sessions/events/dashboard?token=${encodeURIComponent(token)}`,
  sendSessionMessage: (
    token: string,
    sessionId: string,
    content: string,
    attachments?: AttachmentRef[],
    clientMessageId?: string,
  ) =>
    request<RpcResponsePayload>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        }),
      },
      token,
    ),
  listAgentModes: (token: string, runtime: string) =>
    request<AgentCatalogResponse>(
      `/agents/${encodeURIComponent(runtime)}/modes`,
      {},
      token,
    ),
  getAgentDefaults: (token: string) =>
    request<UserAgentDefaultsResponse>("/agents/defaults", {}, token),
  patchAgentDefaults: (token: string, update: UserAgentDefaultsUpdate) =>
    request<UserAgentDefaultsResponse>(
      "/agents/defaults",
      { method: "PATCH", body: JSON.stringify(update) },
      token,
    ),
  listAgentModels: (token: string, runtime: string) =>
    request<AgentCatalogResponse>(
      `/agents/${encodeURIComponent(runtime)}/models`,
      {},
      token,
    ),
  listAgentEfforts: (token: string, runtime: string) =>
    request<AgentCatalogResponse>(
      `/agents/${encodeURIComponent(runtime)}/efforts`,
      {},
      token,
    ),
  getRuntimeConfigSchema: (token: string, runtime: string) =>
    request<RuntimeConfigSchemaResponse>(
      `/agents/${encodeURIComponent(runtime)}/config-schema`,
      {},
      token,
    ),
  getConnectorAgentSettings: (
    token: string,
    connectorId: string,
    runtime: string,
  ) =>
    request<RuntimeSettingsResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/agents/${encodeURIComponent(runtime)}/settings`,
      {},
      token,
    ),
  patchConnectorAgentSettings: (
    token: string,
    connectorId: string,
    runtime: string,
    settings: Record<string, unknown>,
  ) =>
    request<RuntimeSettingsResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/agents/${encodeURIComponent(runtime)}/settings`,
      { method: "PATCH", body: JSON.stringify({ settings }) },
      token,
    ),
  getSessionRuntimeSettings: (token: string, sessionId: string) =>
    request<RuntimeSettingsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime-settings`,
      {},
      token,
    ),
  patchSessionRuntimeSettings: (
    token: string,
    sessionId: string,
    settings: Record<string, unknown>,
  ) =>
    request<RuntimeSettingsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime-settings`,
      { method: "PATCH", body: JSON.stringify({ settings }) },
      token,
    ),
  getConnectorPreferences: (token: string, connectorId: string) =>
    request<ConnectorPreferencesResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/preferences`,
      {},
      token,
    ),
  getConnectorRuntimeCapabilities: (token: string, connectorId: string) =>
    request<RuntimeCapabilitiesResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-capabilities`,
      {},
      token,
    ),
  scanConnectorRuntime: (
    token: string,
    connectorId: string,
    body: { runtime: string; path?: string },
  ) =>
    request<ScanRuntimeResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-capabilities/scan`,
      { method: "POST", body: JSON.stringify(body) },
      token,
    ),
  deleteConnectorRuntime: (
    token: string,
    connectorId: string,
    runtime: string,
  ) =>
    request<RuntimeCapabilitiesResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-capabilities/${encodeURIComponent(runtime)}`,
      { method: "DELETE" },
      token,
    ),
  uploadSessionAttachments: async (
    token: string,
    sessionId: string,
    files: File[],
  ): Promise<UserUploadResponse> => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(
        `${BASE}/sessions/${encodeURIComponent(sessionId)}/attachments`,
        { method: "POST", body: form, headers },
      );
    } catch (err) {
      throw new ApiError(0, err instanceof Error ? err.message : "network error");
    }
    const text = await res.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!res.ok) {
      const detail = extractErrorDetail(payload) || `HTTP ${res.status}`;
      throw new ApiError(res.status, detail);
    }
    return payload as UserUploadResponse;
  },
  interruptSession: (token: string, sessionId: string) =>
    request<RpcResponsePayload>(
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST", body: "{}" },
      token,
    ),
  enableTakeover: (token: string, sessionId: string) =>
    request<TakeoverResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/takeover`,
      { method: "POST", body: "{}" },
      token,
    ),
  disableTakeover: (token: string, sessionId: string) =>
    request<TakeoverResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/takeover`,
      { method: "DELETE" },
      token,
    ),
  resolveApproval: (
    token: string,
    approvalId: string,
    status: ApprovalResolveStatus,
  ) =>
    request<RpcResponsePayload>(
      `/approvals/${encodeURIComponent(approvalId)}/resolve`,
      { method: "POST", body: JSON.stringify({ status }) },
      token,
    ),
};
