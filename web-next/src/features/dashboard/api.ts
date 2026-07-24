import { ApiClient, apiClient } from "@/lib/api";
import type {
  AgentCatalogResponse,
  AdminDashboardOverviewResponse,
  AdminDashboardSettings,
  AdminDashboardSettingsUpdate,
  AdminDashboardSnapshotResponse,
  ArchiveAllResponse,
  BulkArchiveResponse,
  ArchiveAllScope,
  AttachmentUploadResponse,
  ApprovalResolveStatus,
  ConnectorCreateResponse,
  ConnectorListResponse,
  ConnectorResponse,
  ConnectorRevokeResponse,
  ConnectorAgentAuthenticateResponse,
  ConnectorRuntimeCapabilitiesResponse,
  ConnectorRuntimeScanResponse,
  FsListResult,
  FsPreviewSessionResponse,
  FsPreviewTokenCreateResponse,
  FsReadFileResult,
  FsReadTextResult,
  FsWriteResult,
  MessageSendOptions,
  PairingClaimResponse,
  PairingPollResponse,
  PairingStartResponse,
  RpcResponse,
  RuntimeConfigSchemaResponse,
  RuntimeSettingsResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionListResponse,
  SessionPatchRequest,
  SessionResponse,
  SessionStateResponse,
  TakeoverResponse,
  TerminalCreateRequest,
  TerminalListResult,
  TerminalListResponse,
  TerminalResponse,
  TerminalSnapshotResult,
  UserAgentDefaultsResponse
} from "@/features/dashboard/types";

export type SessionStateQuery = {
  afterSeq?: number;
  beforeOrderSeq?: number;
  mode?: "since" | "latest" | "before";
  limit?: number;
};

