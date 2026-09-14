import {
  arrayField, numberOr, objectField, optionalString, requireString, stringOr, stringOrFallbackWhenBlank,
} from './ApiJson';
import { RemoteSession, RemoteSessionDto, parseRemoteSession } from './SessionsDtos';
import {
  parseRuntimeCapabilitySet, parseRuntimeNoticeList, parseRuntimeState, RemoteRuntimeCapabilitySet,
  RemoteRuntimeNotice, RemoteSessionRuntimeState, RemoteSessionRuntimeStateDto,
} from './RuntimeDtos';

/**
 * Timeline and session snapshot DTOs.
 *
 * Port of the timeline portion of `api/SessionsDtos.kt`.
 *
 * A timeline item is deliberately loose on the wire: the Server sends a `type`,
 * an optional discriminator inside `content`, and the client decides how to
 * render it. `content` and `source` are therefore kept as raw objects and read
 * through the typed accessors below rather than being normalised on the way in —
 * an unknown item must survive parsing so the projection can show it as a
 * diagnostic instead of dropping it.
 */

const DEFAULT_ITEM_TYPE: string = 'message';
const DEFAULT_ITEM_STATUS: string = 'done';

export interface RemoteTimelineItemDto {
  id?: string;
  sessionId?: string;
  type?: string;
  status?: string;
  role?: string;
  content?: Object;
  source?: Object;
  orderSeq?: number;
  revision?: number;
  updatedSeq?: number;
  createdAt?: string;
  updatedAt?: string;
  contentHash?: string;
}

export interface RemoteTimelineItem {
  id: string;
  sessionId: string;
  type: string;
  status: string;
  role: string | null;
  /** Flattened text, already resolved from the three possible wire fields. */
  text: string;
  /** Raw content object, read through the accessors below. */
  content: Object;
  source: Object;
  orderSeq: number;
  revision: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string | null;
  contentHash: string;
}

/** Content shape read by the timeline projection. */
export interface TimelineItemContent {
  text?: string;
  message?: string;
  description?: string;
  /** Discriminator inside `content`, e.g. `command`, `file_change`, `reasoning`. */
  kind?: string;
  contentKind?: string;
  command?: string;
  output?: string;
  body?: string;
  toolError?: boolean;
  error?: string;
  title?: string;
  subtitle?: string;
  detail?: string;
  path?: string;
  diff?: string;
  action?: string;
  status?: string;
  segments?: TimelineReasoningSegmentDto[];
  fileChanges?: TimelineFileChangeDto[];
  agentCall?: TimelineAgentCallDto;
  attachments?: TimelineAttachmentDto[];
  /** Idempotency key echoed back on the Server's own row for an optimistic send. */
  clientMessageId?: string;
  metadata?: Object;
}

/** `content.attachments[]` — only the fields the timeline needs. */
export interface TimelineAttachmentDto {
  fileId?: string;
  id?: string;
  name?: string;
  mediaType?: string;
  size?: number;
}

export interface TimelineReasoningSegmentDto {
  text?: string;
  title?: string;
}

export interface TimelineFileChangeDto {
  action?: string;
  path?: string;
  diff?: string;
}

export interface TimelineAgentCallDto {
  action?: string;
  description?: string;
  parentItemId?: string;
}

/** `content.agentCall` mapped onto a stable shape. */
export interface TimelineAgentCall {
  action: string;
  description: string;
  parentItemId: string | null;
}

/** `content.fileChanges[]` mapped onto a stable shape. */
export interface TimelineFileChange {
  action: string;
  path: string;
  diff: string;
}

export function parseRemoteTimelineItem(dto: RemoteTimelineItemDto): RemoteTimelineItem {
  const content: Object = objectField(dto.content) ?? EMPTY_OBJECT;
  const source: Object = objectField(dto.source) ?? EMPTY_OBJECT;
  const typedContent: TimelineItemContent = content as TimelineItemContent;
  // Android reads the display text from the first non-blank of three fields.
  const text: string = stringOrFallbackWhenBlank(
    stringOrFallbackWhenBlank(
      stringOrFallbackWhenBlank(typedContent.text, typedContent.message ?? ''),
      typedContent.description ?? '',
    ),
    '',
  );
  return {
    id: requireString(dto.id, 'id'),
    sessionId: stringOr(dto.sessionId, ''),
    type: stringOrFallbackWhenBlank(dto.type, DEFAULT_ITEM_TYPE),
    status: stringOrFallbackWhenBlank(dto.status, DEFAULT_ITEM_STATUS),
    role: optionalString(dto.role),
    text: text,
    content: content,
    source: source,
    orderSeq: numberOr(dto.orderSeq, 0),
    revision: numberOr(dto.revision, 1),
    updatedSeq: numberOr(dto.updatedSeq, 0),
    createdAt: stringOr(dto.createdAt, ''),
    updatedAt: optionalString(dto.updatedAt),
    contentHash: stringOr(dto.contentHash, ''),
  };
}

