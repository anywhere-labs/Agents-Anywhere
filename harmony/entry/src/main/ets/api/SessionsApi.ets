import { HttpTransport } from './HttpTransport';
import { apiUrl, encodeUrlComponent } from './ApiUrls';
import {
  parseRemoteSessionBatch, parseRemoteSessionEnvelope, parseRemoteSessionPage, parseRemoteSession,
  RemoteSession, RemoteSessionBatch, RemoteSessionBatchDto, RemoteSessionDto, RemoteSessionEnvelope,
  RemoteSessionEnvelopeDto, RemoteSessionPage, RemoteSessionPageDto,
} from './SessionsDtos';
import {
  parseRemoteSessionSnapshot, parseRemoteSessionTimelinePage, RemoteSessionSnapshot,
  RemoteSessionSnapshotDto, RemoteSessionTimelinePage, RemoteSessionTimelinePageDto,
} from './TimelineDtos';
import {
  parseRemoteSessionCommandList, parseRpcResponse, parseRuntimeState, RemoteRpcResponse,
  RemoteRpcResponseDto, RemoteSessionCommand, RemoteSessionCommandListDto,
  RemoteSessionRuntimeState, RemoteSessionRuntimeStateDto,
} from './RuntimeDtos';
import {
  parseRuntimeModelCatalog, parseRuntimePermissionCatalog, RuntimeModelCatalog,
  RuntimeModelCatalogDto, RuntimePermissionCatalog, RuntimePermissionCatalogDto,
} from './RuntimeCatalogDtos';
import {
  parseRemoteSessionEvents, RemoteSessionEvents, RemoteSessionEventsDto,
} from './SessionEventDtos';
import { objectField } from './ApiJson';
import { requireString } from './ApiJson';
import { arrayField, numberOr, optionalString, stringOr } from './ApiJson';
import { UploadFilePart } from './HttpTransport';
import { AuthSessionStore } from '../storage/AuthSessionStore';

/**
 * Session resource client.
 *
 * Port of the session portion of `api/SessionsApi.kt`.
 *
 * One method per Server resource. The list endpoints page backwards with a
 * cursor, and the bulk read/archive endpoints take a bare JSON array of ids
 * rather than an object, which is why they call `postJsonArray`.
 */

const DEFAULT_PAGE_LIMIT: number = 100;

/** Android gives the create-and-start request 75 seconds. */
const CREATE_AND_START_READ_TIMEOUT_MS: number = 75_000;

/** One file sent inline with the first message, as the create endpoint expects. */
export class RemoteInlineAttachmentRef {
  readonly fileId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentBase64: string;

  constructor(
    fileId: string,
    name: string,
    mediaType: string,
    size: number,
    sha256: string,
    contentBase64: string,
  ) {
    this.fileId = fileId;
    this.name = name;
    this.mediaType = mediaType;
    this.size = size;
    this.sha256 = sha256;
    this.contentBase64 = contentBase64;
  }
}

/** Everything `POST /sessions/create-and-start` needs. */
export class RemoteSessionCreateAndStartRequest {
  readonly connectorId: string;
  readonly projectId: string;
  readonly runtime: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly content: string;
  readonly selections: Map<string, string>;
  readonly attachments: RemoteInlineAttachmentRef[];
  readonly clientMessageId: string | null;
  readonly runtimeId: string;
  readonly runtimeType: string;

  constructor(
    connectorId: string,
    projectId: string,
    runtime: string,
    title: string | null,
    cwd: string | null,
    content: string,
    selections: Map<string, string>,
    attachments: RemoteInlineAttachmentRef[],
    clientMessageId: string | null,
    runtimeId: string = runtime,
    runtimeType: string = runtime,
  ) {
    this.connectorId = connectorId;
    this.projectId = projectId;
    this.runtime = runtime;
    this.title = title;
    this.cwd = cwd;
    this.content = content;
    this.selections = selections;
    this.attachments = attachments;
    this.clientMessageId = clientMessageId;
    this.runtimeId = runtimeId;
    this.runtimeType = runtimeType;
  }
}

