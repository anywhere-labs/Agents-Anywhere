import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { objGetArray, objGetBool, objGetNumber, objGetOptNumber, objGetOptString, objGetRecord, objGetString, recordOrNull, recordsFromArray, requireRecord } from 'common';

export interface RemoteSession {
  id: string;
  connectorId: string;
  projectId: string | null;
  connectorStatus: string;
  runtime: string;
  externalSessionId: string | null;
  title: string | null;
  cwd: string | null;
  status: string;
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
  runtimeId: string;
  runtimeType: string;
  runtimeName: string;
}

export interface RemoteSessionResponse {
  session: RemoteSession;
  serverTime: string | null;
}

export interface RemoteSessionPage {
  sessions: RemoteSession[];
  hasMore: boolean;
  nextCursor: string | null;
  serverTime: string | null;
}

export interface RemoteSessionsMutationResponse {
  sessions: RemoteSession[];
  notFound: string[];
  serverTime: string | null;
}

// Runtime selections sent with create-and-start. Mirrors Android
// NewSessionSelections: only non-blank values are forwarded to the server.
export interface RemoteSessionSelections {
  model: string | null;
  permission: string | null;
}

// An inline attachment embedded in the create-and-start request. Mirrors
// Android RemoteInlineAttachmentRef / server InlineAttachmentRef: the payload
// travels base64-encoded inside the request, no separate upload is needed.
export interface RemoteInlineAttachmentRef {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface RemoteSessionCreateAndStartRequest {
  connectorId: string;
  projectId: string;
  runtime: string;
  runtimeId: string | null;
  content: string;
  title: string | null;
  cwd: string | null;
  selections: RemoteSessionSelections;
  attachments: RemoteInlineAttachmentRef[];
  clientMessageId: string | null;
}

// Mirrors Android NewSessionAttachmentPart.toInlineAttachmentRef: the SHA-256
// hex digest doubles as the file id and the bytes are embedded as base64.
export async function buildRemoteInlineAttachmentRef(name: string, mediaType: string,
  bytes: Uint8Array): Promise<RemoteInlineAttachmentRef> {
  const md = cryptoFramework.createMd('SHA256');
  await md.update({ data: bytes });
  const digest = await md.digest();
  let sha256 = '';
  for (let index = 0; index < digest.data.length; index++) {
    const byte = digest.data[index];
    sha256 += byte < 16 ? `0${byte.toString(16)}` : byte.toString(16);
  }
  const ref: RemoteInlineAttachmentRef = {
    fileId: sha256,
    name: name,
    mediaType: mediaType.length > 0 ? mediaType : 'application/octet-stream',
    size: bytes.length,
    sha256: sha256,
    contentBase64: new util.Base64Helper().encodeToStringSync(bytes)
  };
  return ref;
}

export interface RemoteSessionCreateResponse {
  session: RemoteSession;
}

export interface RemoteSessionTimelinePage {
  sessionId: string;
  items: RemoteTimelineItem[];
  nextSeq: number;
  hasMore: boolean;
  serverTime: string | null;
}

export interface RemoteTimelineItem {
  id: string;
  sessionId: string;
  type: string;
  status: string;
  role: string | null;
  text: string;
  kind: string | null;
  command: string | null;
  output: string | null;
  toolName: string | null;
  targetPath: string | null;
  query: string | null;
  description: string | null;
  action: string | null;
  changes: RemoteTimelineFileChange[];
  clientMessageId: string | null;
  orderSeq: number;
  revision: number;
  updatedSeq: number;
  createdAt: string;
  contentHash: string;
  attachments: RemoteTimelineAttachment[];
}

export interface RemoteTimelineFileChange {
  path: string;
  action: string;
  diff: string | null;
}

export interface RemoteTimelineAttachment {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string | null;
}

export interface RemoteUploadedAttachment {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface RemoteUploadResponse {
  attachments: RemoteUploadedAttachment[];
  serverTime: string | null;
}

export interface RemoteDownloadedAttachment {
  fileId: string;
  name: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface RemoteRuntimeCommand {
  id: string;
  title: string;
  description: string;
  aliases: string[];
  category: string | null;
  scope: string;
  enabled: boolean;
  disabledReason: string | null;
  acceptsArgs: boolean;
  argsSchemaType: string | null;
}

export interface RemoteRuntimeCommandList {
  commands: RemoteRuntimeCommand[];
  serverTime: string | null;
}

export interface RemoteCommandResult {
  ok: boolean;
  code: string;
  message: string;
  executionState: string;
  text: string | null;
}

export interface RemoteSessionSnapshot {
  session: RemoteSession;
  timelineItems: RemoteTimelineItem[];
  timelineNextSeq: number;
  timelineHasMore: boolean;
  eventCursor: string;
  serverTime: string | null;
}

export interface RemoteSessionRuntimeState {
  sessionId: string;
  runtime: string;
  externalSessionId: string | null;
  status: string;
  statusReason: string | null;
  updatedSeq: number;
  runtimeId: string;
  runtimeType: string;
  runtimeName: string;
}

export interface RemoteSessionRuntimeStateResponse {
  state: RemoteSessionRuntimeState;
  serverTime: string | null;
}

export interface RemoteRpcResponse {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RemoteProject {
  id: string;
  userId: string;
  connectorId: string;
  name: string;
  workspacePath: string;
  pinned: boolean;
  pinnedAt: string | null;
  manuallyCreated: boolean;
  activeSessionCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteProjectListResponse {
  projects: RemoteProject[];
  serverTime: string | null;
}

export interface RemoteProjectResponse {
  project: RemoteProject;
  serverTime: string | null;
}

export interface RemoteSessionEventEnvelope {
  protocolVersion: string;
  eventId: string;
  sequence: number;
  cursor: string;
  type: string;
  sessionId: string;
  emittedAt: string | null;
  payload: RemoteSessionEventPayload;
}

export interface RemoteSessionEventPayload {
  session: RemoteSession | null;
  item: RemoteTimelineItem | null;
  items: RemoteTimelineItem[];
  state: RemoteSessionRuntimeState | null;
  eventCursor: string | null;
}

export function parseRemoteSession(value: Record<string, Object>): RemoteSession {
  const runtime = objGetOptString(value, 'runtime') ?? objGetOptString(value, 'runtimeType') ?? 'codex';
  const runtimeType = objGetOptString(value, 'runtimeType') ?? runtime;
  const runtimeId = objGetOptString(value, 'runtimeId') ?? runtime;
  const runtimeName = objGetOptString(value, 'runtimeName') ?? objGetOptString(value, 'runtimeDisplayName') ??
    objGetOptString(value, 'displayName') ?? objGetOptString(value, 'name') ?? runtimeId;
  return {
    id: objGetString(value, 'id', ''),
    connectorId: objGetString(value, 'connectorId', ''),
    projectId: objGetOptString(value, 'projectId'),
    connectorStatus: objGetString(value, 'connectorStatus', 'offline'),
    runtime: runtimeType,
    externalSessionId: objGetOptString(value, 'externalSessionId'),
    title: objGetOptString(value, 'title'),
    cwd: objGetOptString(value, 'cwd'),
    status: objGetString(value, 'status', 'idle'),
    takeover: objGetBool(value, 'takeover', false),
    pinned: objGetBool(value, 'pinned', false),
    pinnedAt: objGetOptString(value, 'pinnedAt'),
    archived: objGetBool(value, 'archived', false),
    archivedAt: objGetOptString(value, 'archivedAt'),
    unread: objGetBool(value, 'unread', false),
    lastReadSeq: objGetNumber(value, 'lastReadSeq', 0),
    lastSyncedAt: objGetOptString(value, 'lastSyncedAt'),
    sourceObservedAt: objGetOptString(value, 'sourceObservedAt'),
    lastActivityAt: objGetOptString(value, 'lastActivityAt'),
    lastItemAt: objGetOptString(value, 'lastItemAt'),
    lastItemOrderSeq: objGetOptNumber(value, 'lastItemOrderSeq'),
    sortAt: objGetOptString(value, 'sortAt'),
    updatedSeq: objGetNumber(value, 'updatedSeq', 0),
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    runtimeName: runtimeName
  };
}

export function sessionsFromArray(value: Record<string, Object>): RemoteSession[] {
  const sessions: RemoteSession[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'sessions'))) {
    sessions.push(parseRemoteSession(item));
  }
  return sessions;
}

export function parseRemoteSessionResponse(value: Record<string, Object>): RemoteSessionResponse {
  return {
    session: parseRemoteSession(requireRecord(value, 'session')),
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteSessionPage(value: Record<string, Object>): RemoteSessionPage {
  return {
    sessions: sessionsFromArray(value),
    hasMore: objGetBool(value, 'hasMore', false),
    nextCursor: objGetOptString(value, 'nextCursor'),
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteSessionsMutationResponse(value: Record<string, Object>): RemoteSessionsMutationResponse {
  const notFound: string[] = [];
  for (const item of objGetArray(value, 'notFound')) {
    if (typeof item === 'string') {
      notFound.push(item);
    }
  }
  return {
    sessions: sessionsFromArray(value),
    notFound: notFound,
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteTimelineItem(value: Record<string, Object>): RemoteTimelineItem {
  const content = objGetRecord(value, 'content');
  const contentRecord: Record<string, Object> = content === null ? {} : content;
  const source = objGetRecord(value, 'source');
  const sourceRecord: Record<string, Object> = source === null ? {} : source;
  const input = objGetRecord(contentRecord, 'input');
  const inputRecord: Record<string, Object> = input === null ? {} : input;
  return {
    id: objGetString(value, 'id', ''),
    sessionId: objGetString(value, 'sessionId', ''),
    type: objGetString(value, 'type', 'message'),
    status: objGetString(value, 'status', 'done'),
    role: objGetOptString(value, 'role'),
    text: objGetOptString(contentRecord, 'text') ?? objGetOptString(contentRecord, 'message') ??
      objGetOptString(contentRecord, 'description') ?? '',
    kind: objGetOptString(contentRecord, 'kind'),
    command: timelineCommandOf(contentRecord, inputRecord),
    output: objGetOptString(contentRecord, 'output') ?? objGetOptString(contentRecord, 'outputPreview') ??
      objGetOptString(contentRecord, 'outputText') ?? objGetOptString(contentRecord, 'error'),
    toolName: objGetOptString(contentRecord, 'toolName') ?? objGetOptString(contentRecord, 'name') ??
      objGetOptString(contentRecord, 'tool') ?? objGetOptString(contentRecord, 'title'),
    targetPath: objGetOptString(contentRecord, 'path') ?? objGetOptString(contentRecord, 'filePath') ??
      objGetOptString(contentRecord, 'file') ?? objGetOptString(contentRecord, 'uri') ??
      objGetOptString(inputRecord, 'file_path') ?? objGetOptString(inputRecord, 'notebook_path') ??
      objGetOptString(inputRecord, 'path'),
    query: objGetOptString(contentRecord, 'query') ?? objGetOptString(inputRecord, 'query'),
    description: objGetOptString(contentRecord, 'description') ?? objGetOptString(contentRecord, 'title'),
    action: objGetOptString(contentRecord, 'action'),
    changes: parseTimelineFileChanges(contentRecord),
    clientMessageId: objGetOptString(sourceRecord, 'clientMessageId'),
    orderSeq: objGetNumber(value, 'orderSeq', 0),
    revision: objGetNumber(value, 'revision', 1),
    updatedSeq: objGetNumber(value, 'updatedSeq', 0),
    createdAt: objGetString(value, 'createdAt', ''),
    contentHash: objGetString(value, 'contentHash', ''),
    attachments: collectTimelineAttachments(contentRecord)
  };
}

function timelineCommandOf(content: Record<string, Object>, input: Record<string, Object>): string | null {
  const direct = timelineCommandTextOf(content, 'command');
  if (direct !== null) {
    return direct;
  }
  const fromInput = timelineCommandTextOf(input, 'command');
  if (fromInput !== null) {
    return fromInput;
  }
  return timelineCommandTextOf(input, 'cmd');
}

function timelineCommandTextOf(record: Record<string, Object>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value as Object[]) {
      parts.push(`${part}`);
    }
    const joined = parts.join(' ').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function parseTimelineFileChanges(content: Record<string, Object>): RemoteTimelineFileChange[] {
  const changes: RemoteTimelineFileChange[] = [];
  for (const changeValue of recordsFromArray(objGetArray(content, 'changes'))) {
    const path = objGetOptString(changeValue, 'path') ?? objGetOptString(changeValue, 'filePath') ??
      objGetOptString(changeValue, 'file') ?? objGetOptString(changeValue, 'uri');
    if (path === null) {
      continue;
    }
    const change: RemoteTimelineFileChange = {
      path: path,
      action: objGetString(changeValue, 'action', ''),
      diff: objGetOptString(changeValue, 'diff')
    };
    changes.push(change);
  }
  return changes;
}

export function parseRemoteTimelineAttachment(value: Record<string, Object>): RemoteTimelineAttachment | null {
  const fileId = objGetOptString(value, 'fileId');
  if (fileId === null) {
    return null;
  }
  return {
    fileId: fileId,
    name: objGetString(value, 'name', fileId),
    mediaType: objGetString(value, 'mediaType', ''),
    size: objGetNumber(value, 'size', 0),
    sha256: objGetOptString(value, 'sha256')
  };
}

function appendAttachmentRecords(content: Record<string, Object>, attachments: RemoteTimelineAttachment[],
  seen: Set<string>): void {
  for (const item of recordsFromArray(objGetArray(content, 'attachments'))) {
    const attachment = parseRemoteTimelineAttachment(item);
    if (attachment === null || seen.has(attachment.fileId)) {
      continue;
    }
    seen.add(attachment.fileId);
    attachments.push(attachment);
  }
}

function collectTimelineAttachments(content: Record<string, Object>): RemoteTimelineAttachment[] {
  const attachments: RemoteTimelineAttachment[] = [];
  const seen: Set<string> = new Set();
  appendAttachmentRecords(content, attachments, seen);
  const nested = objGetRecord(content, 'content');
  if (nested !== null) {
    appendAttachmentRecords(nested, attachments, seen);
  }
  return attachments;
}

export function parseRemoteSessionTimelinePage(value: Record<string, Object>): RemoteSessionTimelinePage {
  const items: RemoteTimelineItem[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'items'))) {
    items.push(parseRemoteTimelineItem(item));
  }
  return {
    sessionId: objGetString(value, 'sessionId', ''),
    items: items,
    nextSeq: objGetNumber(value, 'nextSeq', 0),
    hasMore: objGetBool(value, 'hasMore', false),
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteSessionSnapshot(value: Record<string, Object>): RemoteSessionSnapshot {
  const timeline = objGetRecord(value, 'timeline');
  const timelineRecord: Record<string, Object> = timeline === null ? {} : timeline;
  const items: RemoteTimelineItem[] = [];
  for (const item of recordsFromArray(objGetArray(timelineRecord, 'items'))) {
    items.push(parseRemoteTimelineItem(item));
  }
  return {
    session: parseRemoteSession(requireRecord(value, 'session')),
    timelineItems: items,
    timelineNextSeq: objGetNumber(timelineRecord, 'nextSeq', 0),
    timelineHasMore: objGetBool(timelineRecord, 'hasMore', false),
    eventCursor: objGetString(value, 'eventCursor', 'seq:0'),
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteSessionRuntimeState(value: Record<string, Object>): RemoteSessionRuntimeState {
  const runtime = objGetOptString(value, 'runtime') ?? objGetOptString(value, 'runtimeType') ?? '';
  const runtimeType = objGetOptString(value, 'runtimeType') ?? runtime;
  const runtimeId = objGetOptString(value, 'runtimeId') ?? runtime;
  const runtimeName = objGetOptString(value, 'runtimeName') ?? objGetOptString(value, 'runtimeDisplayName') ??
    objGetOptString(value, 'displayName') ?? objGetOptString(value, 'name') ?? runtimeId;
  return {
    sessionId: objGetString(value, 'sessionId', ''),
    runtime: runtimeType,
    externalSessionId: objGetOptString(value, 'externalSessionId'),
    status: objGetString(value, 'status', 'unknown'),
    statusReason: objGetOptString(value, 'statusReason'),
    updatedSeq: objGetNumber(value, 'updatedSeq', 0),
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    runtimeName: runtimeName
  };
}

export function parseRemoteSessionRuntimeStateResponse(value: Record<string, Object>): RemoteSessionRuntimeStateResponse {
  return {
    state: parseRemoteSessionRuntimeState(requireRecord(value, 'state')),
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteRpcResponse(value: Record<string, Object>): RemoteRpcResponse {
  const error = objGetRecord(value, 'error');
  return {
    ok: objGetBool(value, 'ok', false),
    errorCode: error === null ? null : objGetOptString(error, 'code'),
    errorMessage: error === null ? null : objGetOptString(error, 'message')
  };
}

export function parseRemoteProject(value: Record<string, Object>): RemoteProject {
  return {
    id: objGetString(value, 'id', ''),
    userId: objGetString(value, 'userId', ''),
    connectorId: objGetString(value, 'connectorId', ''),
    name: objGetString(value, 'name', ''),
    workspacePath: objGetString(value, 'workspacePath', ''),
    pinned: objGetBool(value, 'pinned', false),
    pinnedAt: objGetOptString(value, 'pinnedAt'),
    manuallyCreated: objGetBool(value, 'manuallyCreated', false),
    activeSessionCount: objGetNumber(value, 'activeSessionCount', 0),
    lastActivityAt: objGetOptString(value, 'lastActivityAt'),
    createdAt: objGetString(value, 'createdAt', ''),
    updatedAt: objGetString(value, 'updatedAt', '')
  };
}

export function parseRemoteProjectListResponse(value: Record<string, Object>): RemoteProjectListResponse {
  const projects: RemoteProject[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'projects'))) {
    projects.push(parseRemoteProject(item));
  }
  return {
    projects: projects,
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export interface RemoteNoticeActionInput {
  required: boolean;
  schema: Record<string, Object> | null;
  uiSchema: Record<string, Object> | null;
}

export interface RemoteNoticeAction {
  actionId: string;
  label: string;
  style: string;
  input: RemoteNoticeActionInput | null;
}

export interface RemoteRuntimeNotice {
  noticeId: string;
  sessionId: string;
  type: string;
  title: string;
  message: string | null;
  severity: string;
  status: string;
  interactionType: string | null;
  responseRequired: boolean;
  actions: RemoteNoticeAction[];
  revision: number;
  updatedSeq: number;
  createdAt: string | null;
}

export interface RemoteRuntimeNoticeList {
  notices: RemoteRuntimeNotice[];
  serverTime: string | null;
}

export function parseRemoteNoticeAction(value: Record<string, Object>): RemoteNoticeAction {
  const action: RemoteNoticeAction = {
    actionId: objGetString(value, 'actionId', ''),
    label: objGetString(value, 'label', ''),
    style: objGetString(value, 'style', 'secondary'),
    input: parseRemoteNoticeActionInput(value)
  };
  return action;
}

export function parseRemoteNoticeActionInput(value: Record<string, Object>): RemoteNoticeActionInput | null {
  const input = value['input'];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const inputRecord = input as Record<string, Object>;
  const schema = inputRecord['schema'];
  const uiSchema = inputRecord['uiSchema'];
  const result: RemoteNoticeActionInput = {
    required: objGetBool(inputRecord, 'required', false),
    schema: recordOrNull(schema),
    uiSchema: recordOrNull(uiSchema)
  };
  return result;
}

export function parseRemoteRuntimeNotice(value: Record<string, Object>): RemoteRuntimeNotice {
  const actions: RemoteNoticeAction[] = [];
  for (const actionValue of recordsFromArray(objGetArray(value, 'actions'))) {
    actions.push(parseRemoteNoticeAction(actionValue));
  }
  const notice: RemoteRuntimeNotice = {
    noticeId: objGetString(value, 'noticeId', objGetString(value, 'id', '')),
    sessionId: objGetString(value, 'sessionId', ''),
    type: objGetString(value, 'type', 'notification'),
    title: objGetString(value, 'title', ''),
    message: objGetOptString(value, 'message'),
    severity: objGetString(value, 'severity', 'info'),
    status: objGetString(value, 'status', 'open'),
    interactionType: objGetOptString(value, 'interactionType'),
    responseRequired: objGetBool(value, 'responseRequired', false),
    actions: actions,
    revision: objGetNumber(value, 'revision', 1),
    updatedSeq: objGetNumber(value, 'updatedSeq', 0),
    createdAt: objGetOptString(value, 'createdAt'),
  };
  return notice;
}

export function parseRemoteRuntimeNoticeList(value: Record<string, Object>): RemoteRuntimeNoticeList {
  const notices: RemoteRuntimeNotice[] = [];
  for (const noticeValue of recordsFromArray(objGetArray(value, 'notices'))) {
    notices.push(parseRemoteRuntimeNotice(noticeValue));
  }
  const list: RemoteRuntimeNoticeList = {
    notices: notices,
    serverTime: objGetOptString(value, 'serverTime')
  };
  return list;
}

export function parseSessionEventEnvelope(value: Record<string, Object>): RemoteSessionEventEnvelope {
  const payloadValue = objGetRecord(value, 'payload');
  const payload: Record<string, Object> = payloadValue === null ? {} : payloadValue;
  const sessionValue = objGetRecord(payload, 'session');
  const stateValue = objGetRecord(payload, 'state');
  const itemValue = objGetRecord(payload, 'item');
  const items: RemoteTimelineItem[] = [];
  for (const entry of recordsFromArray(objGetArray(payload, 'items'))) {
    items.push(parseRemoteTimelineItem(entry));
  }
  const eventPayload: RemoteSessionEventPayload = {
    session: sessionValue === null ? null : parseRemoteSession(sessionValue),
    item: itemValue === null ? null : parseRemoteTimelineItem(itemValue),
    items: items,
    state: stateValue === null ? null : parseRemoteSessionRuntimeState(stateValue),
    eventCursor: objGetOptString(payload, 'eventCursor')
  };
  return {
    protocolVersion: objGetString(value, 'protocolVersion', ''),
    eventId: objGetString(value, 'eventId', ''),
    sequence: objGetNumber(value, 'sequence', 0),
    cursor: objGetString(value, 'cursor', ''),
    type: objGetString(value, 'type', ''),
    sessionId: objGetString(value, 'sessionId', ''),
    emittedAt: objGetOptString(value, 'emittedAt'),
    payload: eventPayload
  };
}

export function parseRemoteUploadedAttachment(value: Record<string, Object>): RemoteUploadedAttachment {
  return {
    fileId: objGetString(value, 'fileId', ''),
    name: objGetString(value, 'name', ''),
    mediaType: objGetString(value, 'mediaType', 'application/octet-stream'),
    size: objGetNumber(value, 'size', 0),
    sha256: objGetString(value, 'sha256', '')
  };
}

export function parseRemoteUploadResponse(value: Record<string, Object>): RemoteUploadResponse {
  const attachments: RemoteUploadedAttachment[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'attachments'))) {
    attachments.push(parseRemoteUploadedAttachment(item));
  }
  return {
    attachments: attachments,
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteDownloadedAttachment(value: Record<string, Object>): RemoteDownloadedAttachment {
  return {
    fileId: objGetString(value, 'fileId', ''),
    name: objGetString(value, 'name', ''),
    size: objGetNumber(value, 'size', 0),
    sha256: objGetString(value, 'sha256', ''),
    contentBase64: objGetString(value, 'contentBase64', '')
  };
}

export function parseRemoteRuntimeCommand(value: Record<string, Object>): RemoteRuntimeCommand {
  const aliases: string[] = [];
  for (const alias of objGetArray(value, 'aliases')) {
    if (typeof alias === 'string' && alias.length > 0) {
      aliases.push(alias);
    }
  }
  const argsSchema = objGetRecord(value, 'argsSchema');
  return {
    id: objGetString(value, 'id', ''),
    title: objGetString(value, 'title', objGetString(value, 'id', '')),
    description: objGetString(value, 'description', ''),
    aliases: aliases,
    category: objGetOptString(value, 'category'),
    scope: objGetString(value, 'scope', 'session'),
    enabled: objGetBool(value, 'enabled', true),
    disabledReason: objGetOptString(value, 'disabledReason'),
    acceptsArgs: objGetBool(value, 'acceptsArgs', false),
    argsSchemaType: argsSchema === null ? null : objGetOptString(argsSchema, 'type')
  };
}

export function parseRemoteRuntimeCommandList(value: Record<string, Object>): RemoteRuntimeCommandList {
  const commands: RemoteRuntimeCommand[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'commands'))) {
    commands.push(parseRemoteRuntimeCommand(item));
  }
  return {
    commands: commands,
    serverTime: objGetOptString(value, 'serverTime')
  };
}

export function parseRemoteCommandResult(value: Record<string, Object>): RemoteCommandResult {
  const resultRecord = objGetRecord(value, 'result');
  const result: Record<string, Object> = resultRecord === null ? {} : resultRecord;
  const rawOk = objGetBool(value, 'ok', false);
  const code = objGetString(value, 'code', '');
  const message = objGetString(value, 'message', '');
  const text = objGetOptString(result, 'text');
  const stateValue = objGetOptString(result, 'executionState');
  let state: string;
  if (stateValue === 'accepted' || stateValue === 'completed' || stateValue === 'unknown') {
    state = stateValue;
  } else if (code === 'command_outcome_unknown') {
    state = 'unknown';
  } else if (rawOk) {
    state = 'accepted';
  } else {
    state = 'completed';
  }
  let resolvedMessage: string;
  if (rawOk) {
    resolvedMessage = text === null ? message : text;
  } else {
    resolvedMessage = message.length > 0 ? message : (text === null ? '' : text);
  }
  return {
    ok: rawOk && state !== 'unknown',
    code: code,
    message: resolvedMessage,
    executionState: state,
    text: text
  };
}

export interface RemoteRuntimeCapability {
  capabilityId: string;
  scope: string;
  runtime: string;
  supported: boolean;
  available: boolean;
  allowed: boolean;
}

export interface RemoteRuntimeCapabilitySet {
  runtime: string;
  revision: number;
  capabilities: RemoteRuntimeCapability[];
}

export interface RemoteSessionShareResponse {
  shareUrl: string;
}

export function parseRemoteRuntimeCapability(source: Record<string, Object>): RemoteRuntimeCapability {
  return {
    capabilityId: objGetString(source, 'capabilityId', ''),
    scope: objGetString(source, 'scope', ''),
    runtime: objGetString(source, 'runtime', ''),
    supported: objGetBool(source, 'supported', false),
    available: objGetBool(source, 'available', false),
    allowed: objGetBool(source, 'allowed', false)
  };
}

export function parseRemoteRuntimeCapabilitySet(source: Record<string, Object>): RemoteRuntimeCapabilitySet {
  const list: RemoteRuntimeCapability[] = [];
  const rawList = objGetArray(source, 'capabilities');
  for (const raw of rawList) {
    const record = recordOrNull(raw);
    if (record !== null) {
      list.push(parseRemoteRuntimeCapability(record));
    }
  }
  return {
    runtime: objGetString(source, 'runtime', ''),
    revision: objGetNumber(source, 'revision', 0),
    capabilities: list
  };
}

export function hasCapability(set: RemoteRuntimeCapabilitySet | null, capabilityId: string): boolean {
  if (set === null) {
    return false;
  }
  // Mirrors Android EffectiveCapability.usable: a capability is only usable
  // when it is supported, available and allowed.
  for (const capability of set.capabilities) {
    if (capability.capabilityId === capabilityId && capability.supported &&
      capability.available && capability.allowed) {
      return true;
    }
  }
  return false;
}
