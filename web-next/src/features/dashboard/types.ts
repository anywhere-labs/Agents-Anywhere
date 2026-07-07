import type { AuthMe } from "@/features/auth";

export type ConnectorStatus = "offline" | "online";

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
  report: RuntimeReport;
  attachedAt: string;
};

export type DeviceAgentsState = {
  version: number;
  lastDiscoveredAt: string | null;
  attached: Record<string, AttachedAgent>;
  disabled: string[];
};

export type ConnectorView = {
  id: string;
  userId: string;
  name: string;
  deviceOs?: "macos" | "windows" | "linux" | null;
  status: ConnectorStatus;
  lastSeenAt: string | null;
  runtimeCapabilities: DeviceAgentsState;
  createdAt: string;
  updatedAt: string;
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

export type ConnectorListResponse = {
  connectors: ConnectorView[];
  serverTime: string;
};

export type ConnectorResponse = {
  connector: ConnectorView;
  serverTime: string;
};

export type ConnectorRuntimeCapabilitiesResponse = {
  connectorId: string;
  runtimeCapabilities: DeviceAgentsState;
  serverTime: string;
};

export type ConnectorRuntimeScanResponse = {
  connectorId: string;
  runtimeCapabilities: DeviceAgentsState;
  scanned: {
    runtime?: string;
    report?: RuntimeReport;
  };
  serverTime: string;
};

export type ConnectorCreateResponse = {
  connector: ConnectorView;
  connectorToken: string;
  tokenPrefix: string;
};

export type ConnectorRevokeResponse = {
  connector: ConnectorView;
  connectorToken: string;
  tokenPrefix: string;
  serverTime: string;
};

export type PairingStartResponse = {
  pairingId: string;
  code: string;
  expiresAt: string;
  serverTime: string;
};

export type PairingClaimResponse = {
  status: string;
  connector: ConnectorView | null;
};

export type PairingPollResponse = {
  status: string;
  config: {
    serverUrl: string;
    connectorId: string;
    connectorToken: string;
  } | null;
  expiresAt: string | null;
};

export type SessionListResponse = {
  sessions: SessionView[];
  serverTime: string;
};

export type ArchiveAllScope = "active" | "archived" | "all";

export type ArchiveAllResponse = {
  sessions: SessionView[];
  affected: number;
  serverTime: string;
};

export type SessionResponse = {
  session: SessionView;
  serverTime: string;
};

export type SessionCreateRequest = {
  connectorId: string;
  runtime: string;
  title?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
};

export type SessionCreateResponse = {
  session: SessionView;
  connectorResult: unknown;
};

export type TakeoverResponse = {
  session: SessionView;
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

export type ApprovalResolveStatus =
  | "approved"
  | "approved_for_session"
  | "rejected";

export type SessionStateResponse = {
  session: SessionView;
  items: TimelineItem[];
  approvals: Approval[];
  nextSeq: number;
  hasMore: boolean;
  serverTime: string;
};

export type SessionPatchRequest = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
};

export type FsEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | string;
  size?: number | null;
  modifiedAt?: string | null;
};

export type FsListResult = {
  path: string;
  entries: FsEntry[];
  truncated?: boolean;
};

export type FsReadTextResult = {
  path: string;
  name: string;
  size: number;
  sha256: string;
  encoding: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  serverTime: string;
};

export type FsPreviewTokenCreateResponse = {
  previewToken: string;
  expiresAt: string;
  serverTime: string;
};

export type FsPreviewSessionResponse = {
  previewAccessToken: string;
  expiresAt: string;
  connectorId: string;
  root: string;
  path: string;
  serverTime: string;
};

export type FsReadFileResult = {
  path: string;
  name: string;
  size: number;
  sha256: string;
  mediaType?: string;
  transferId: string;
  token: string;
  downloadUrl: string;
};

export type FsWriteResult = {
  path: string;
  encoding: string;
  bytesWritten: number;
  sha256: string;
};

export type RpcResponse<T> = {
  ok: boolean;
  result: T;
};

export type TerminalView = {
  terminalId: string;
  sessionId: string;
  label: string;
  root: string;
  cwd: string;
  cols: number;
  rows: number;
  purpose: "user" | "primary_claude";
  pid: number | null;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
  scrollbackBytes: number;
  scrollbackSeq: number;
  ephemeralGroupId?: string | null;
  createdAt: string;
};

export type TerminalCreateRequest = {
  cols: number;
  rows: number;
  label?: string;
  cwd?: string;
  shell?: string;
  command?: string;
  args?: string[];
  profile?: string;
  ephemeralGroupId?: string;
};

export type TerminalListResponse = {
  terminals: TerminalView[];
  serverTime: string;
};

export type TerminalListResult = {
  terminals: TerminalView[];
};

export type TerminalResponse = {
  terminal: TerminalView;
};

export type TerminalSnapshotResult = {
  terminal: TerminalView;
  baseSeq: number;
  seq: number;
  dataBase64: string;
  outputs?: Array<{ seq: number; dataBase64: string }>;
};

export type AttachmentRef = {
  fileId: string;
  name?: string;
  size?: number;
  mediaType?: string;
  sha256?: string;
};

export type MessageSendOptions = {
  attachments?: AttachmentRef[];
  clientMessageId?: string;
  mode?: string;
  model?: string;
  effort?: string;
};

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

export type AttachmentUploadResponse = {
  attachments: UploadedAttachment[];
  serverTime: string;
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
  settings?: Record<string, unknown>;
  runtimeSettings?: Record<string, unknown>;
  runtimeSettingsOverride?: Record<string, unknown> | null;
  effectiveRunMode?: "chat" | "terminal" | null;
  defaultRunModeConfigured?: boolean;
  schemaVersion?: number;
  serverTime: string;
};

export type AgentCatalogEntry = {
  runtime: string;
  key: string;
  displayLabel: string;
  description?: string | null;
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

export type DashboardState = {
  me: AuthMe;
  connectors: ConnectorView[];
  sessions: SessionView[];
};

export type BulkArchiveResponse = {
  sessions: SessionView[];
  notFound: string[];
  serverTime: string;
};