/** A created share link, as `POST /sessions/{id}/shares` answers it. */
export class RemoteSessionShareResponse {
  readonly shareId: string;
  readonly sharePath: string;
  readonly shareUrl: string;
  readonly scope: string;
  readonly createdAt: string;

  constructor(
    shareId: string,
    sharePath: string,
    shareUrl: string,
    scope: string,
    createdAt: string,
  ) {
    this.shareId = shareId;
    this.sharePath = sharePath;
    this.shareUrl = shareUrl;
    this.scope = scope;
    this.createdAt = createdAt;
  }
}

/** The share request body: a scope plus the item ids a reply share covers. */
interface SessionShareRequest {
  scope: string;
  itemIds: string[];
}

/** The wire shape of a share answer; every field is required by the Server. */
interface SessionShareResponseDto {
  shareId: string;
  sharePath: string;
  shareUrl: string;
  scope: string;
  createdAt: string;
}

export class SessionsApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** `GET /sessions?archived=&limit=&cursor=`. */
  async list(
    serverUrl: string,
    token: string,
    archived: boolean,
    limit: number = DEFAULT_PAGE_LIMIT,
    cursor: string | null = null,
  ): Promise<RemoteSessionPage> {
    const query: string[] = [
      `archived=${archived ? 'true' : 'false'}`,
      `limit=${limit}`,
    ];
    if (cursor !== null && cursor.length > 0) {
      query.push(`cursor=${encodeUrlComponent(cursor)}`);
    }
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions?${query.join('&')}`, token,
    );
    return parseRemoteSessionPage(body as RemoteSessionPageDto);
  }

  /** `GET /projects/{projectId}/sessions?archived=&limit=&cursor=`. */
  async listForProject(
    serverUrl: string,
    token: string,
    projectId: string,
    archived: boolean,
    limit: number = DEFAULT_PAGE_LIMIT,
    cursor: string | null = null,
  ): Promise<RemoteSessionPage> {
    const query: string[] = [
      `archived=${archived ? 'true' : 'false'}`,
      `limit=${limit}`,
    ];
    if (cursor !== null && cursor.length > 0) {
      query.push(`cursor=${encodeUrlComponent(cursor)}`);
    }
    const body: Object = await this.transport.getJson(
      serverUrl, `/projects/${encodeUrlComponent(projectId)}/sessions?${query.join('&')}`, token,
    );
    return parseRemoteSessionPage(body as RemoteSessionPageDto);
  }

  async meta(serverUrl: string, token: string, sessionId: string): Promise<RemoteSessionEnvelope> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/meta`, token,
    );
    return parseRemoteSessionEnvelope(body as RemoteSessionEnvelopeDto);
  }

  /** `PATCH /sessions/{id}/meta`. Only the provided keys are sent. */
  async patchMeta(
    serverUrl: string,
    token: string,
    sessionId: string,
    title: string | null = null,
    pinned: boolean | null = null,
    archived: boolean | null = null,
  ): Promise<RemoteSessionEnvelope> {
    const body: SessionMetaPatch = {};
    if (title !== null) {
      body.title = title;
    }
    if (pinned !== null) {
      body.pinned = pinned;
    }
    if (archived !== null) {
      body.archived = archived;
    }
    const response: Object = await this.transport.patchJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/meta`, token, body,
    );
    return parseRemoteSessionEnvelope(response as RemoteSessionEnvelopeDto);
  }

  async markRead(serverUrl: string, token: string, sessionIds: string[]): Promise<RemoteSessionBatch> {
    const body: Object = await this.transport.postJsonArray(serverUrl, '/sessions/read', token, sessionIds);
    return parseRemoteSessionBatch(body as RemoteSessionBatchDto);
  }

  async archive(serverUrl: string, token: string, sessionIds: string[]): Promise<RemoteSessionBatch> {
    const body: Object = await this.transport.postJsonArray(serverUrl, '/sessions/archive', token, sessionIds);
    return parseRemoteSessionBatch(body as RemoteSessionBatchDto);
  }

  async unarchive(serverUrl: string, token: string, sessionIds: string[]): Promise<RemoteSessionBatch> {
    const body: Object = await this.transport.postJsonArray(serverUrl, '/sessions/unarchive', token, sessionIds);
    return parseRemoteSessionBatch(body as RemoteSessionBatchDto);
  }

  async setTakeover(
    serverUrl: string,
    token: string,
    sessionId: string,
    enabled: boolean,
  ): Promise<RemoteSessionEnvelope> {
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/takeover`;
    const body: Object = enabled
      ? await this.transport.postEmpty(serverUrl, path, token)
      : await this.transport.deleteJson(serverUrl, path, token);
    return parseRemoteSessionEnvelope(body as RemoteSessionEnvelopeDto);
  }

  /** `POST /connectors/{id}/sessions/archive-all`. Sessions come back top-level. */
  async archiveAllForDevice(
    serverUrl: string,
    token: string,
    deviceId: string,
    archived: boolean,
    scope: string,
  ): Promise<RemoteSessionBatch> {
    const body: DeviceArchiveAllRequest = { archived: archived, scope: scope };
    const response: Object = await this.transport.postJson(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}/sessions/archive-all`, token, body,
    );
    return parseRemoteSessionBatch(response as RemoteSessionBatchDto);
  }

  /** `POST /projects/{id}/sessions/archive-all`. */
  async archiveAllForProject(
    serverUrl: string,
    token: string,
    projectId: string,
    archived: boolean,
    scope: string,
  ): Promise<RemoteSessionBatch> {
    const body: DeviceArchiveAllRequest = { archived: archived, scope: scope };
    const response: Object = await this.transport.postJson(
      serverUrl, `/projects/${encodeUrlComponent(projectId)}/sessions/archive-all`, token, body,
    );
    return parseRemoteSessionBatch(response as RemoteSessionBatchDto);
  }

  // ------------------------------------------------------------ session detail

  /**
   * `GET /sessions/{id}/snapshot`.
   *
   * One call returns the session, its first timeline page, the live runtime
   * state, open notices and the capability sets, which is what makes the detail
   * screen usable without a burst of parallel reads.
   */
  async snapshot(
    serverUrl: string,
    token: string,
    sessionId: string,
    limit: number = DEFAULT_PAGE_LIMIT,
  ): Promise<RemoteSessionSnapshot> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/snapshot?limit=${limit}`, token,
    );
    return parseRemoteSessionSnapshot(body as RemoteSessionSnapshotDto);
  }

  /** `GET /sessions/{id}/timeline?mode=history&beforeOrderSeq=&limit=`. */
  async timelineHistory(
    serverUrl: string,
    token: string,
    sessionId: string,
    beforeOrderSeq: number,
    limit: number = DEFAULT_PAGE_LIMIT,
  ): Promise<RemoteSessionTimelinePage> {
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/timeline`
      + `?mode=history&beforeOrderSeq=${beforeOrderSeq}&limit=${limit}`;
    const body: Object = await this.transport.getJson(serverUrl, path, token);
    return parseRemoteSessionTimelinePage(body as RemoteSessionTimelinePageDto);
  }

  /** `GET /sessions/{id}/timeline?mode=changes&afterSeq=&limit=`. */
  async timelineChanges(
    serverUrl: string,
    token: string,
    sessionId: string,
    afterSeq: number,
    limit: number = DEFAULT_PAGE_LIMIT,
  ): Promise<RemoteSessionTimelinePage> {
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/timeline`
      + `?mode=changes&afterSeq=${afterSeq}&limit=${limit}`;
    const body: Object = await this.transport.getJson(serverUrl, path, token);
    return parseRemoteSessionTimelinePage(body as RemoteSessionTimelinePageDto);
  }

  /** `GET /sessions/{id}/runtime/state`. */
  async runtimeState(
    serverUrl: string,
    token: string,
    sessionId: string,
  ): Promise<RemoteSessionRuntimeState> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/state`, token,
    );
    const envelope: RuntimeStateEnvelope = body as RuntimeStateEnvelope;
    if (envelope.state === undefined || envelope.state === null) {
      requireString(undefined, 'state');
    }
    return parseRuntimeState(envelope.state as RemoteSessionRuntimeStateDto);
  }

  /** `GET /sessions/{id}/runtime/commands`. */
  async runtimeCommands(
    serverUrl: string,
    token: string,
    sessionId: string,
  ): Promise<RemoteSessionCommand[]> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/commands`, token,
    );
    return parseRemoteSessionCommandList(body as RemoteSessionCommandListDto);
  }

  /** `POST /sessions/{id}/runtime/messages` — starts a turn. */
  /**
   * `POST /sessions/create-and-start`.
   *
   * Creates the session and sends its first message in one request, which is why
   * it gets the 75-second read timeout: the runtime has to start on the device
   * before the Server can answer. Android only writes the fields that carry a
   * value, and only sends `runtimeId` when it differs from the type, so a
   * deployment that predates runtime instances sees exactly the old request.
   */
  async createAndStartSession(
    serverUrl: string,
    token: string,
    request: RemoteSessionCreateAndStartRequest,
  ): Promise<RemoteSession> {
    const body: CreateAndStartBody = {
      connectorId: request.connectorId,
      projectId: request.projectId,
      runtime: request.runtimeType,
      content: request.content,
    };
    if (request.runtimeId.length > 0 && request.runtimeId !== request.runtimeType) {
      body.runtimeId = request.runtimeId;
    }
    if (request.title !== null && request.title.trim().length > 0) {
      body.title = request.title;
    }
    if (request.cwd !== null && request.cwd.trim().length > 0) {
      body.cwd = request.cwd;
    }
    const selections: CreateAndStartSelectionsBody = {};
    let selectionCount: number = 0;
    request.selections.forEach((value: string, key: string) => {
      if (value.trim().length === 0) {
        return;
      }
      if (key === 'model') {
        selections.model = value;
        selectionCount += 1;
      } else if (key === 'permission') {
        selections.permission = value;
        selectionCount += 1;
      }
    });
    if (selectionCount > 0) {
      body.selections = selections;
    }
    if (request.attachments.length > 0) {
      const attachments: CreateAndStartAttachmentDto[] = [];
      for (const attachment of request.attachments) {
        attachments.push({
          fileId: attachment.fileId,
          name: attachment.name,
          mediaType: attachment.mediaType,
          size: attachment.size,
          sha256: attachment.sha256,
          contentBase64: attachment.contentBase64,
        });
      }
      body.attachments = attachments;
    }
    if (request.clientMessageId !== null && request.clientMessageId.trim().length > 0) {
      body.clientMessageId = request.clientMessageId;
    }
    const response: Object = await this.transport.postJson(
      serverUrl, '/sessions/create-and-start', token, body, CREATE_AND_START_READ_TIMEOUT_MS,
    );
    const envelope: SessionCreateEnvelopeDto = response as SessionCreateEnvelopeDto;
    return parseRemoteSession(envelope.session === undefined
      ? {} as RemoteSessionDto
      : envelope.session);
  }

  async sendMessage(
    serverUrl: string,
    token: string,
    sessionId: string,
    content: string,
    clientMessageId: string,
    attachmentFileIds: string[] = [],
  ): Promise<RemoteRpcResponse> {
    const body: RuntimeMessageRequest = {
      content: content,
      clientMessageId: clientMessageId,
    };
    if (attachmentFileIds.length > 0) {
      // Only the file id is sent, matching Android.
      const attachments: RuntimeAttachmentRef[] = [];
      for (const fileId of attachmentFileIds) {
        attachments.push({ fileId: fileId });
      }
      body.attachments = attachments;
    }
    const response: Object = await this.transport.postJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/messages`, token, body,
    );
    return parseRpcResponse(response as RemoteRpcResponseDto);
  }

  /** `POST /sessions/{id}/runtime/steer` — redirects a running turn. */
  async steer(
    serverUrl: string,
    token: string,
    sessionId: string,
    content: string,
    clientMessageId: string,
    attachmentFileIds: string[] = [],
  ): Promise<RemoteRpcResponse> {
    const body: RuntimeMessageRequest = {
      content: content,
      clientMessageId: clientMessageId,
    };
    if (attachmentFileIds.length > 0) {
      const attachments: RuntimeAttachmentRef[] = [];
      for (const fileId of attachmentFileIds) {
        attachments.push({ fileId: fileId });
      }
      body.attachments = attachments;
    }
    const response: Object = await this.transport.postJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/steer`, token, body,
    );
    return parseRpcResponse(response as RemoteRpcResponseDto);
  }

  /** `POST /sessions/{id}/runtime/interrupt`. */
  async interrupt(
    serverUrl: string,
    token: string,
    sessionId: string,
  ): Promise<RemoteRpcResponse> {
    const response: Object = await this.transport.postEmpty(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/interrupt`, token,
    );
    return parseRpcResponse(response as RemoteRpcResponseDto);
  }

  /**
   * `POST /sessions/{id}/shares`.
   *
   * A share is scoped either to the whole session or to the reply the user asked
   * for, in which case `itemIds` names the messages it covers.
   */
  async createSessionShare(
    serverUrl: string,
    token: string,
    sessionId: string,
    scope: string,
    itemIds: string[],
  ): Promise<RemoteSessionShareResponse> {
    const body: SessionShareRequest = { scope: scope, itemIds: itemIds };
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/shares`;
    const response: Object = await this.transport.postJson(serverUrl, path, token, body);
    const envelope: SessionShareResponseDto = response as SessionShareResponseDto;
    return new RemoteSessionShareResponse(
      requireString(envelope.shareId, 'shareId'),
      requireString(envelope.sharePath, 'sharePath'),
      requireString(envelope.shareUrl, 'shareUrl'),
      requireString(envelope.scope, 'scope'),
      requireString(envelope.createdAt, 'createdAt'),
    );
  }

  /** `POST /sessions/{id}/runtime/notices/{noticeId}/respond`. */
  async respondToNotice(
    serverUrl: string,
    token: string,
    sessionId: string,
    noticeId: string,
    actionId: string,
    input: Object | null = null,
  ): Promise<RemoteRpcResponse> {
    const body: NoticeResponseRequest = { actionId: actionId };
    if (input !== null) {
      body.input = input;
    }
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/runtime/notices`
      + `/${encodeUrlComponent(noticeId)}/respond`;
    const response: Object = await this.transport.postJson(serverUrl, path, token, body);
    return parseRpcResponse(response as RemoteRpcResponseDto);
  }

  /** `GET /sessions/{id}/events?after=<cursor>` — realtime cursor recovery. */
  async events(
    serverUrl: string,
    token: string,
    sessionId: string,
    afterCursor: string,
  ): Promise<RemoteSessionEvents> {
    const path: string = `/sessions/${encodeUrlComponent(sessionId)}/events`
      + `?after=${encodeUrlComponent(afterCursor)}`;
    const body: Object = await this.transport.getJson(serverUrl, path, token);
    return parseRemoteSessionEvents(body as RemoteSessionEventsDto, afterCursor);
  }

  /** `GET /sessions/{id}/runtime/catalogs/model`. */
  async runtimeModelCatalog(
    serverUrl: string,
    token: string,
    sessionId: string,
    fallbackRuntimeId: string | null,
  ): Promise<RuntimeModelCatalog> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/catalogs/model`, token,
    );
    const envelope: CatalogEnvelope = body as CatalogEnvelope;
    if (envelope.catalog === undefined || envelope.catalog === null) {
      requireString(undefined, 'catalog');
    }
    return parseRuntimeModelCatalog(
      envelope.catalog as RuntimeModelCatalogDto, fallbackRuntimeId,
    );
  }

  /** `GET /sessions/{id}/runtime/catalogs/permission`. */
  async runtimePermissionCatalog(
    serverUrl: string,
    token: string,
    sessionId: string,
    fallbackRuntimeId: string | null,
  ): Promise<RuntimePermissionCatalog> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/catalogs/permission`, token,
    );
    const envelope: CatalogEnvelope = body as CatalogEnvelope;
    if (envelope.catalog === undefined || envelope.catalog === null) {
      requireString(undefined, 'catalog');
    }
    return parseRuntimePermissionCatalog(
      envelope.catalog as RuntimePermissionCatalogDto, fallbackRuntimeId,
    );
  }

  /**
   * `PATCH /sessions/{id}/runtime/selections`.
   *
   * The whole map is sent on every change, and a cleared scope is sent as an
   * explicit JSON null rather than being omitted.
   */
  async patchSelections(
    serverUrl: string,
    token: string,
    sessionId: string,
    selections: Map<string, string | null>,
  ): Promise<ParsedSelectionsPatch> {
    // A cleared scope must be an explicit JSON null, so the map is typed to
    // allow null rather than omitting the key.
    const body: Record<string, string | null> = {};
    selections.forEach((value: string | null, scope: string) => {
      body[scope] = value;
    });
    const request: SelectionsPatchRequest = { selections: body as Object };
    const response: Object = await this.transport.patchJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/selections`, token, request,
    );
    const dto: SelectionsPatchDto = response as SelectionsPatchDto;
    const stateDto: RemoteSessionRuntimeStateDto | undefined =
      objectField(dto.state) as RemoteSessionRuntimeStateDto | undefined;
    return {
      ok: dto.ok === true,
      state: stateDto === undefined ? null : parseRuntimeState(stateDto),
    };
  }

  /**
   * `POST /sessions/{id}/attachments` — multipart upload of one or more files.
   *
   * The response is `{ "attachments": [...] }` and is matched positionally with
   * the parts by the caller, which verifies size and SHA-256 before use.
   */
  async uploadSessionAttachments(
    serverUrl: string,
    token: string,
    sessionId: string,
    files: UploadFilePart[],
  ): Promise<RemoteUploadedAttachment[]> {
    const body: Object = await this.transport.postMultipart(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/attachments`, files, token,
    );
    const envelope: UploadedAttachmentsEnvelope = body as UploadedAttachmentsEnvelope;
    const uploaded: RemoteUploadedAttachment[] = [];
    for (const entry of arrayField(envelope.attachments)) {
      const dto: RemoteUploadedAttachmentDto = entry as RemoteUploadedAttachmentDto;
      uploaded.push({
        fileId: requireString(dto.fileId, 'fileId'),
        name: stringOr(dto.name, 'attachment'),
        mediaType: stringOr(dto.mediaType, ''),
        size: numberOr(dto.size, 0),
        sha256: optionalString(dto.sha256),
      });
    }
    return uploaded;
  }

  /** `GET /sessions/{id}/attachments/{fileId}/open` — the raw file, with auth. */
  attachmentOpenUrl(serverUrl: string, sessionId: string, fileId: string): string {
    return apiUrl(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/attachments/${encodeUrlComponent(fileId)}/open`,
    );
  }

  /**
   * Downloads an attachment's bytes.
   *
   * Android builds the open URL and lets the image loader fetch it with an
   * `Authorization` header; the same URL is fetched here so the token never
   * appears in a query string.
   */
  async downloadAttachmentBytes(
    serverUrl: string,
    token: string,
    sessionId: string,
    fileId: string,
  ): Promise<ArrayBuffer> {
    return await this.transport.getBytes(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/attachments/${encodeUrlComponent(fileId)}/open`,
      token,
    );
  }

  /** `POST /sessions/{id}/runtime/commands` — runs a slash command. */
  async executeCommand(
    serverUrl: string,
    token: string,
    sessionId: string,
    command: string,
    args: string[] = [],
    raw: string = '',
  ): Promise<RemoteRpcResponse> {
    const body: RuntimeCommandRequest = { command: command };
    if (args.length > 0) {
      body.args = args;
    }
    if (raw.length > 0) {
      body.raw = raw;
    }
    const response: Object = await this.transport.postJson(
      serverUrl, `/sessions/${encodeUrlComponent(sessionId)}/runtime/commands`, token, body,
    );
    return parseRpcResponse(response as RemoteRpcResponseDto);
  }
}

interface RuntimeStateEnvelope {
  state?: Object;
  serverTime?: string;
}

/** `{ "catalog": ... }` envelope used by both catalog reads. */
interface CatalogEnvelope {
  catalog?: Object;
  serverTime?: string;
}

interface SelectionsPatchRequest {
  selections: Object;
}

interface SelectionsPatchDto {
  ok?: boolean;
  state?: Object;
  connectorResult?: Object;
  serverTime?: string;
}

/** Result of a selections patch: the flag plus the authoritative state. */
export interface ParsedSelectionsPatch {
  ok: boolean;
  state: RemoteSessionRuntimeState | null;
}

/** `{ "attachments": [...] }` envelope of an attachment upload. */
interface UploadedAttachmentsEnvelope {
  attachments?: Object[];
  serverTime?: string;
}

interface RemoteUploadedAttachmentDto {
  fileId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
  sha256?: string;
}

/** One attachment the Server confirmed it stored. */
export interface RemoteUploadedAttachment {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string | null;
}

interface RuntimeMessageRequest {
  content: string;
  clientMessageId: string;
  attachments?: RuntimeAttachmentRef[];
}

interface RuntimeAttachmentRef {
  fileId: string;
}

interface NoticeResponseRequest {
  actionId: string;
  input?: Object;
}

interface RuntimeCommandRequest {
  command: string;
  args?: string[];
  raw?: string;
}

interface SessionMetaPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

interface DeviceArchiveAllRequest {
  archived: boolean;
  scope: string;
}

/** Builds a session client bound to a stored session, for call-site brevity. */
export function sessionsApiFor(transport: HttpTransport): SessionsApi {
  return new SessionsApi(transport);
}

/** The stored credentials a call needs, read fresh so a re-login is picked up. */
export interface SessionCredentials {
  serverUrl: string;
  accessToken: string;
}

/** The two selections the create endpoint accepts. */
interface CreateAndStartSelectionsBody {
  model?: string;
  permission?: string;
}

/** One inline attachment as the create endpoint expects it. */
interface CreateAndStartAttachmentDto {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

/** `POST /sessions/create-and-start` body; every optional field is omitted when empty. */
interface CreateAndStartBody {
  connectorId: string;
  projectId: string;
  runtime: string;
  runtimeId?: string;
  content: string;
  title?: string;
  cwd?: string;
  selections?: CreateAndStartSelectionsBody;
  attachments?: CreateAndStartAttachmentDto[];
  clientMessageId?: string;
}

/** `{ session: … }` answer of the create endpoint. */
interface SessionCreateEnvelopeDto {
  session?: RemoteSessionDto;
}

export function readCredentials(store: AuthSessionStore): SessionCredentials {
  return { serverUrl: store.readServerUrl(), accessToken: store.readAccessToken() };
}
