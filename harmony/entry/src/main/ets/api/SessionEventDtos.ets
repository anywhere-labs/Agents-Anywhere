import {
  arrayField, numberOr, objectField, optionalString, requireString, stringOr, stringOrFallbackWhenBlank,
} from './ApiJson';
import { RemoteSession, RemoteSessionDto, parseRemoteSession } from './SessionsDtos';
import {
  RemoteTimelineItem, RemoteTimelineItemDto, parseRemoteTimelineItem,
} from './TimelineDtos';
import {
  RemoteRuntimeCapabilitySet, RemoteRuntimeNotice, RemoteRuntimeNoticeDto,
  RemoteSessionRuntimeState, RemoteSessionRuntimeStateDto, parseRuntimeCapabilitySet,
  parseRuntimeNotice, parseRuntimeState,
} from './RuntimeDtos';

/**
 * Session realtime event DTOs.
 *
 * Port of the event portion of `api/RealtimeDtos.kt`.
 *
 * Every frame carries an envelope with a monotonic `sequence` and a `seq:<n>`
 * cursor. The cursor is what recovery resumes from, so its parsing is strict:
 * a malformed cursor must not silently resume at zero and replay the whole
 * conversation.
 */

export interface RemoteSessionEventPayloadDto {
  session?: RemoteSessionDto;
  item?: RemoteTimelineItemDto;
  items?: RemoteTimelineItemDto[];
  state?: RemoteSessionRuntimeStateDto;
  notice?: RemoteRuntimeNoticeDto;
  notices?: RemoteRuntimeNoticeDto[];
  capabilitySet?: Object;
  catalogType?: string;
  catalog?: Object;
  eventCursor?: string;
}

export interface RemoteSessionEventEnvelopeDto {
  protocolVersion?: string;
  eventId?: string;
  sequence?: number;
  cursor?: string;
  type?: string;
  sessionId?: string;
  emittedAt?: string;
  payload?: RemoteSessionEventPayloadDto;
}

/** The payload, normalised so the reducer never re-reads raw JSON. */
export interface RemoteSessionEventPayload {
  session: RemoteSession | null;
  item: RemoteTimelineItem | null;
  items: RemoteTimelineItem[];
  state: RemoteSessionRuntimeState | null;
  notice: RemoteRuntimeNotice | null;
  notices: RemoteRuntimeNotice[];
  capabilitySet: RemoteRuntimeCapabilitySet | null;
  /** `model` or `permission` when a catalog was pushed. */
  catalogType: string | null;
  catalog: Object | null;
  eventCursor: string | null;
}

export interface RemoteSessionEvent {
  protocolVersion: string;
  eventId: string;
  sequence: number;
  cursor: string;
  type: string;
  sessionId: string;
  emittedAt: string | null;
  payload: RemoteSessionEventPayload;
}

/** Event type names the reducer acts on. */
export class SessionEventType {
  static readonly SUBSCRIBED: string = 'session.subscribed';
  static readonly META_UPDATED: string = 'session.meta.updated';
  static readonly ITEM_CREATED: string = 'timeline.item_created';
  static readonly ITEM_UPDATED: string = 'timeline.item_updated';
  static readonly TIMELINE_SNAPSHOT: string = 'timeline.snapshot';
  static readonly RUNTIME_STATE_UPDATED: string = 'runtime.state.updated';
  static readonly NOTICE_SNAPSHOT: string = 'runtime.notice.snapshot';
  static readonly NOTICE_UPDATED: string = 'runtime.notice.updated';
  static readonly CAPABILITY_UPDATED: string = 'runtime.capability.updated';
  static readonly CATALOG_UPDATED: string = 'runtime.catalog.updated';
  static readonly SESSION_REFETCH: string = 'session.refetch_required';
  static readonly RUNTIME_REFETCH: string = 'runtime.refetch_required';
  static readonly KEEPALIVE: string = 'keepalive';
}

const CURSOR_PREFIX: string = 'seq:';

/**
 * Reads the sequence out of a `seq:<n>` cursor.
 *
 * Leading-zero forms such as `seq:007` are rejected rather than parsed, because
 * two different strings meaning the same position would confuse the recovery
 * comparison that decides when to stop paging.
 */
export function eventCursorSequence(cursor: string): number | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    return null;
  }
  const digits: string = cursor.substring(CURSOR_PREFIX.length);
  if (digits.length === 0 || digits.length > 1 && digits.startsWith('0')) {
    return null;
  }
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const value: number = Number.parseInt(digits, 10);
  return value >= 0 ? value : null;
}

/** Builds a cursor from a sequence. */
export function eventCursorFor(sequence: number): string {
  return `${CURSOR_PREFIX}${sequence}`;
}

