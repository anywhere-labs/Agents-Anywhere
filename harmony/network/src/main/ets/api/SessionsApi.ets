import { ApiClient, FetchedFileData, UploadFilePart } from './ApiClient';
import { objGetArray, objGetRecord, objGetString, recordsFromArray, requireRecord } from 'common';
import { ApiException } from 'common';
import {
  parseRemoteCommandResult,
  parseRemoteDownloadedAttachment,
  parseRemoteProject,
  parseRemoteProjectListResponse,
  parseRemoteRpcResponse,
  parseRemoteRuntimeCommandList,
  parseRemoteRuntimeNoticeList,
  parseRemoteSession,
  parseRemoteSessionPage,
  parseRemoteSessionResponse,
  parseRemoteSessionRuntimeStateResponse,
  parseRemoteSessionSnapshot,
  parseRemoteSessionTimelinePage,
  parseRemoteSessionsMutationResponse,
  parseRemoteUploadResponse,
  parseRemoteRuntimeCapabilitySet,
  RemoteCommandResult,
  RemoteDownloadedAttachment,
  RemoteProject,
  RemoteProjectListResponse,
  RemoteRpcResponse,
  RemoteRuntimeCommandList,
  RemoteRuntimeNoticeList,
  RemoteSession,
  RemoteSessionCreateAndStartRequest,
  RemoteSessionCreateResponse,
  RemoteSessionPage,
  RemoteSessionResponse,
  RemoteSessionRuntimeStateResponse,
  RemoteSessionSnapshot,
  RemoteSessionTimelinePage,
  RemoteSessionsMutationResponse,
  RemoteSessionShareResponse,
  RemoteRuntimeCapabilitySet,
  RemoteUploadResponse
} from './SessionDtos';

const CREATE_AND_START_READ_TIMEOUT_MS = 75000;
const UPLOAD_READ_TIMEOUT_MS = 60000;
const MAX_ATTACHMENT_FILE_BYTES = 26214400;

function fileNameFromUrl(url: string): string {
  let path = url;
  const queryIndex = path.indexOf('?');
  if (queryIndex >= 0) {
    path = path.substring(0, queryIndex);
  }
  const hashIndex = path.indexOf('#');
  if (hashIndex >= 0) {
    path = path.substring(0, hashIndex);
  }
  const slashIndex = path.lastIndexOf('/');
  const name = slashIndex >= 0 ? path.substring(slashIndex + 1) : path;
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch (error) {
    decoded = name;
  }
  if (decoded.trim().length > 0) {
    return decoded.trim();
  }
  return 'downloaded-file';
}

function normalizeMediaType(mediaType: string): string {
  const semicolon = mediaType.indexOf(';');
  const base = semicolon >= 0 ? mediaType.substring(0, semicolon) : mediaType;
  const trimmed = base.trim().toLowerCase();
  if (trimmed.length === 0) {
    return 'application/octet-stream';
  }
  return trimmed;
}

