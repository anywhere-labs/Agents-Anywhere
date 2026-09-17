import { AgentDevice, AgentProject } from '../model/AgentSession';
import { RemoteSession, RemoteSessionDto, parseRemoteSession } from './SessionsDtos';
import { RemoteDeviceDto, parseRemoteDevice } from './DevicesDtos';
import { RemoteProjectDto, parseRemoteProject } from './ProjectsDtos';
import { arrayField, objectField, optionalString, requireString } from './ApiJson';

/**
 * Realtime DTOs.
 *
 * Port of `api/RealtimeDtos.kt`.
 *
 * The dashboard socket pushes whole snapshots rather than deltas, so the client
 * replaces its session, project and device lists from a single message. The
 * parser is deliberately strict about the parts it needs: a message that is not
 * a `dashboard.snapshot`, or that is missing either session page, is ignored
 * rather than treated as an empty dashboard.
 */

/** `POST /ws-ticket`. */
export interface RemoteWsTicketDto {
  ticket?: string;
  expiresAt?: string;
  serverTime?: string;
}

export interface RemoteWsTicket {
  ticket: string;
  expiresAt: string;
  serverTime: string;
}

export function parseRemoteWsTicket(dto: RemoteWsTicketDto): RemoteWsTicket {
  return {
    ticket: requireString(dto.ticket, 'ticket'),
    expiresAt: requireString(dto.expiresAt, 'expiresAt'),
    serverTime: requireString(dto.serverTime, 'serverTime'),
  };
}

interface SessionPageCursorDto {
  hasMore?: boolean;
  nextCursor?: string;
}

export interface DashboardSnapshotDto {
  type?: string;
  connectors?: RemoteDeviceDto[];
  projects?: RemoteProjectDto[];
  sessions?: RemoteSessionDto[];
  sessionPages?: DashboardSessionPagesDto;
  serverTime?: string;
}

export interface DashboardSessionPagesDto {
  active?: SessionPageCursorDto;
  archived?: SessionPageCursorDto;
}

/** One page's paging cursor inside a dashboard snapshot. */
export interface DashboardPageCursor {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface DashboardSnapshot {
  devices: AgentDevice[];
  projects: AgentProject[];
  sessions: RemoteSession[];
  activePage: DashboardPageCursor;
  archivedPage: DashboardPageCursor;
  /** Sessions the Server marked archived, split out from the active list. */
  serverTime: string | null;
}

const DASHBOARD_SNAPSHOT_TYPE: string = 'dashboard.snapshot';

/**
 * Parses a dashboard message, returning null for anything that is not a
 * well-formed snapshot.
 *
 * Both session pages are required. Android treats their absence as "not my
 * message" so a partial or future payload cannot blank the user's list.
 */
export function parseDashboardSnapshot(text: string): DashboardSnapshot | null {
  if (text.trim().length === 0) {
    return null;
  }
  let dto: DashboardSnapshotDto;
  try {
    dto = JSON.parse(text) as DashboardSnapshotDto;
  } catch (error) {
    return null;
  }
  if (dto === undefined || dto === null) {
    return null;
  }
  if ((dto.type ?? '') !== DASHBOARD_SNAPSHOT_TYPE) {
    return null;
  }
  const pages: DashboardSessionPagesDto | undefined =
    objectField(dto.sessionPages) as DashboardSessionPagesDto | undefined;
  if (pages === undefined) {
    return null;
  }
  const activeDto: SessionPageCursorDto | undefined =
    objectField(pages.active) as SessionPageCursorDto | undefined;
  const archivedDto: SessionPageCursorDto | undefined =
    objectField(pages.archived) as SessionPageCursorDto | undefined;
  if (activeDto === undefined || archivedDto === undefined) {
    return null;
  }

  const devices: AgentDevice[] = [];
  for (const entry of arrayField(dto.connectors)) {
    devices.push(parseRemoteDevice(entry as RemoteDeviceDto));
  }
  const projects: AgentProject[] = [];
  for (const entry of arrayField(dto.projects)) {
    projects.push(parseRemoteProject(entry as RemoteProjectDto));
  }
  const sessions: RemoteSession[] = [];
  for (const entry of arrayField(dto.sessions)) {
    sessions.push(parseRemoteSession(entry as RemoteSessionDto));
  }

  return {
    devices: devices,
    projects: projects,
    sessions: sessions,
    activePage: {
      hasMore: activeDto.hasMore === true,
      nextCursor: optionalString(activeDto.nextCursor),
    },
    archivedPage: {
      hasMore: archivedDto.hasMore === true,
      nextCursor: optionalString(archivedDto.nextCursor),
    },
    serverTime: optionalString(dto.serverTime),
  };
}

/** `keepalive` frames carry no payload and are dropped by the parser. */
export function isKeepalive(text: string): boolean {
  return text.includes('"keepalive"');
}
