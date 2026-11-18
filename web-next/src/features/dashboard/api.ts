import { assertSessionCreationAccepted } from "@/lib/api/session-creation-result";
import { ApiClient, apiClient, apiPath } from "@/lib/api";
import { noteSessionDevices } from "@/lib/e2ee/state";
import { shouldAuthorizeDownloadUrl } from "@/lib/api/download-auth";
import { ApiError } from "@/lib/api/errors";
import { readFileThroughChannel } from "@/lib/transport/channel-files";
import { contentTransportFor, contentTransportForDevice, sessionContentIsEncrypted } from "@/lib/transport/content-transport";
import { readSessionBlob, type SessionBlobChunk, type SessionBlobContent } from "@/features/dashboard/session-blobs";
import type {
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
  SessionQueueState,
  Notice,
  PairingClaimResponse,
  PairingPollResponse,
  PairingStartResponse,
  ProtocolEventRecoveryResponse,
  ProtocolCapabilitiesResponse,
  ProtocolModelCatalogResponse,
  ProtocolPermissionCatalogResponse,
  PublicSessionShareResponse,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectDeleteResponse,
  ProjectListResponse,
  ProjectPatchRequest,
  ProjectResponse,
  ProjectSessionListResponse,
  RpcResponse,
  RuntimeTypeListResponse,
  SessionCommandListResponse,
  SessionCreateAndStartRequest,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionCommandResponse,
  SessionListResponse,
  SessionPatchRequest,
  SessionResponse,
  SessionRuntimeStateResponse,
  SessionShareCreateRequest,
  SessionShareCreateResponse,
  SessionSelectionPatchResponse,
  SessionSnapshotResponse,
  SessionTimelineResponse,
  TakeoverResponse,
  TerminalCreateRequest,
  TerminalListResult,
  TerminalListResponse,
  TerminalResponse,
  TerminalSnapshotResult,
  UsageLiveResponse,
  UsageReportResponse,
  WsTicketResponse,
} from "@/features/dashboard/types";

/** A device file's bytes, however they were fetched. */
export type DeviceFileBlob = {
  name: string;
  size: number;
  mediaType?: string;
  blob: Blob;
};

/** Encrypted mode: a title is content, and the Server has no sealed title field yet. */
export const E2EE_TITLE_UNSUPPORTED = "e2ee_title_unsupported";