export class SessionsApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async listSessions(serverUrl: string, authorizationToken: string, archived: boolean,
    limit: number, cursor: string | null): Promise<RemoteSessionPage> {
    let query = `/sessions?archived=${archived}&limit=${limit}`;
    if (cursor !== null && cursor.length > 0) {
      query += `&cursor=${encodeURIComponent(cursor)}`;
    }
    const response = await this.client.getJson(serverUrl, query, authorizationToken);
    return parseRemoteSessionPage(response);
  }

  async listProjectSessions(serverUrl: string, authorizationToken: string, projectId: string,
    archived: boolean, limit: number, cursor: string | null): Promise<RemoteSessionPage> {
    let query = `/projects/${encodeURIComponent(projectId)}/sessions?archived=${archived}&limit=${limit}`;
    if (cursor !== null && cursor.length > 0) {
      query += `&cursor=${encodeURIComponent(cursor)}`;
    }
    const response = await this.client.getJson(serverUrl, query, authorizationToken);
    return parseRemoteSessionPage(response);
  }

  async listProjects(serverUrl: string, authorizationToken: string): Promise<RemoteProjectListResponse> {
    const response = await this.client.getJson(serverUrl, '/projects', authorizationToken);
    return parseRemoteProjectListResponse(response);
  }

  async createProject(serverUrl: string, authorizationToken: string, name: string,
    connectorId: string, workspacePath: string, manuallyCreated: boolean): Promise<RemoteProject> {
    const body: Record<string, Object> = {
      'name': name,
      'connectorId': connectorId,
      'workspacePath': workspacePath,
      'manuallyCreated': manuallyCreated
    };
    const response = await this.client.postJson(serverUrl, '/projects', body, authorizationToken);
    const projectRecord = requireRecord(response, 'project');
    const project = parseRemoteProject(projectRecord);
    return project;
  }

  async updateProject(serverUrl: string, authorizationToken: string, projectId: string,
    name: string | null, pinned: boolean | null): Promise<RemoteProject> {
    const body: Record<string, Object> = {};
    if (name !== null) {
      body['name'] = name;
    }
    if (pinned !== null) {
      body['pinned'] = pinned;
    }
    const response = await this.client.patchJson(serverUrl,
      `/projects/${encodeURIComponent(projectId)}`, body, authorizationToken);
    const projectRecord = requireRecord(response, 'project');
    return parseRemoteProject(projectRecord);
  }

  async createAndStartSession(serverUrl: string, authorizationToken: string,
    request: RemoteSessionCreateAndStartRequest): Promise<RemoteSessionCreateResponse> {
    const body: Record<string, Object> = {
      'connectorId': request.connectorId,
      'projectId': request.projectId,
      'runtime': request.runtime,
      'content': request.content
    };
    if (request.runtimeId !== null && request.runtimeId.length > 0 && request.runtimeId !== request.runtime) {
      body['runtimeId'] = request.runtimeId;
    }
    if (request.title !== null) {
      body['title'] = request.title;
    }
    if (request.cwd !== null) {
      body['cwd'] = request.cwd;
    }
    // Mirrors Android SessionsApi.createAndStartSession: only non-blank
    // selection values are forwarded and the field is omitted when empty.
    const selections: Record<string, Object> = {};
    let hasSelections = false;
    const model = request.selections.model;
    if (model !== null && model.length > 0) {
      selections['model'] = model;
      hasSelections = true;
    }
    const permission = request.selections.permission;
    if (permission !== null && permission.length > 0) {
      selections['permission'] = permission;
      hasSelections = true;
    }
    if (hasSelections) {
      body['selections'] = selections;
    }
    // Inline attachments: the server persists the base64 payloads itself.
    if (request.attachments.length > 0) {
      const attachments: Record<string, Object>[] = [];
      for (const attachment of request.attachments) {
        const ref: Record<string, Object> = {
          'fileId': attachment.fileId,
          'name': attachment.name,
          'mediaType': attachment.mediaType,
          'size': attachment.size,
          'sha256': attachment.sha256,
          'contentBase64': attachment.contentBase64
        };
        attachments.push(ref);
      }
      body['attachments'] = attachments;
    }
    if (request.clientMessageId !== null) {
      body['clientMessageId'] = request.clientMessageId;
    }
    const response = await this.client.postJson(serverUrl, '/sessions/create-and-start', body,
      authorizationToken, CREATE_AND_START_READ_TIMEOUT_MS);
    return {
      session: parseRemoteSession(requireRecord(response, 'session'))
    };
  }

  async patchSession(serverUrl: string, authorizationToken: string, sessionId: string,
    title: string | null, pinned: boolean | null, archived: boolean | null): Promise<RemoteSessionResponse> {
    const body: Record<string, Object> = {};
    if (title !== null) {
      body['title'] = title;
    }
    if (pinned !== null) {
      body['pinned'] = pinned;
    }
    if (archived !== null) {
      body['archived'] = archived;
    }
    const response = await this.client.patchJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/meta`, body, authorizationToken);
    return parseRemoteSessionResponse(response);
  }

  // Takeover is toggled through dedicated endpoints (the server ignores the
  // takeover field on PATCH /sessions/{id}/meta).
  async enableTakeover(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteSession> {
    const body: Record<string, Object> = {};
    const response = await this.client.postJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/takeover`, body, authorizationToken);
    return parseRemoteSession(requireRecord(response, 'session'));
  }

  async disableTakeover(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteSession> {
    const response = await this.client.deleteJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/takeover`, authorizationToken);
    return parseRemoteSession(requireRecord(response, 'session'));
  }

  async getSessionRuntimeCapabilities(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteRuntimeCapabilitySet> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/capabilities`, authorizationToken);
    // The endpoint returns ProtocolCapabilitiesResponse
    // { connectorId, capabilitySet: { revision, capabilities }, serverTime };
    // unwrap the nested capability set before parsing (Android parity:
    // payload.optJSONObject("capabilitySet")).
    const capabilitySet = objGetRecord(response, 'capabilitySet');
    return parseRemoteRuntimeCapabilitySet(capabilitySet !== null ? capabilitySet : response);
  }

  async createSessionShare(serverUrl: string, authorizationToken: string,
    sessionId: string, scope: string, itemIds: string[]): Promise<RemoteSessionShareResponse> {
    const body: Record<string, Object> = { 'scope': scope, 'itemIds': itemIds };
    const response = await this.client.postJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/shares`, body, authorizationToken);
    return { shareUrl: objGetString(response, 'shareUrl', '') };
  }

  async getSessionMeta(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteSessionResponse> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/meta`, authorizationToken);
    return parseRemoteSessionResponse(response);
  }

  async archiveSessions(serverUrl: string, authorizationToken: string,
    ids: string[]): Promise<RemoteSessionsMutationResponse> {
    const response = await this.client.postJsonArray(serverUrl, '/sessions/archive', ids, authorizationToken);
    return parseRemoteSessionsMutationResponse(response);
  }

  async unarchiveSessions(serverUrl: string, authorizationToken: string,
    ids: string[]): Promise<RemoteSessionsMutationResponse> {
    const response = await this.client.postJsonArray(serverUrl, '/sessions/unarchive', ids, authorizationToken);
    return parseRemoteSessionsMutationResponse(response);
  }

  async markSessionsRead(serverUrl: string, authorizationToken: string,
    ids: string[]): Promise<RemoteSessionsMutationResponse> {
    const response = await this.client.postJsonArray(serverUrl, '/sessions/read', ids, authorizationToken);
    return parseRemoteSessionsMutationResponse(response);
  }

  async archiveAllProjectSessions(serverUrl: string, authorizationToken: string, projectId: string,
    archived: boolean, scope: string): Promise<RemoteSession[]> {
    const body: Record<string, Object> = {
      'archived': archived,
      'scope': scope
    };
    const response = await this.client.postJson(serverUrl,
      `/projects/${encodeURIComponent(projectId)}/sessions/archive-all`, body, authorizationToken);
    return sessionsFromArrayResponse(response);
  }

  async archiveAllDeviceSessions(serverUrl: string, authorizationToken: string, deviceId: string,
    archived: boolean, scope: string): Promise<RemoteSession[]> {
    const body: Record<string, Object> = {
      'archived': archived,
      'scope': scope
    };
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/sessions/archive-all`, body, authorizationToken);
    return sessionsFromArrayResponse(response);
  }

  async getSessionTimelineHistory(serverUrl: string, authorizationToken: string, sessionId: string,
    beforeOrderSeq: number, limit: number): Promise<RemoteSessionTimelinePage> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/timeline?mode=history&beforeOrderSeq=${beforeOrderSeq}&limit=${limit}`,
      authorizationToken);
    return parseRemoteSessionTimelinePage(response);
  }

  async getSessionTimelineChanges(serverUrl: string, authorizationToken: string, sessionId: string,
    afterSeq: number, limit: number): Promise<RemoteSessionTimelinePage> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/timeline?mode=changes&afterSeq=${afterSeq}&limit=${limit}`,
      authorizationToken);
    return parseRemoteSessionTimelinePage(response);
  }

  async getSessionSnapshot(serverUrl: string, authorizationToken: string, sessionId: string,
    limit: number): Promise<RemoteSessionSnapshot> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/snapshot?limit=${limit}`, authorizationToken);
    return parseRemoteSessionSnapshot(response);
  }

  async getSessionRuntimeState(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteSessionRuntimeStateResponse> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/state`, authorizationToken);
    return parseRemoteSessionRuntimeStateResponse(response);
  }

  async sendSessionMessage(serverUrl: string, authorizationToken: string, sessionId: string,
    content: string, clientMessageId: string, attachmentFileIds: string[]): Promise<RemoteRpcResponse> {
    const body: Record<string, Object> = {
      'content': content,
      'clientMessageId': clientMessageId
    };
    if (attachmentFileIds.length > 0) {
      const refs: Record<string, Object>[] = [];
      for (const fileId of attachmentFileIds) {
        const ref: Record<string, Object> = { 'fileId': fileId };
        refs.push(ref);
      }
      body['attachments'] = refs;
    }
    const response = await this.client.postJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/messages`, body, authorizationToken);
    return parseRemoteRpcResponse(response);
  }

  async uploadSessionAttachments(serverUrl: string, authorizationToken: string, sessionId: string,
    parts: UploadFilePart[]): Promise<RemoteUploadResponse> {
    const response = await this.client.postMultipart(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/attachments`, 'files', parts,
      authorizationToken, UPLOAD_READ_TIMEOUT_MS);
    return parseRemoteUploadResponse(response);
  }

  async uploadExternalFileAsAttachment(serverUrl: string, authorizationToken: string, sessionId: string,
    url: string): Promise<RemoteUploadResponse> {
    const lowered = url.toLowerCase();
    if (!lowered.startsWith('http://') && !lowered.startsWith('https://')) {
      throw new ApiException('Enter a valid http(s) file URL.');
    }
    const fetched: FetchedFileData = await this.client.fetchUrlBytes(url, MAX_ATTACHMENT_FILE_BYTES);
    const part: UploadFilePart = {
      fileName: fileNameFromUrl(url),
      mediaType: normalizeMediaType(fetched.mediaType),
      bytes: fetched.bytes
    };
    return this.uploadSessionAttachments(serverUrl, authorizationToken, sessionId, [part]);
  }

  async downloadSessionAttachment(serverUrl: string, authorizationToken: string, sessionId: string,
    fileId: string): Promise<RemoteDownloadedAttachment> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(fileId)}`,
      authorizationToken);
    return parseRemoteDownloadedAttachment(response);
  }

  async listRuntimeCommands(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteRuntimeCommandList> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/commands`, authorizationToken);
    return parseRemoteRuntimeCommandList(response);
  }

  async executeRuntimeCommand(serverUrl: string, authorizationToken: string, sessionId: string,
    command: string, args: string[], raw: string): Promise<RemoteCommandResult> {
    const body: Record<string, Object> = {
      'command': command,
      'args': args,
      'raw': raw
    };
    const response = await this.client.postJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/commands`, body, authorizationToken);
    return parseRemoteCommandResult(response);
  }

  async interruptSession(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteRpcResponse> {
    const response = await this.client.postJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/interrupt`, null, authorizationToken);
    return parseRemoteRpcResponse(response);
  }

  async listRuntimeNotices(serverUrl: string, authorizationToken: string,
    sessionId: string): Promise<RemoteRuntimeNoticeList> {
    const response = await this.client.getJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/notices`, authorizationToken);
    return parseRemoteRuntimeNoticeList(response);
  }

  async respondToRuntimeNotice(serverUrl: string, authorizationToken: string, sessionId: string,
    noticeId: string, actionId: string, input: Record<string, Object> | null = null): Promise<RemoteRpcResponse> {
    const body: Record<string, Object> = {
      'actionId': actionId
    };
    if (input !== null) {
      body['input'] = input;
    }
    const response = await this.client.postJson(serverUrl,
      `/sessions/${encodeURIComponent(sessionId)}/runtime/notices/${encodeURIComponent(noticeId)}/respond`,
      body, authorizationToken);
    return parseRemoteRpcResponse(response);
  }
}

function sessionsFromArrayResponse(value: Record<string, Object>): RemoteSession[] {
  const sessions: RemoteSession[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'sessions'))) {
    sessions.push(parseRemoteSession(item));
  }
  return sessions;
}
