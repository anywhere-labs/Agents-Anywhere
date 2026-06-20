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

export type SessionListResponse = {
  sessions: SessionView[];
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

export type SessionPatchRequest = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
};

export type DashboardState = {
  me: AuthMe;
  connectors: ConnectorView[];
  sessions: SessionView[];
};
