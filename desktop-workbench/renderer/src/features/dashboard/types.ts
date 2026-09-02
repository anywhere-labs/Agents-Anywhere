import type { AuthMe } from "@/features/auth";
import type {
  ProtocolCapability,
  ProtocolCapabilitySet,
  ProtocolCapabilitiesResponse,
} from "@/generated/protocol/v1/capabilities-response";
import type { ProtocolModelCatalog } from "@/generated/protocol/v1/model-catalog-response";
import type { ProtocolPermissionCatalog } from "@/generated/protocol/v1/permission-catalog-response";
import type { ProtocolSessionSnapshotResponse } from "@/generated/protocol/v1/session-snapshot-response";
import type { ProtocolWsTicketResponse } from "@/generated/protocol/v1/ws-ticket-response";

export type {
  ProtocolEventEnvelope,
  ProtocolEventRecoveryResponse,
} from "@/generated/protocol/v1/event-recovery-response";
export type {
  ProtocolModelCatalog,
  ProtocolModelCatalogResponse,
  ProtocolModelItem,
  ProtocolReasoningItem,
} from "@/generated/protocol/v1/model-catalog-response";
export type {
  ProtocolPermissionCatalog,
  ProtocolPermissionCatalogResponse,
  ProtocolPermissionItem,
} from "@/generated/protocol/v1/permission-catalog-response";

export type { ProtocolCapability, ProtocolCapabilitySet, ProtocolCapabilitiesResponse };

export type ConnectorStatus = "offline" | "online";

