import { arrayField, booleanOr, numberOr, optionalString, requireString, stringOrFallbackWhenBlank } from './ApiJson';

/**
 * Session DTOs.
 *
 * Port of the session portion of `api/SessionsDtos.kt`.
 *
 * `RemoteSession` has the trickiest derivation rules in the API surface: four
 * fields are mutually fallback-chained, `runtime` can stand in for both the id
 * and the type, and the final type fallback is the literal `"codex"`. Those
 * rules are reproduced verbatim because the client's capability lookups are keyed
 * on `runtimeId` and `runtimeType`.
 */

export interface RemoteSessionDto {
  id?: string;
  connectorId?: string;
  projectId?: string;
  connectorStatus?: string;
  externalSessionId?: string;
  title?: string;
  cwd?: string;
  status?: string;
  takeover?: boolean;
  pinned?: boolean;
  pinnedAt?: string;
  archived?: boolean;
  archivedAt?: string;
  unread?: boolean;
  lastReadSeq?: number;
  lastSyncedAt?: string;
  sourceObservedAt?: string;
  lastActivityAt?: string;
  lastItemAt?: string;
  lastItemOrderSeq?: number;
  sortAt?: string;
  updatedSeq?: number;
  /** Legacy field name for the runtime type. */
  runtime?: string;
  runtimeId?: string;
  runtimeType?: string;
  runtimeName?: string;
  runtimeDisplayName?: string;
  displayName?: string;
  name?: string;
}

export interface RemoteSession {
  id: string;
  connectorId: string;
  projectId: string | null;
  connectorStatus: string;
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
  runtime: string;
  runtimeId: string;
  runtimeType: string;
  runtimeName: string;
}

export function parseRemoteSession(dto: RemoteSessionDto): RemoteSession {
  // Legacy `runtime` wins over `runtimeType`, and stands in for the id.
  const legacyRuntime: string | null = optionalString(dto.runtime);
  const runtime: string = stringOrFallbackWhenBlank(legacyRuntime ?? dto.runtimeType, 'codex');
  const runtimeType: string = stringOrFallbackWhenBlank(dto.runtimeType, runtime);
  const runtimeId: string = stringOrFallbackWhenBlank(dto.runtimeId, runtime);
  const runtimeName: string = stringOrFallbackWhenBlank(
    stringOrFallbackWhenBlank(
      stringOrFallbackWhenBlank(
        stringOrFallbackWhenBlank(dto.runtimeName, dto.runtimeDisplayName ?? ''),
        dto.displayName ?? '',
      ),
      dto.name ?? '',
    ),
    runtimeId,
  );
  return {
    id: requireString(dto.id, 'id'),
    connectorId: requireString(dto.connectorId, 'connectorId'),
    projectId: optionalString(dto.projectId),
    connectorStatus: stringOrFallbackWhenBlank(dto.connectorStatus, 'offline'),
    externalSessionId: optionalString(dto.externalSessionId),
    title: optionalString(dto.title),
    cwd: optionalString(dto.cwd),
    status: stringOrFallbackWhenBlank(dto.status, 'idle'),
    takeover: booleanOr(dto.takeover, false),
    pinned: booleanOr(dto.pinned, false),
    pinnedAt: optionalString(dto.pinnedAt),
    archived: booleanOr(dto.archived, false),
    archivedAt: optionalString(dto.archivedAt),
    unread: booleanOr(dto.unread, false),
    lastReadSeq: numberOr(dto.lastReadSeq, 0),
    lastSyncedAt: optionalString(dto.lastSyncedAt),
    sourceObservedAt: optionalString(dto.sourceObservedAt),
    lastActivityAt: optionalString(dto.lastActivityAt),
    lastItemAt: optionalString(dto.lastItemAt),
    lastItemOrderSeq: dto.lastItemOrderSeq === undefined || dto.lastItemOrderSeq === null
      ? null
      : numberOr(dto.lastItemOrderSeq, 0),
    sortAt: optionalString(dto.sortAt),
    updatedSeq: numberOr(dto.updatedSeq, 0),
    runtime: runtime,
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    runtimeName: runtimeName,
  };
}

/** `GET /sessions` and `GET /projects/{id}/sessions`. */
export interface RemoteSessionPageDto {
  sessions?: RemoteSessionDto[];
  hasMore?: boolean;
  nextCursor?: string;
  serverTime?: string;
}

export interface RemoteSessionPage {
  sessions: RemoteSession[];
  hasMore: boolean;
  nextCursor: string | null;
  serverTime: string | null;
}

export function parseRemoteSessionPage(dto: RemoteSessionPageDto): RemoteSessionPage {
  const sessions: RemoteSession[] = [];
  for (const entry of arrayField(dto.sessions)) {
    sessions.push(parseRemoteSession(entry as RemoteSessionDto));
  }
  return {
    sessions: sessions,
    hasMore: booleanOr(dto.hasMore, false),
    nextCursor: optionalString(dto.nextCursor),
    serverTime: optionalString(dto.serverTime),
  };
}

/** `{ "session": ... }` envelope used by meta reads, patches and takeover. */
export interface RemoteSessionEnvelopeDto {
  session?: RemoteSessionDto;
  serverTime?: string;
}

export interface RemoteSessionEnvelope {
  session: RemoteSession;
  serverTime: string | null;
}

export function parseRemoteSessionEnvelope(dto: RemoteSessionEnvelopeDto): RemoteSessionEnvelope {
  if (dto.session === undefined || dto.session === null) {
    requireString(undefined, 'session');
  }
  return {
    session: parseRemoteSession(dto.session as RemoteSessionDto),
    serverTime: optionalString(dto.serverTime),
  };
}

/** `POST /sessions/read`, `/archive` and `/unarchive`. */
export interface RemoteSessionBatchDto {
  sessions?: RemoteSessionDto[];
  notFound?: string[];
  serverTime?: string;
}

export interface RemoteSessionBatch {
  sessions: RemoteSession[];
  notFound: string[];
  serverTime: string | null;
}

export function parseRemoteSessionBatch(dto: RemoteSessionBatchDto): RemoteSessionBatch {
  const sessions: RemoteSession[] = [];
  for (const entry of arrayField(dto.sessions)) {
    sessions.push(parseRemoteSession(entry as RemoteSessionDto));
  }
  const notFound: string[] = [];
  for (const entry of arrayField(dto.notFound)) {
    if (typeof entry === 'string' && entry.length > 0) {
      notFound.push(entry);
    }
  }
  return {
    sessions: sessions,
    notFound: notFound,
    serverTime: optionalString(dto.serverTime),
  };
}