function queuePath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/runtime/queue`;
}

export type SessionStateQuery = {
  afterSeq?: number;
  beforeOrderSeq?: number;
  mode?: "changes" | "latest" | "history";
  limit?: number;
};

export type SessionSnapshotRequestOptions = {
  reason?: string;
};

/** User-chosen device settings; see docs/api/device-settings.md. */
export type ConnectorDeviceSettings = {
  confirmQuitOnShutdown: boolean;
};

export type ConnectorDeviceSettingsResponse = {
  connectorId: string;
  settings: ConnectorDeviceSettings;
  /** Only set by a write: whether the online device confirmed the change. */
  delivered: boolean | null;
  serverTime: string;
};

export class DashboardApi {
  constructor(private readonly client: ApiClient = apiClient) {}

  getAdminUsageReport(
    token: string,
    query: { from?: string; to?: string; tz?: string } = {},
  ): Promise<UsageReportResponse> {
    return this.client.get<UsageReportResponse>("/admin/usage/report", { token, query });
  }

  getAdminUsageLive(token: string): Promise<UsageLiveResponse> {
    return this.client.get<UsageLiveResponse>("/admin/usage/live", { token });
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

  listProjects(token: string): Promise<ProjectListResponse> {
    return this.client.get<ProjectListResponse>("/projects", { token });
  }

  createProject(
    token: string,
    body: ProjectCreateRequest,
  ): Promise<ProjectCreateResponse> {
    return this.client.post<ProjectCreateResponse>("/projects", body, { token });
  }

  updateProject(
    token: string,
    projectId: string,
    body: ProjectPatchRequest,
  ): Promise<ProjectResponse> {
    return this.client.patch<ProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}`,
      body,
      { token },
    );
  }

  deleteProject(token: string, projectId: string): Promise<ProjectDeleteResponse> {
    return this.client.delete<ProjectDeleteResponse>(
      `/projects/${encodeURIComponent(projectId)}`,
      { token },
    );
  }

  listProjectSessions(
    token: string,
    projectId: string,
    query: { archived?: boolean; limit?: number; cursor?: string | null } = {},
  ): Promise<ProjectSessionListResponse> {
    return this.client.get<ProjectSessionListResponse>(
      `/projects/${encodeURIComponent(projectId)}/sessions`,
      { token, query },
    );
  }

  archiveProjectSessions(
    token: string,
    projectId: string,
    body: { archived: boolean; scope?: ArchiveAllScope },
  ): Promise<ArchiveAllResponse> {
    return this.client.post<ArchiveAllResponse>(
      `/projects/${encodeURIComponent(projectId)}/sessions/archive-all`,
      body,
      { token },
    );
  }

  listSessions(
    token: string,
    query: { archived: boolean; limit?: number; cursor?: string | null },
  ): Promise<SessionListResponse> {
    return this.client.get<SessionListResponse>("/sessions", { token, query }).then((response) => {
      noteSessionDevices(response.sessions);
      return response;
    });
  }

  listSessionInventory(token: string): Promise<Pick<SessionListResponse, "sessions" | "serverTime">> {
    return this.client.get<Pick<SessionListResponse, "sessions" | "serverTime">>("/sessions/list", { token }).then((response) => {
      noteSessionDevices(response.sessions);
      return response;
    });
  }

  /** Ticket for the secure-channel tunnel `WS /api/v3/tunnel` (E2EE). */
  createTunnelTicket(token: string, clientId: string): Promise<WsTicketResponse> {
    return this.createDashboardWsTicket(token, clientId);
  }

  /** `POST /api/v3/e2ee/commands`: plaintext registration of a command sent through a secure channel. */
  registerE2eeCommand(
    token: string,
    registration: { commandId: string; deviceId: string; inputDigest: string },
  ): Promise<{ commandId: string; outcome: "accepted" | "rejected" | null; errorCode: string | null; duplicate: boolean }> {
    return this.client.post("/api/v3/e2ee/commands", registration, { token });
  }

  getConnectorDeviceSettings(token: string, connectorId: string): Promise<ConnectorDeviceSettingsResponse> {
    return this.client.get<ConnectorDeviceSettingsResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/device-settings`,
      { token },
    );
  }

  updateConnectorDeviceSettings(
    token: string,
    connectorId: string,
    body: Partial<ConnectorDeviceSettings>,
  ): Promise<ConnectorDeviceSettingsResponse> {
    return this.client.patch<ConnectorDeviceSettingsResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/device-settings`,
      body,
      { token },
    );
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

  async createAndStartSession(
    token: string,
    body: SessionCreateAndStartRequest,
  ): Promise<SessionCreateResponse> {
    if (this.sessionCreationIsEncrypted(body.connectorId)) return this.createAndStartThroughChannel(token, body);
    const response = await this.client.post<SessionCreateResponse>("/sessions/create-and-start", body, { token });
    assertSessionCreationAccepted(response);
    return response;
  }

  /** Encrypted mode: the request goes to the chosen device through its channel (the first message is content). */
  sessionCreationIsEncrypted(connectorId: string): boolean {
    return contentTransportForDevice(connectorId, "POST", apiPath("/sessions/create-and-start")) !== null;
  }

  /**
   * Same request through the device's channel. When its outcome is unknown (no answer in time, or a repeated
   * command), the Server's session list says whether the device created it: a single new session of the same
   * device and project is offered to the user to check (never bound automatically, never resent).
   */
  private async createAndStartThroughChannel(
    token: string,
    body: SessionCreateAndStartRequest,
  ): Promise<SessionCreateResponse> {
    const before = await this.sessionIdsOf(token, body).catch(() => null);
    try {
      const response = await this.client.post<SessionCreateResponse>("/sessions/create-and-start", body, { token });
      assertSessionCreationAccepted(response);
      return response;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "command_outcome_unknown" || !before) throw error;
      const after = await this.sessionIdsOf(token, body).catch(() => null);
      const created = after ? [...after].filter((id) => !before.has(id)) : [];
      if (created.length !== 1) throw error;
      const detail = (error.payload as { detail?: Record<string, unknown> } | undefined)?.detail ?? {};
      throw new ApiError({
        status: error.status,
        kind: error.kind,
        code: error.code,
        detail: error.detail,
        payload: { detail: { ...detail, sessionId: created[0] } },
      });
    }
  }

  private async sessionIdsOf(token: string, body: { connectorId: string; projectId: string }): Promise<Set<string>> {
    const { sessions } = await this.listSessionInventory(token);
    return new Set(sessions
      .filter((session) => session.connectorId === body.connectorId && (session.projectId ?? body.projectId) === body.projectId)
      .map((session) => session.id));
  }

  /** Plaintext directory entry of one session (allowed in E2EE mode). */
  getSessionMeta(token: string, sessionId: string): Promise<SessionResponse> {
    return this.client.get<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}/meta`, { token });
  }

  patchSession(
    token: string,
    sessionId: string,
    body: SessionPatchRequest,
  ): Promise<SessionResponse> {
    // The directory entry is plaintext; a title in it would leak content. Never send it in encrypted mode.
    if (body.title !== undefined && sessionContentIsEncrypted(sessionId)) {
      return Promise.reject(new ApiError({
        status: 409,
        kind: "http",
        code: E2EE_TITLE_UNSUPPORTED,
        detail: "Sessions cannot be renamed in end-to-end encrypted mode yet.",
      }));
    }
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

  /**
   * A blob the device keeps for the session (a timeline item's `blobRefs[].blobId`, or an attachment's `fileId`),
   * read slice by slice; through the device's encrypted channel when the session's content uses one.
   */
  sessionBlob(
    token: string,
    sessionId: string,
    blobRef: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<SessionBlobContent> {
    const path = `/sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(blobRef)}`;
    return readSessionBlob(
      (_ref, offset, length) => this.client.get<SessionBlobChunk>(path, { token, query: { offset: String(offset), length: String(length) } }),
      blobRef,
      options,
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

  createSessionShare(
    token: string,
    sessionId: string,
    body: SessionShareCreateRequest,
  ): Promise<SessionShareCreateResponse> {
    return this.client.post<SessionShareCreateResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/shares`,
      body,
      { token },
    );
  }

  getPublicSessionShare(shareId: string): Promise<PublicSessionShareResponse> {
    return this.client.get<PublicSessionShareResponse>(
      `/public/shares/${encodeURIComponent(shareId)}`,
      { auth: false },
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

  tunnelWebSocketUrl(ticket: string): string {
    const path = `/api/v3/tunnel?ticket=${encodeURIComponent(ticket)}`;
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
    body: { root?: string; path?: string | null },
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

  /** Whether device files are read through an encrypted channel (no download URL; bytes come in chunks). */
  connectorFsReadsThroughChannel(connectorId: string): boolean {
    return contentTransportForDevice(connectorId, "GET", apiPath(`/connectors/${encodeURIComponent(connectorId)}/fs/read`)) !== null;
  }

  /** A device file's bytes: the download URL in normal mode, `TunnelFileChunk`s through the device's channel. */
  async connectorFsReadBlob(
    token: string,
    connectorId: string,
    root: string,
    path: string,
  ): Promise<DeviceFileBlob> {
    const readPath = apiPath(`/connectors/${encodeURIComponent(connectorId)}/fs/read`);
    const tunnel = contentTransportForDevice(connectorId, "GET", readPath);
    if (tunnel) {
      const { bytes, size } = await readFileThroughChannel(tunnel, readPath, { root, path });
      return { name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, size, blob: new Blob(bytes) };
    }
    const response = await this.connectorFsRead(token, connectorId, root, path);
    const blob = await this.downloadBlob(token, response.result.downloadUrl);
    return { name: response.result.name, size: response.result.size, mediaType: response.result.mediaType, blob };
  }

  async downloadBlob(token: string | null, url: string): Promise<Blob> {
    const headers: HeadersInit = {};
    if (token && shouldAuthorizeDownloadUrl(url)) headers.authorization = `Bearer ${token}`;
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
    signal?: AbortSignal,
  ): Promise<RpcResponse<unknown>> {
    return this.client.delete<RpcResponse<unknown>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}`,
      { token, signal },
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

  connectorTerminalSetPersistenceV2(
    token: string,
    connectorId: string,
    terminalId: string,
    persistent: boolean,
  ): Promise<RpcResponse<TerminalResponse["terminal"]>> {
    return this.client.patch<RpcResponse<TerminalResponse["terminal"]>>(
      `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}/persistence`,
      { persistent },
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
    const params = new URLSearchParams();
    if (options.query !== undefined) params.set("query", options.query);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.size ? `?${params}` : "";
    return this.client.get<SessionCommandListResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/commands${suffix}`,
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
        ...(options.raw !== undefined ? { raw: options.raw } : {}),
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
    const { attachments, clientMessageId, queue } = options;
    return this.client.post<RpcResponse<unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/messages`,
      {
        content,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(queue ? { queue } : {}),
      },
      { token },
    );
  }

  /** Inject a message into the running turn (``session.steer``). */
  steerSession(
    token: string,
    sessionId: string,
    content: string,
    options: Omit<MessageSendOptions, "queue"> = {},
  ): Promise<RpcResponse<unknown>> {
    const { attachments, clientMessageId } = options;
    return this.client.post<RpcResponse<unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/runtime/steer`,
      {
        content,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      },
      { token },
    );
  }

  getSessionQueue(token: string, sessionId: string): Promise<SessionQueueState> {
    return this.client.get<SessionQueueState>(`${queuePath(sessionId)}`, { token });
  }

  updateSessionQueueItem(token: string, sessionId: string, messageId: string, content: string): Promise<SessionQueueState> {
    return this.client.patch<SessionQueueState>(`${queuePath(sessionId)}/${encodeURIComponent(messageId)}`, { content }, { token });
  }

  deleteSessionQueueItem(token: string, sessionId: string, messageId: string): Promise<SessionQueueState> {
    return this.client.delete<SessionQueueState>(`${queuePath(sessionId)}/${encodeURIComponent(messageId)}`, { token });
  }

  retrySessionQueueItem(token: string, sessionId: string, messageId: string): Promise<SessionQueueState> {
    return this.client.post<SessionQueueState>(`${queuePath(sessionId)}/${encodeURIComponent(messageId)}/retry`, {}, { token });
  }

  sendSessionQueueItemNow(token: string, sessionId: string, messageId: string): Promise<SessionQueueState> {
    return this.client.post<SessionQueueState>(`${queuePath(sessionId)}/${encodeURIComponent(messageId)}/send-now`, {}, { token });
  }

  resumeSessionQueue(token: string, sessionId: string): Promise<SessionQueueState> {
    return this.client.post<SessionQueueState>(`${queuePath(sessionId)}/resume`, {}, { token });
  }

  clearSessionQueue(token: string, sessionId: string): Promise<SessionQueueState> {
    return this.client.delete<SessionQueueState>(queuePath(sessionId), { token });
  }

  getSessionRuntimeNotices(token: string, sessionId: string): Promise<{ notices: Notice[]; serverTime: string }> {
    return this.client.get(`/sessions/${encodeURIComponent(sessionId)}/runtime/notices`, { token });
  }

  getSessionRuntimeState(
    token: string,
    sessionId: string,
  ): Promise<SessionRuntimeStateResponse> {
    return this.getLiveSessionRuntime(token, sessionId, "state");
  }

  getSessionRuntimeCapabilities(
    token: string,
    sessionId: string,
  ): Promise<ProtocolCapabilitiesResponse> {
    return this.getLiveSessionRuntime(token, sessionId, "capabilities");
  }

  private getLiveSessionRuntime<T>(token: string, sessionId: string, resource: "state" | "capabilities"): Promise<T> {
    const path = `/sessions/${encodeURIComponent(sessionId)}/runtime/${resource}`;
    // A device-created session can be live before its directory entry reaches the Server.
    const transport = contentTransportFor(sessionId);
    return transport
      ? transport.request({ method: "GET", path: apiPath(path) }) as Promise<T>
      : this.client.get<T>(path, { token });
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

  getConnectorRuntimes(
    token: string,
    connectorId: string,
  ): Promise<DeviceRuntimeListResponse> {
    return this.client.get<DeviceRuntimeListResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes`,
      { token },
    );
  }

  getConnectorRuntimeTypes(
    token: string,
    connectorId: string,
  ): Promise<RuntimeTypeListResponse> {
    return this.client.get<RuntimeTypeListResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-types`,
      { token },
    );
  }

  discoverConnectorRuntimeTypes(
    token: string,
    connectorId: string,
  ): Promise<RuntimeTypeListResponse> {
    return this.client.post<RuntimeTypeListResponse>(
      `/connectors/${encodeURIComponent(connectorId)}/runtime-types/discover`,
      {},
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

  createConnectorRuntime(
    token: string,
    connectorId: string,
    payload: {
      runtimeType: string;
      name: string;
      config: Record<string, unknown>;
      active?: boolean;
    },
  ): Promise<DeviceRuntimeView> {
    return this.client.post<DeviceRuntimeView>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes`,
      payload,
      { token },
    );
  }

  renameConnectorRuntime(
    token: string,
    connectorId: string,
    runtimeId: string,
    name: string,
  ): Promise<DeviceRuntimeView> {
    return this.client.patch<DeviceRuntimeView>(
      `/connectors/${encodeURIComponent(connectorId)}/runtimes/${encodeURIComponent(runtimeId)}`,
      { name },
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
