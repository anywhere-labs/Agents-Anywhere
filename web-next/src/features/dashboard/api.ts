import { ApiClient, apiClient, apiPath } from "@/lib/api";
import type {
  AdminDashboardOverviewResponse,
  AdminDashboardSettings,
  AdminDashboardSettingsUpdate,
  AdminDashboardSnapshotResponse,
  ArchiveAllResponse,
  BulkArchiveResponse,
  ArchiveAllScope,
  AttachmentUploadResponse,
  ConnectorCreateResponse,
  ConnectorListResponse,
  ConnectorResponse,
  ConnectorRevokeResponse,
  DeviceRuntimeListResponse,
  DeviceRuntimeView,
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
  ProtocolEventRecoveryResponse,
  ProtocolCapabilitiesResponse,
  ProtocolModelCatalogResponse,
  ProtocolPermissionCatalogResponse,
  ProtocolAgentPresetCatalogResponse,
  RpcResponse,
  SessionCommandListResponse,
  SessionCreateAndStartRequest,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionCommandResponse,
  SessionListResponse,
  SessionPatchRequest,
  SessionResponse,
  SessionRuntimeStateResponse,
  SessionSelectionPatchResponse,
  SessionSnapshotResponse,
  SessionTimelineResponse,
  TakeoverResponse,
  TerminalCreateRequest,
  TerminalListResult,
  TerminalListResponse,
  TerminalResponse,
  TerminalSnapshotResult,
  WsTicketResponse,
} from "@/features/dashboard/types";

export type SessionStateQuery = {
  afterSeq?: number;
  beforeOrderSeq?: number;
  mode?: "changes" | "latest" | "history";
  limit?: number;
};

