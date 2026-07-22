import type { AuthMe } from "@/features/auth";

export type ConnectorStatus = "offline" | "online";

export type ConnectorView = {
  id: string;
  userId: string;
  name: string;
  deviceOs?: "macos" | "windows" | "linux" | null;
  status: ConnectorStatus;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error"
  | "unknown";

export type DeviceRuntimeView = {
  connectorId: string;
  runtimeId: string;
  runtimeType: string;
  displayName: string;
  present: boolean;
  configured: boolean;
  active: boolean;
  status: DeviceRuntimeStatus;
  discovery: Record<string, unknown>;
  schema: Record<string, unknown> | null;
  uiSchema: Record<string, unknown>;
  config: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  lastDiscoveredAt: string;
  updatedAt: string;
};

export type DeviceRuntimeListResponse = {
  connectorId: string;
  runtimes: DeviceRuntimeView[];
  serverTime: string;
};

export type SessionStatusValue =
  | "idle"
  | "pending"
  | "running"
  | "stopping"
  | "blocked";

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
  modelSelectionId?: string | null;
  permissionSelectionId?: string | null;
};

export type ConnectorListResponse = {
  connectors: ConnectorView[];
  serverTime: string;
};

export type ConnectorResponse = {
  connector: ConnectorView;
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
  modelSelectionId?: string | null;
  permissionSelectionId?: string | null;
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

export type ProtocolCapabilityScope = "adapter" | "runtime" | "session";

export type ProtocolCapability = {
  capabilityId: string;
  version: string;
  scope: ProtocolCapabilityScope;
  runtime?: string | null;
  sessionId?: string | null;
  supported: boolean;
  available: boolean;
  allowed: boolean;
  unavailableReason?: string | null;
  parameters: Record<string, unknown>;
};

export type ProtocolCapabilitySet = {
  revision: number;
  capabilities: ProtocolCapability[];
};

export type ProtocolReasoningItem = {
  displayName: string;
  id: string;
  fullModelId?: string | null;
  selectionId: string;
  description?: string | null;
  default: boolean;
  metadata: Record<string, unknown>;
};

export type ProtocolModelItem = {
  displayName: string;
  id: string;
  selectionId?: string | null;
  description?: string | null;
  default: boolean;
  reasoningItems: ProtocolReasoningItem[];
  metadata: Record<string, unknown>;
};

export type ProtocolModelCatalog = {
  runtime: string;
  revision: number;
  models: ProtocolModelItem[];
};

export type ProtocolModelCatalogResponse = {
  catalog: ProtocolModelCatalog;
  serverTime: string;
};

export type ProtocolPermissionItem = {
  displayName: string;
  id: string;
  selectionId: string;
  description?: string | null;
  default: boolean;
  metadata: Record<string, unknown>;
};

export type ProtocolPermissionCatalog = {
  runtime: string;
  revision: number;
  permissions: ProtocolPermissionItem[];
};

export type ProtocolPermissionCatalogResponse = {
  catalog: ProtocolPermissionCatalog;
  serverTime: string;
};

export type NoticeStatus =
  | "open"
  | "response_accepted"
  | "resolving"
  | "resolved"
  | "expired"
  | "cancelled"
  | "failed";

export type NoticeActionStyle = "primary" | "secondary" | "danger";

export type NoticeAction = {
  actionId: string;
  label: string;
  style: NoticeActionStyle;
  input: {
    required: boolean;
    schema?: Record<string, unknown> | null;
    uiSchema?: Record<string, unknown> | null;
  };
};

export type Notice = {
  noticeId: string;
  type: "notification" | "interaction";
  sessionId: string;
  source: Record<string, unknown>;
  title: string;
  message?: string | null;
  severity: "info" | "success" | "warning" | "error";
  status: NoticeStatus;
  interactionType?: "approval" | "execution_error" | "confirmation" | "input_request" | "unknown" | null;
  blocking?: { scope: "session"; targetId: string } | null;
  responseRequired: boolean;
  actions: NoticeAction[];
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  expiresAt?: string | null;
  revision: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
};

export type SessionTimelineSnapshot = {
  items: TimelineItem[];
  nextSeq: number;
  hasMore: boolean;
};

export type SessionSnapshotResponse = {
  session: SessionView;
  timeline: SessionTimelineSnapshot;
  approvals?: Approval[];
  notices: Notice[];
  effectiveCapabilities: ProtocolCapabilitySet;
  runtimeCapabilities: ProtocolCapabilitySet;
  catalogs: {
    model?: ProtocolModelCatalog;
    permission?: ProtocolPermissionCatalog;
    [key: string]: unknown;
  };
  eventCursor: string;
  serverTime: string;
};

export type ProtocolEventEnvelope = {
  protocolVersion?: string;
  eventId?: string;
  sequence: number;
  cursor: string;
  type: string;
  sessionId: string;
  emittedAt?: string;
  payload: Record<string, unknown>;
};

export type ProtocolEventRecoveryResponse = {
  events: ProtocolEventEnvelope[];
  nextCursor: string;
  snapshotRequired: boolean;
  serverTime: string;
};

export type WsTicketResponse = {
  ticket: string;
  expiresAt: string;
  serverTime: string;
};

export type SessionStateResponse = {
  session: SessionView;
  items: TimelineItem[];
  approvals: Approval[];
  notices?: Notice[];
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
  modelSelectionId?: string | null;
  permissionSelectionId?: string | null;
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

export type DashboardSegment = "light" | "medium" | "heavy";

export type AdminDashboardIntensitySettings = {
  basis: "turns";
  lightMax: number;
  mediumMax: number;
};

export type AdminDashboardHistogramSettings = {
  turns: number[];
  sessions: number[];
};

export type AdminDashboardSettings = {
  intensity: AdminDashboardIntensitySettings;
  histogramBins: AdminDashboardHistogramSettings;
  serverTime?: string | null;
};

export type AdminDashboardSettingsUpdate = {
  intensity?: AdminDashboardIntensitySettings;
  histogramBins?: AdminDashboardHistogramSettings;
};

export type AdminDashboardSummary = {
  totalUsers: number;
  newUsers: number;
  dau: number;
  activeUsers: number;
  wau: number;
  mau: number;
  totalTurns: number;
  activeSessions: number;
  avgTurnsPerActiveUser: number;
  avgActiveSessionsPerActiveUser: number;
  totalDevices: number;
  avgDevicesPerUser: number;
};

export type AdminDashboardSeriesPoint = AdminDashboardSummary & {
  date: string;
};

export type AdminDashboardBreakdownItem = {
  key: string;
  label: string;
  value: number;
  percent: number;
};

export type AdminDashboardHistogramBucket = {
  key: string;
  label: string;
  count: number;
  min: number | null;
  max: number | null;
};

export type AdminDashboardUserSegmentItem = {
  segment: DashboardSegment;
  label: string;
  count: number;
};

export type AdminDashboardOverviewResponse = {
  range: {
    fromDate: string;
    toDate: string;
    timezone: string;
  };
  summary: AdminDashboardSummary;
  series: AdminDashboardSeriesPoint[];
  turnHistogram: AdminDashboardHistogramBucket[];
  sessionHistogram: AdminDashboardHistogramBucket[];
  userSegments: AdminDashboardUserSegmentItem[];
  deviceBreakdown: AdminDashboardBreakdownItem[];
  agentBreakdown: AdminDashboardBreakdownItem[];
  sessionAgentBreakdown: AdminDashboardBreakdownItem[];
  settings: AdminDashboardSettings;
  serverTime: string;
};

export type AdminDashboardSnapshotResponse = {
  date: string;
  computedAt: string;
  metrics: number;
  users: number;
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