export class DashboardApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  getAdminDashboardOverview(
    token: string,
    query: { from?: string; to?: string; tz?: string } = {},
  ): Promise<AdminDashboardOverviewResponse> {
    return this.client.get<AdminDashboardOverviewResponse>(
      "/admin/dashboard/overview",
      { token, query },
    );
  }

  getAdminDashboardSettings(token: string): Promise<AdminDashboardSettings> {
    return this.client.get<AdminDashboardSettings>("/admin/dashboard/settings", { token });
  }

  updateAdminDashboardSettings(
    token: string,
    body: AdminDashboardSettingsUpdate,
  ): Promise<AdminDashboardSettings> {
    return this.client.patch<AdminDashboardSettings>(
      "/admin/dashboard/settings",
      body,
      { token },
    );
  }

  refreshAdminDashboardToday(
    token: string,
    tz = "Asia/Shanghai",
  ): Promise<AdminDashboardSnapshotResponse> {
    return this.client.post<AdminDashboardSnapshotResponse>(
      "/admin/dashboard/snapshots/today",
      {},
      { token, query: { tz } },
    );
  }

  listConnectors(token: string): Promise<ConnectorListResponse> {
    return this.client.get<ConnectorListResponse>("/connectors", { token });
  }

  createConnector(token: string, name: string): Promise<ConnectorCreateResponse> {
    return this.client.post<ConnectorCreateResponse>("/connectors", { name }, { token });
  }

  getConnector(token: string, connectorId: string): Promise<ConnectorResponse> {
    return this.client.get<ConnectorResponse>(
      `/connectors/${encodeURIComponent(connectorId)}`,
      { token },
    );
  }

  updateConnector(
    token: string,
    connectorId: string,
    body: { name?: string | null },
  ): Promise<ConnectorResponse> {
    return this.client.patch<ConnectorResponse>(
      `/connectors/${encodeURIComponent(connectorId)}`,
      body,
      { token },
    );
  }

  deleteConnector(token: string, connectorId: string): Promise<void> {
    return this.client.delete<void>(
      `/connectors/${encodeURIComponent(connectorId)}`,
      { token },
    );
  }

  revokeConnector(token: string, connectorId: string): Promise<ConnectorRevokeResponse> {
    return this.client.post<ConnectorRevokeResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/revoke`,
      {},
      { token },
    );
  }

  startPairing(body: { serverUrl?: string | null; ttlSeconds?: number }): Promise<PairingStartResponse> {
    return this.client.post<PairingStartResponse>("/pairing/start", body, { auth: false });
  }

  claimPairing(
    token: string,
    body: {
      code: string;
      name?: string;
      serverUrl?: string | null;
      connectorId?: string | null;
      connectorToken?: string | null;
    },
  ): Promise<PairingClaimResponse> {
    return this.client.post<PairingClaimResponse>("/pairing/claim", body, { token });
  }

  pollPairing(pairingId: string): Promise<PairingPollResponse> {
    return this.client.post<PairingPollResponse>("/pairing/poll", { pairingId }, { auth: false });
  }

  listSessions(token: string): Promise<SessionListResponse> {
    return this.client.get<SessionListResponse>("/sessions", { token });
  }

  archiveConnectorSessions(
    token: string,
    connectorId: string,
    body: { archived: boolean; scope?: ArchiveAllScope },
  ): Promise<ArchiveAllResponse> {
    return this.client.post<ArchiveAllResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/sessions/archive-all`,
      body,
      { token },
    );
  }

  createSession(
    token: string,
    body: SessionCreateRequest,
  ): Promise<SessionCreateResponse> {
    return this.client.post<SessionCreateResponse>("/sessions", body, { token });
  }

  patchSession(
    token: string,
    sessionId: string,
    body: SessionPatchRequest,
  ): Promise<SessionResponse> {
    return this.client.patch<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      body,
      { token },
    );
  }

  bulkMarkSessionsRead(token: string, ids: string[]): Promise<BulkArchiveResponse> {
    return this.client.post<BulkArchiveResponse>("/sessions/bulk-read", { ids }, { token });
  }

  bulkArchiveSessions(
    token: string,
    ids: string[],
    archived: boolean,
  ): Promise<BulkArchiveResponse> {
    return this.client.post<BulkArchiveResponse>(
      "/sessions/bulk-archive",
      { ids, archived },
      { token },
    );
  }

  markSessionRead(token: string, sessionId: string): Promise<SessionResponse> {
    return this.client.post<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/read`,
      {},
      { token },
    );
  }

  getSessionState(
    token: string,
    sessionId: string,
    afterSeqOrQuery: number | SessionStateQuery = 0,
    limit = 500,
  ): Promise<SessionStateResponse> {
    const query =
      typeof afterSeqOrQuery === "number"
        ? { afterSeq: afterSeqOrQuery, limit }
        : { ...afterSeqOrQuery, limit: afterSeqOrQuery.limit ?? limit };
    return this.client.get<SessionStateResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/state`,
      { token, query },
    );
  }

  getLatestSessionState(
    token: string,
    sessionId: string,
    limit = 100,
  ): Promise<SessionStateResponse> {
    return this.getSessionState(token, sessionId, { mode: "latest", limit });
  }

  getSessionStateBefore(
    token: string,
    sessionId: string,
    beforeOrderSeq: number,
    limit = 100,
  ): Promise<SessionStateResponse> {
    return this.getSessionState(token, sessionId, {
      mode: "before",
      beforeOrderSeq,
      limit,
    });
  }

  sessionEventsUrl(token: string, sessionId: string): string {
    return `/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token)}`;
  }

  dashboardEventsUrl(token: string): string {
    return `/sessions/events/dashboard?token=${encodeURIComponent(token)}`;
  }

  connectorFsList(
    token: string,
    connectorId: string,
    body: { root: string; path?: string | null },
  ): Promise<RpcResponse<FsListResult>> {
    return this.client.post<RpcResponse<FsListResult>>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/list`,
      body,
      { token },
    );
  }

  connectorFsReadText(
    token: string,
    connectorId: string,
    root: string,
    path: string,
    maxBytes: number,
  ): Promise<FsReadTextResult> {
    return this.client.post<FsReadTextResult>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/readText`,
      { path, maxBytes },
      { token, query: { root } },
    );
  }

  connectorFsRead(
    token: string,
    connectorId: string,
    root: string,
    path: string,
  ): Promise<RpcResponse<FsReadFileResult>> {
    return this.client.post<RpcResponse<FsReadFileResult>>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/read`,
      { path },
      { token, query: { root } },
    );
  }

  createConnectorFsPreviewToken(
    token: string,
    connectorId: string,
    root: string,
    path: string,
  ): Promise<FsPreviewTokenCreateResponse> {
    return this.client.post<FsPreviewTokenCreateResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/preview-token`,
      { path },
      { token, query: { root } },
    );
  }

  createConnectorFsPreviewSession(previewToken: string): Promise<FsPreviewSessionResponse> {
    return this.client.post<FsPreviewSessionResponse>(
      "/connectors/fs/preview-session",
      { previewToken },
      { auth: false },
    );
  }

  connectorFsPreviewReadText(previewAccessToken: string, maxBytes: number): Promise<FsReadTextResult> {
    return this.client.post<FsReadTextResult>(
      "/connectors/fs/preview/readText",
      { previewAccessToken, maxBytes },
      { auth: false },
    );
  }

  connectorFsPreviewRead(previewAccessToken: string): Promise<RpcResponse<FsReadFileResult>> {
    return this.client.post<RpcResponse<FsReadFileResult>>(
      "/connectors/fs/preview/read",
      { previewAccessToken },
      { auth: false },
    );
  }

  connectorFsWrite(
    token: string,
    connectorId: string,
    root: string,
    body: { path: string; content: string; ifMatch?: string },
  ): Promise<RpcResponse<FsWriteResult>> {
    return this.client.post<RpcResponse<FsWriteResult>>(
      `/connectors/${encodeURIComponent(connectorId)}/fs/write`,
      body,
      { token, query: { root } },
    );
  }

  async downloadBlob(token: string | null, url: string): Promise<Blob> {
    const headers: HeadersInit = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      headers,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.blob();
  }

  connectorTerminalList(token: string, connectorId: string): Promise<TerminalListResponse> {
    return this.client.get<TerminalListResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals`,
      { token },
    );
  }

  connectorTerminalCreate(
    token: string,
    connectorId: string,
    root: string,
    body: TerminalCreateRequest,
  ): Promise<TerminalResponse> {
    return this.client.post<TerminalResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals`,
      body,
      { token, query: { root } },
    );
  }

  connectorTerminalListV2(token: string, connectorId: string): Promise<RpcResponse<TerminalListResult>> {
    return this.client.get<RpcResponse<TerminalListResult>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2`,
      { token },
    );
  }

  connectorTerminalCreateV2(
    token: string,
    connectorId: string,
    root: string,
    body: TerminalCreateRequest,
  ): Promise<RpcResponse<TerminalResponse["terminal"]>> {
    return this.client.post<RpcResponse<TerminalResponse["terminal"]>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2`,
      body,
      { token, query: { root } },
    );
  }

  connectorTerminalRename(
    token: string,
    connectorId: string,
    terminalId: string,
    label: string,
  ): Promise<TerminalResponse> {
    return this.client.patch<TerminalResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals/${encodeURIComponent(terminalId)}`,
      { label },
      { token },
    );
  }

  connectorTerminalClose(
    token: string,
    connectorId: string,
    terminalId: string,
  ): Promise<TerminalResponse> {
    return this.client.delete<TerminalResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals/${encodeURIComponent(terminalId)}`,
      { token },
    );
  }

  connectorTerminalCloseV2(
    token: string,
    connectorId: string,
    terminalId: string,
  ): Promise<RpcResponse<unknown>> {
    return this.client.delete<RpcResponse<unknown>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}`,
      { token },
    );
  }

  connectorTerminalRenameV2(
    token: string,
    connectorId: string,
    terminalId: string,
    label: string,
  ): Promise<RpcResponse<TerminalResponse["terminal"]>> {
    return this.client.patch<RpcResponse<TerminalResponse["terminal"]>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}`,
      { label },
      { token },
    );
  }

  connectorTerminalResize(
    token: string,
    connectorId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalResponse> {
    return this.client.post<TerminalResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals/${encodeURIComponent(terminalId)}/resize`,
      { cols, rows },
      { token },
    );
  }

  connectorTerminalResizeV2(
    token: string,
    connectorId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<RpcResponse<unknown>> {
    return this.client.post<RpcResponse<unknown>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}/resize`,
      { cols, rows },
      { token },
    );
  }

  connectorTerminalWriteV2(
    token: string,
    connectorId: string,
    terminalId: string,
    dataBase64: string,
  ): Promise<RpcResponse<unknown>> {
    return this.client.post<RpcResponse<unknown>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}/write`,
      { dataBase64 },
      { token },
    );
  }

  connectorTerminalSnapshotV2(
    token: string,
    connectorId: string,
    terminalId: string,
    fromSeq = 0,
  ): Promise<RpcResponse<TerminalSnapshotResult>> {
    return this.client.get<RpcResponse<TerminalSnapshotResult>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}/snapshot`,
      { token, query: { fromSeq } },
    );
  }

  enableTakeover(token: string, sessionId: string): Promise<TakeoverResponse> {
    return this.client.post<TakeoverResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/takeover`,
      {},
      { token },
    );
  }

  disableTakeover(token: string, sessionId: string): Promise<TakeoverResponse> {
    return this.client.delete<TakeoverResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/takeover`,
      { token },
    );
  }

  interruptSession(token: string, sessionId: string): Promise<RpcResponse<unknown>> {
    return this.client.post<RpcResponse<unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {},
      { token },
    );
  }

  resolveApproval(
    token: string,
    approvalId: string,
    status: ApprovalResolveStatus,
  ): Promise<RpcResponse<unknown>> {
    return this.client.post<RpcResponse<unknown>>(
      `/approvals/${encodeURIComponent(approvalId)}/resolve`,
      { status },
      { token },
    );
  }

  sendSessionMessage(
    token: string,
    sessionId: string,
    content: string,
    options: MessageSendOptions = {},
  ): Promise<RpcResponse<unknown>> {
    const { attachments, clientMessageId, mode, model, effort } = options;
    return this.client.post<RpcResponse<unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        content,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(mode ? { mode } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      },
      { token },
    );
  }

  uploadSessionAttachments(
    token: string,
    sessionId: string,
    files: File[],
  ): Promise<AttachmentUploadResponse> {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    return this.client.post<AttachmentUploadResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/attachments`,
      form,
      { token },
    );
  }

  getRuntimeConfigSchema(
    token: string,
    runtime: string,
  ): Promise<RuntimeConfigSchemaResponse> {
    return this.client.get<RuntimeConfigSchemaResponse>(
      `/agents/${encodeURIComponent(runtime)}/config-schema`,
      { token },
    );
  }

  listAgentModes(token: string, runtime: string): Promise<AgentCatalogResponse> {
    return this.client.get<AgentCatalogResponse>(
      `/agents/${encodeURIComponent(runtime)}/modes`,
      { token },
    );
  }

  listAgentModels(token: string, runtime: string): Promise<AgentCatalogResponse> {
    return this.client.get<AgentCatalogResponse>(
      `/agents/${encodeURIComponent(runtime)}/models`,
      { token },
    );
  }

  listAgentEfforts(token: string, runtime: string): Promise<AgentCatalogResponse> {
    return this.client.get<AgentCatalogResponse>(
      `/agents/${encodeURIComponent(runtime)}/efforts`,
      { token },
    );
  }

  getAgentDefaults(token: string): Promise<UserAgentDefaultsResponse> {
    return this.client.get<UserAgentDefaultsResponse>("/agents/defaults", { token });
  }

  updateAgentDefaults(
    token: string,
    runtimes: Record<string, { models?: Array<{
      key: string;
      displayLabel: string;
      description?: string | null;
      sortOrder?: number;
      efforts?: Array<{
        key: string;
        displayLabel: string;
        description?: string | null;
        sortOrder?: number;
      }>;
    }> }>,
  ): Promise<UserAgentDefaultsResponse> {
    return this.client.patch<UserAgentDefaultsResponse>(
      "/agents/defaults",
      { runtimes },
      { token },
    );
  }

  getConnectorAgentSettings(
    token: string,
    connectorId: string,
    runtime: string,
  ): Promise<RuntimeSettingsResponse> {
    return this.client.get<RuntimeSettingsResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/agents/${encodeURIComponent(runtime)}/settings`,
      { token },
    );
  }

  patchConnectorAgentSettings(
    token: string,
    connectorId: string,
    runtime: string,
    settings: Record<string, unknown>,
  ): Promise<RuntimeSettingsResponse> {
    return this.client.patch<RuntimeSettingsResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/agents/${encodeURIComponent(runtime)}/settings`,
      { settings },
      { token },
    );
  }

  deleteConnectorRuntime(
    token: string,
    connectorId: string,
    runtime: string,
  ): Promise<ConnectorRuntimeCapabilitiesResponse> {
    return this.client.delete<ConnectorRuntimeCapabilitiesResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-capabilities/${encodeURIComponent(runtime)}`,
      { token },
    );
  }

  scanConnectorRuntime(
    token: string,
    connectorId: string,
    runtime: string,
    path?: string | null,
  ): Promise<ConnectorRuntimeScanResponse> {
    return this.client.post<ConnectorRuntimeScanResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-capabilities/scan`,
      { runtime, ...(path && path.trim() ? { path: path.trim() } : {}) },
      { token },
    );
  }

  authenticateConnectorAgent(
    token: string,
    connectorId: string,
    runtime: string,
    methodId?: string | null,
  ): Promise<ConnectorAgentAuthenticateResponse> {
    return this.client.post<ConnectorAgentAuthenticateResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/agents/${encodeURIComponent(runtime)}/authenticate`,
      methodId ? { methodId } : {},
      { token },
    );
  }

  getSessionRuntimeSettings(
    token: string,
    sessionId: string,
  ): Promise<RuntimeSettingsResponse> {
    return this.client.get<RuntimeSettingsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime-settings`,
      { token },
    );
  }

  patchSessionRuntimeSettings(
    token: string,
    sessionId: string,
    settings: Record<string, unknown>,
  ): Promise<RuntimeSettingsResponse> {
    return this.client.patch<RuntimeSettingsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime-settings`,
      { settings },
      { token },
    );
  }
}

export const dashboardApi = new DashboardApi();