/** True when `left` is at or before `right`, used to advance the cursor. */
export function laterEventCursor(left: string, right: string): string {
  const leftSeq: number | null = eventCursorSequence(left);
  const rightSeq: number | null = eventCursorSequence(right);
  if (leftSeq === null) {
    return right;
  }
  if (rightSeq === null) {
    return left;
  }
  return rightSeq > leftSeq ? right : left;
}

function parsePayload(dto: RemoteSessionEventPayloadDto | undefined): RemoteSessionEventPayload {
  if (dto === undefined || dto === null) {
    return {
      session: null,
      item: null,
      items: [],
      state: null,
      notice: null,
      notices: [],
      capabilitySet: null,
      catalogType: null,
      catalog: null,
      eventCursor: null,
    };
  }
  const items: RemoteTimelineItem[] = [];
  for (const entry of arrayField(dto.items)) {
    items.push(parseRemoteTimelineItem(entry as RemoteTimelineItemDto));
  }
  const notices: RemoteRuntimeNotice[] = [];
  for (const entry of arrayField(dto.notices)) {
    notices.push(parseRuntimeNotice(entry as RemoteRuntimeNoticeDto));
  }
  const sessionDto: RemoteSessionDto | undefined =
    objectField(dto.session) as RemoteSessionDto | undefined;
  const itemDto: RemoteTimelineItemDto | undefined =
    objectField(dto.item) as RemoteTimelineItemDto | undefined;
  const stateDto: RemoteSessionRuntimeStateDto | undefined =
    objectField(dto.state) as RemoteSessionRuntimeStateDto | undefined;
  const noticeDto: RemoteRuntimeNoticeDto | undefined =
    objectField(dto.notice) as RemoteRuntimeNoticeDto | undefined;
  const catalogType: string | null = optionalString(dto.catalogType);
  const catalog: Object | null = objectField(dto.catalog) ?? null;
  return {
    session: sessionDto === undefined ? null : parseRemoteSession(sessionDto),
    item: itemDto === undefined ? null : parseRemoteTimelineItem(itemDto),
    items: items,
    state: stateDto === undefined ? null : parseRuntimeState(stateDto),
    notice: noticeDto === undefined ? null : parseRuntimeNotice(noticeDto),
    notices: notices,
    capabilitySet: dto.capabilitySet === undefined || dto.capabilitySet === null
      ? null
      : parseRuntimeCapabilitySet(dto.capabilitySet),
    catalogType: catalogType,
    catalog: catalog,
    eventCursor: optionalString(dto.eventCursor),
  };
}

export function parseSessionEvent(dto: RemoteSessionEventEnvelopeDto): RemoteSessionEvent {
  return {
    protocolVersion: stringOr(dto.protocolVersion, ''),
    eventId: requireString(dto.eventId, 'eventId'),
    sequence: numberOr(dto.sequence, 0),
    cursor: requireString(dto.cursor, 'cursor'),
    type: requireString(dto.type, 'type'),
    sessionId: requireString(dto.sessionId, 'sessionId'),
    emittedAt: optionalString(dto.emittedAt),
    payload: parsePayload(dto.payload),
  };
}

/**
 * Parses a socket frame, returning null for anything unusable.
 *
 * `keepalive` is filtered here rather than in the reducer so the batching loop
 * never counts it towards a window, matching Android's `parseSessionMessage`.
 */
export function parseSessionMessage(text: string): RemoteSessionEvent | null {
  if (text.trim().length === 0) {
    return null;
  }
  let dto: RemoteSessionEventEnvelopeDto;
  try {
    dto = JSON.parse(text) as RemoteSessionEventEnvelopeDto;
  } catch (error) {
    return null;
  }
  if (dto === undefined || dto === null) {
    return null;
  }
  if (stringOr(dto.type, '') === SessionEventType.KEEPALIVE) {
    return null;
  }
  try {
    return parseSessionEvent(dto);
  } catch (error) {
    return null;
  }
}

/** `GET /sessions/{id}/events?after=<cursor>` — cursor recovery. */
export interface RemoteSessionEventsDto {
  events?: RemoteSessionEventEnvelopeDto[];
  nextCursor?: string;
  snapshotRequired?: boolean;
  serverTime?: string;
}

export interface RemoteSessionEvents {
  events: RemoteSessionEvent[];
  nextCursor: string;
  snapshotRequired: boolean;
  serverTime: string | null;
}

export function parseRemoteSessionEvents(
  dto: RemoteSessionEventsDto,
  fallbackCursor: string,
): RemoteSessionEvents {
  const events: RemoteSessionEvent[] = [];
  for (const entry of arrayField(dto.events)) {
    const parsed: RemoteSessionEvent | null = parseSessionMessage(JSON.stringify(entry));
    if (parsed !== null) {
      events.push(parsed);
    }
  }
  return {
    events: events,
    nextCursor: stringOrFallbackWhenBlank(dto.nextCursor, fallbackCursor),
    snapshotRequired: dto.snapshotRequired === true,
    serverTime: optionalString(dto.serverTime),
  };
}