export type ConnectorView = {
  id: string;
  userId: string;
  name: string;
  deviceOs?: "macos" | "windows" | "linux" | null;
  connectorKind?: "desktop" | "cli" | null;
  status: ConnectorStatus;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceRuntimeStatus =
  | "stopped"
  | "discovering"
  | "available"
  | "unavailable"
  | "validating"
  | "starting"
  | "running"
  | "stopping"
  | "error"
  | "unknown";

export type DeviceRuntimeView = {
  connectorId: string;
  runtimeId: string;
  runtimeType: string;
  name?: string;
  displayName: string;
  typeDisplayName?: string;
  present: boolean;
  available?: boolean;
  configured: boolean;
  active: boolean;
  status: DeviceRuntimeStatus;
  discovery: Record<string, unknown>;
  metadata: Record<string, unknown>;
  schema: Record<string, unknown> | null;
  uiSchema: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  config: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  lastDiscoveredAt: string;
  createdAt?: string;
  updatedAt: string;
};

export type RuntimeInstancePolicy = "single" | "multiple";

export type RuntimeTypeView = {
  connectorId: string;
  runtimeType: string;
  implementationType: string;
  displayName: string;
  description: string | null;
  present: boolean;
  available: boolean;
  reason: string | null;
  recommended: boolean;
  recommendationRank: number | null;
  discovery: Record<string, unknown>;
  schema: Record<string, unknown> | null;
  uiSchema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  capabilities: Record<string, boolean>;
  metadata: Record<string, unknown>;
  instancePolicy: RuntimeInstancePolicy;
  maxInstances: number | null;
  lastDiscoveredAt: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeTypeListResponse = {
  connectorId: string;
  runtimeTypes: RuntimeTypeView[];
  serverTime: string;
};

export type DeviceRuntimeListResponse = {
  connectorId: string;
  runtimes: DeviceRuntimeView[];
  serverTime: string;
};

export type SessionStatusValue =
  | "idle"
  | "waiting"
  | "pending"
  | "running"
  | "stopping"
  | "waiting_approval"
  | "error"
  | "blocked";

export type RuntimeStatusValue = SessionStatusValue | "error" | "disconnected";

export type SessionView = {
  id: string;
  connectorId: string;
  connectorStatus: ConnectorStatus;
  runtime: string;
  runtimeId?: string;
  runtimeType?: string;
  runtimeName?: string | null;
  runtimeTypeDisplayName?: string | null;
  externalSessionId: string | null;
  title: string | null;
  cwd: string | null;
  status: SessionStatusValue;
  takeover: boolean;
  pinned: boolean;
  pinnedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  userArchived?: boolean;
  sourceAvailability?: "available" | "archived" | "unavailable" | "deleted" | "missing" | "unknown";
  sourceAvailabilityReason?: string | null;
  sourceAvailabilityUpdatedAt?: string | null;
  sourceObservationOrigin?: "event" | "inventory" | "operation" | null;
  archiveSource?: "user" | "runtime" | "both" | null;
  unread: boolean;
  lastReadSeq: number;
  latestTurnEndSeq: number;
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
  hasMore: boolean;
  nextCursor: string | null;
  serverTime: string;
};

export type SessionPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

export type SessionCommandResponse = {
  command: string;
  ok: boolean;
  code: string | null;
  message: string | null;
  result: unknown;
  session: SessionView | null;
  serverTime: string;
};

export type RuntimeCommand = {
  id: string;
  title: string;
  description: string | null;
  aliases: string[];
  category: string | null;
  scope: "runtime" | "session" | "turn" | string;
  enabled: boolean;
  disabledReason: string | null;
  acceptsArgs: boolean;
  argsSchema: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export type SessionCommandListResponse = {
  commands: RuntimeCommand[];
  serverTime: string;
};

export type DashboardSnapshotMessage = {
  type: "dashboard.snapshot";
  connectors: ConnectorView[];
  sessions: SessionView[];
  sessionPages: {
    active: SessionPageInfo;
    archived: SessionPageInfo;
  };
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
  runtimeId?: string;
  externalSessionId?: string | null;
  title?: string;
  cwd?: string;
  selections?: Record<string, string | null>;
};

export type SessionCreateAndStartRequest = {
  connectorId: string;
  runtime: string;
  runtimeId?: string;
  title?: string;
  cwd?: string;
  content: string;
  selections?: Record<string, string | null>;
  attachments?: InlineAttachmentRef[];
  clientMessageId?: string | null;
};

export type SessionCreateResponse = {
  session: SessionView;
  connectorResult: unknown;
  attachments?: AttachmentRef[];
};

export type TakeoverResponse = {
  session: SessionView;
  serverTime: string;
};

export type TimelineType =
  | "message"
  | "tool"
  | "artifact"
  | "marker"
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

export type AgentCallAction =
  | "invoke"
  | "spawn"
  | "send_input"
  | "resume"
  | "wait"
  | "close"
  | "unknown";

export type AgentCallTimelineContent = {
  kind: "agent_call";
  action: AgentCallAction;
  title?: string;
  description?: string;
  agentType?: string;
  prompt?: string;
  runInBackground?: boolean;
  parentItemId?: string;
  agentId?: string;
  callerId?: string;
  targetIds?: string[];
  model?: string;
  reasoningEffort?: string;
  agents?: Record<string, { status?: string; message?: string | null }>;
  usage?: { durationMs?: number; tokens?: number; toolCalls?: number };
  input?: unknown;
  output?: unknown;
};

export type TimelineItem = {
  id: string;
  sessionId: string;
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

export type SessionShareScope = "message" | "session";

export type SessionShareCreateRequest = {
  scope: SessionShareScope;
  itemIds: string[];
};

export type SessionShareCreateResponse = {
  shareId: string;
  sharePath: string;
  shareUrl: string;
  scope: SessionShareScope;
  createdAt: string;
};

export type PublicSessionShareResponse = {
  shareId: string;
  scope: SessionShareScope;
  session: {
    id: string;
    title: string | null;
    runtime: string;
    runtimeName: string | null;
    cwd: string | null;
  };
  items: TimelineItem[];
  createdAt: string;
  serverTime: string;
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

export type ProtocolCapabilityScope = ProtocolCapability["scope"];

export type NoticeStatus =
  | "open"
  | "responding"
  | "response_accepted"
  | "resolving"
  | "resolved"
  | "closed"
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

export type SessionTimelineResponse = SessionTimelineSnapshot & {
  sessionId: string;
  serverTime: string;
};

export type SessionSnapshotResponse = Pick<
  ProtocolSessionSnapshotResponse,
  "eventCursor" | "serverTime"
> & {
  session: SessionView;
  state?: SessionRuntimeState | null;
  timeline: SessionTimelineSnapshot;
  notices: Notice[];
  effectiveCapabilities: ProtocolCapabilitySet;
  runtimeCapabilities: ProtocolCapabilitySet;
  catalogs: {
    model?: ProtocolModelCatalog;
    permission?: ProtocolPermissionCatalog;
    [key: string]: unknown;
  };
};

export type WsTicketResponse = ProtocolWsTicketResponse;

export type SessionLocalTimelineState = {
  session: SessionView;
  state?: SessionRuntimeState | null;
  items: TimelineItem[];
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
  error?: {
    code?: string;
    message?: string;
  };
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

export type InlineAttachmentRef = AttachmentRef & {
  name: string;
  contentBase64: string;
};

export type MessageSendOptions = {
  attachments?: AttachmentRef[];
  clientMessageId?: string;
};

export type SessionRuntimeState = {
  sessionId: string;
  runtime: string;
  runtimeId?: string;
  runtimeType?: string;
  externalSessionId?: string | null;
  status: RuntimeStatusValue;
  selections: Record<string, string | null>;
  statusReason?: string | null;
  error?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionRuntimeStateResponse = {
  state: SessionRuntimeState;
  serverTime: string;
};

export type SessionSelectionPatchResponse = {
  ok: boolean;
  state?: SessionRuntimeState | null;
  connectorResult?: Record<string, unknown> | null;
  serverTime: string;
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
  basis: "messages";
  lightMax: number;
  mediumMax: number;
};

export type AdminDashboardHistogramSettings = {
  messages: number[];
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
  totalMessages: number;
  activeSessions: number;
  avgMessagesPerActiveUser: number;
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
  messageHistogram: AdminDashboardHistogramBucket[];
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

export type AppReleasePlatform = "android" | "desktop";

export type AppReleaseView = {
  platform: AppReleasePlatform;
  versionCode: number;
  versionName: string;
  downloadUrl: string | null;
  published: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AppReleaseListResponse = {
  releases: AppReleaseView[];
  serverTime: string;
};

export type AppReleaseCreateRequest = {
  platform: AppReleasePlatform;
  versionCode: number;
  versionName: string;
  downloadUrl: string;
  published: boolean;
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