const EMPTY_OBJECT: Object = JSON.parse('{}') as Object;

export interface RemoteSessionTimelinePageDto {
  sessionId?: string;
  items?: RemoteTimelineItemDto[];
  nextSeq?: number;
  hasMore?: boolean;
  serverTime?: string;
}

export interface RemoteSessionTimelinePage {
  sessionId: string;
  items: RemoteTimelineItem[];
  nextSeq: number;
  hasMore: boolean;
  serverTime: string | null;
}

export function parseRemoteSessionTimelinePage(dto: RemoteSessionTimelinePageDto): RemoteSessionTimelinePage {
  const items: RemoteTimelineItem[] = [];
  for (const entry of arrayField(dto.items)) {
    items.push(parseRemoteTimelineItem(entry as RemoteTimelineItemDto));
  }
  return {
    sessionId: stringOr(dto.sessionId, ''),
    items: items,
    nextSeq: numberOr(dto.nextSeq, 0),
    hasMore: dto.hasMore === true,
    serverTime: optionalString(dto.serverTime),
  };
}

/** `GET /sessions/{id}/snapshot` — everything the detail screen needs at once. */
export interface RemoteSessionSnapshotDto {
  session?: RemoteSessionDto;
  state?: Object;
  timeline?: RemoteSessionTimelinePageDto;
  notices?: Object[];
  effectiveCapabilities?: Object;
  runtimeCapabilities?: Object;
  eventCursor?: string;
  serverTime?: string;
}

export interface RemoteSessionSnapshot {
  session: RemoteSession;
  /** Live runtime state; null when the Server omitted it. */
  state: RemoteSessionRuntimeState | null;
  timeline: RemoteSessionTimelinePage;
  notices: RemoteRuntimeNotice[];
  effectiveCapabilities: RemoteRuntimeCapabilitySet;
  runtimeCapabilities: RemoteRuntimeCapabilitySet;
  /** Server-side cursor the realtime channel resumes from. */
  eventCursor: string;
  serverTime: string | null;
}

const DEFAULT_EVENT_CURSOR: string = 'seq:0';

export function parseRemoteSessionSnapshot(dto: RemoteSessionSnapshotDto): RemoteSessionSnapshot {
  if (dto.session === undefined || dto.session === null) {
    requireString(undefined, 'session');
  }
  // An absent `timeline` is tolerated and becomes an empty page.
  const timelineDto: RemoteSessionTimelinePageDto | undefined =
    objectField(dto.timeline) as RemoteSessionTimelinePageDto | undefined;
  const timeline: RemoteSessionTimelinePage = timelineDto === undefined
    ? { sessionId: '', items: [], nextSeq: 0, hasMore: false, serverTime: null }
    : parseRemoteSessionTimelinePage(timelineDto);
  const stateDto: RemoteSessionRuntimeStateDto | undefined =
    objectField(dto.state) as RemoteSessionRuntimeStateDto | undefined;
  return {
    session: parseRemoteSession(dto.session as RemoteSessionDto),
    state: stateDto === undefined ? null : parseRuntimeState(stateDto),
    timeline: timeline,
    notices: parseRuntimeNoticeList(dto.notices),
    effectiveCapabilities: parseRuntimeCapabilitySet(dto.effectiveCapabilities),
    runtimeCapabilities: parseRuntimeCapabilitySet(dto.runtimeCapabilities),
    eventCursor: stringOrFallbackWhenBlank(dto.eventCursor, DEFAULT_EVENT_CURSOR),
    serverTime: optionalString(dto.serverTime),
  };
}

/** Reads the typed view of an item's content. */
export function timelineContent(item: RemoteTimelineItem): TimelineItemContent {
  return item.content as TimelineItemContent;
}

/** Reads the typed view of an item's source. */
export function timelineSource(item: RemoteTimelineItem): TimelineItemSource {
  return item.source as TimelineItemSource;
}

export interface TimelineItemSource {
  timelineItemId?: string;
  itemId?: string;
}