export type SessionSnapshotRequestOptions = {
  reason?: string;
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

  createAndStartSession(
    token: string,
    body: SessionCreateAndStartRequest,
  ): Promise<SessionCreateResponse> {
    return this.client.post<SessionCreateResponse>("/sessions/create-and-start", body, { token });
  }

  patchSession(
    token: string,
    sessionId: string,
    body: SessionPatchRequest,
  ): Promise<SessionResponse> {
    return this.client.patch<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/meta`,
      body,
      { token },
    );
  }

  bulkMarkSessionsRead(token: string, ids: string[]): Promise<BulkArchiveResponse> {
    return this.client.post<BulkArchiveResponse>("/sessions/read", ids, { token });
  }

  bulkArchiveSessions(
    token: string,
    ids: string[],
    archived: boolean,
  ): Promise<BulkArchiveResponse> {
    const path = archived ? "/sessions/archive" : "/sessions/unarchive";
    return this.client.post<BulkArchiveResponse>(
      path,
      ids,
      { token },
    );
  }

  markSessionRead(token: string, sessionId: string): Promise<SessionResponse> {
    return this.client
      .post<BulkArchiveResponse>("/sessions/read", [sessionId], { token })
      .then((response) => {
        const session = response.sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error("session read response did not include session");
        return { session, serverTime: response.serverTime };
      });
  }

  getSessionTimeline(
    token: string,
    sessionId: string,
    afterSeqOrQuery: number | SessionStateQuery = 0,
    limit = 500,
  ): Promise<SessionTimelineResponse> {
    const query =
      typeof afterSeqOrQuery === "number"
        ? { mode: "changes", afterSeq: afterSeqOrQuery, limit }
        : { ...afterSeqOrQuery, limit: afterSeqOrQuery.limit ?? limit };
    return this.client.get<SessionTimelineResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/timeline`,
      { token, query },
    );
  }

  getLatestSessionTimeline(
    token: string,
    sessionId: string,
    limit = 100,
  ): Promise<SessionTimelineResponse> {
    return this.getSessionTimeline(token, sessionId, { mode: "latest", limit });
  }

  getSessionTimelineBefore(
    token: string,
    sessionId: string,
    beforeOrderSeq: number,
    limit = 100,
  ): Promise<SessionTimelineResponse> {
    return this.getSessionTimeline(token, sessionId, {
      mode: "history",
      beforeOrderSeq,
      limit,
    });
  }

  getSessionSnapshot(
    token: string,
    sessionId: string,
    limit = 100,
    options: SessionSnapshotRequestOptions = {},
  ): Promise<SessionSnapshotResponse> {
    const reason = options.reason ?? "unspecified";
    console.info("[AgentsAnywhere] session snapshot request", {
      sessionId,
      limit,
      reason,
      requestedAt: new Date().toISOString(),
      stack: new Error().stack,
    });
    return this.client.get<SessionSnapshotResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      { token, query: { limit } },
    );
  }

  syncSession(token: string, sessionId: string): Promise<RpcResponse<Record<string, unknown>>> {
    return this.client.post<RpcResponse<Record<string, unknown>>>(
      `/sessions/${encodeURIComponent(sessionId)}/sync`,
      {},
      { token },
    );
  }

  getSessionEvents(
    token: string,
    sessionId: string,
    after: string,
  ): Promise<ProtocolEventRecoveryResponse> {
    return this.client.get<ProtocolEventRecoveryResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/events`,
      { token, query: { after } },
    );
  }

  createWsTicket(
    token: string,
    clientId: string,
    sessionId: string,
  ): Promise<WsTicketResponse> {
    return this.client.post<WsTicketResponse>(
      "/ws-ticket",
      { clientId, scope: { sessionId } },
      { token },
    );
  }

  createDashboardWsTicket(token: string, clientId: string): Promise<WsTicketResponse> {
    return this.client.post<WsTicketResponse>(
      "/ws-ticket",
      { clientId, scope: { dashboard: true } },
      { token },
    );
  }

  sessionWebSocketUrl(sessionId: string, ticket: string): string {
    const path = `${apiPath(`/sessions/${encodeURIComponent(sessionId)}/ws`)}?ticket=${encodeURIComponent(ticket)}`;
    if (typeof window === "undefined") return path;
    const url = new URL(path, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  dashboardWebSocketUrl(ticket: string): string {
    const path = `${apiPath("/dashboard/ws")}?ticket=${encodeURIComponent(ticket)}`;
    if (typeof window === "undefined") return path;
    const url = new URL(path, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
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
      `/sessions/${encodeURIComponent(sessionId)}/runtime/interrupt`,
      {},
      { token },
    );
  }

  getSessionCommands(
    token: string,
    sessionId: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<SessionCommandListResponse> {
    void options;
    return this.client.get<SessionCommandListResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/commands`,
      { token },
    );
  }

  sendSessionCommand(
    token: string,
    sessionId: string,
    command: string,
    options: { args?: string[]; raw?: string } = {},
  ): Promise<SessionCommandResponse> {
    return this.client.post<SessionCommandResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/commands`,
      {
        command,
        ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
        ...(options.raw ? { raw: options.raw } : {}),
      },
      { token },
    );
  }

  respondInteraction(
    token: string,
    sessionId: string,
    noticeId: string,
    actionId: string,
    input?: Record<string, unknown> | null,
  ): Promise<RpcResponse<unknown>> {
    return this.client.post<RpcResponse<unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/notices/${encodeURIComponent(noticeId)}/respond`,
      { actionId, ...(input ? { input } : {}) },
      { token },
    );
  }

  sendSessionMessage(
    token: string,
    sessionId: string,
    content: string,
    options: MessageSendOptions = {},
  ): Promise<RpcResponse<unknown>> {
    const { attachments, clientMessageId } = options;
    return this.client.post<RpcResponse<unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/messages`,
      {
        content,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      },
      { token },
    );
  }

  getSessionRuntimeState(
    token: string,
    sessionId: string,
  ): Promise<SessionRuntimeStateResponse> {
    return this.client.get<SessionRuntimeStateResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/state`,
      { token },
    );
  }

  getSessionRuntimeCapabilities(
    token: string,
    sessionId: string,
  ): Promise<ProtocolCapabilitiesResponse> {
    return this.client.get<ProtocolCapabilitiesResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/capabilities`,
      { token },
    );
  }

  updateSessionSelections(
    token: string,
    sessionId: string,
    selections: Record<string, string | null>,
  ): Promise<SessionSelectionPatchResponse> {
    return this.client.patch<SessionSelectionPatchResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/selections`,
      { selections },
      { token },
    );
  }

  getSessionModelCatalog(
    token: string,
    sessionId: string,
  ): Promise<ProtocolModelCatalogResponse> {
    return this.client.get<ProtocolModelCatalogResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/catalogs/model`,
      { token },
    );
  }

  getSessionPermissionCatalog(
    token: string,
    sessionId: string,
  ): Promise<ProtocolPermissionCatalogResponse> {
    return this.client.get<ProtocolPermissionCatalogResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/catalogs/permission`,
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

  getConnectorRuntimeCapabilities(
    token: string,
    connectorId: string,
    runtimeId: string,
  ): Promise<ProtocolCapabilitiesResponse> {
    return this.client.get<ProtocolCapabilitiesResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/capabilities`,
      { token },
    );
  }

  getConnectorRuntimeModelCatalog(
    token: string,
    connectorId: string,
    runtimeId: string,
  ): Promise<ProtocolModelCatalogResponse> {
    return this.client.get<ProtocolModelCatalogResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/catalogs/model`,
      { token },
    );
  }

  getConnectorRuntimePermissionCatalog(
    token: string,
    connectorId: string,
    runtimeId: string,
  ): Promise<ProtocolPermissionCatalogResponse> {
    return this.client.get<ProtocolPermissionCatalogResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/catalogs/permission`,
      { token },
    );
  }

  getConnectorRuntimeAgentPresetCatalog(
    token: string,
    connectorId: string,
    runtimeId: string,
  ): Promise<ProtocolAgentPresetCatalogResponse> {
    return this.client.get<ProtocolAgentPresetCatalogResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/catalogs/agent-preset`,
      { token },
    );
  }

  getConnectorRuntimes(
    token: string,
    connectorId: string,
  ): Promise<DeviceRuntimeListResponse> {
    return this.client.get<DeviceRuntimeListResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes`,
      { token },
    );
  }

  discoverConnectorRuntimes(
    token: string,
    connectorId: string,
  ): Promise<DeviceRuntimeListResponse> {
    return this.client.post<DeviceRuntimeListResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/discover`,
      {},
      { token },
    );
  }

  putConnectorRuntimeConfig(
    token: string,
    connectorId: string,
    runtimeId: string,
    config: Record<string, unknown>,
  ): Promise<DeviceRuntimeView> {
    return this.client.put<DeviceRuntimeView>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/config`,
      { config },
      { token },
    );
  }

  setConnectorRuntimeActive(
    token: string,
    connectorId: string,
    runtimeId: string,
    active: boolean,
  ): Promise<DeviceRuntimeView> {
    return this.client.put<DeviceRuntimeView>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/active`,
      { active },
      { token },
    );
  }

  deleteConnectorRuntimeConfig(
    token: string,
    connectorId: string,
    runtimeId: string,
  ): Promise<DeviceRuntimeView> {
    return this.client.delete<DeviceRuntimeView>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}/config`,
      { token },
    );
  }

}

export const dashboardApi = new DashboardApi();
