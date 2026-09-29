import { AgentProject, ProjectSessionCounts } from '../model/AgentSession';
import {
  arrayField, booleanOr, numberOr, objectField, optionalString, requireString, stringOr,
} from './ApiJson';

/**
 * Project DTOs.
 *
 * Port of `api/ProjectsDtos.kt`.
 */

export interface SidebarSessionCountsDto {
  active?: number;
  archived?: number;
}

export interface RemoteProjectDto {
  id?: string;
  userId?: string;
  connectorId?: string;
  name?: string;
  workspacePath?: string;
  pinned?: boolean;
  pinnedAt?: string;
  manuallyCreated?: boolean;
  sidebarSessionCounts?: SidebarSessionCountsDto;
  activeSessionCount?: number;
  lastActivityAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseRemoteProject(dto: RemoteProjectDto): AgentProject {
  const countsDto: SidebarSessionCountsDto | undefined =
    objectField(dto.sidebarSessionCounts) as SidebarSessionCountsDto | undefined;
  let counts: ProjectSessionCounts | null = null;
  if (countsDto !== undefined) {
    counts = {
      active: numberOr(countsDto.active, 0),
      archived: numberOr(countsDto.archived, 0),
    };
  }
  return {
    id: requireString(dto.id, 'id'),
    userId: requireString(dto.userId, 'userId'),
    connectorId: requireString(dto.connectorId, 'connectorId'),
    name: requireString(dto.name, 'name'),
    workspacePath: requireString(dto.workspacePath, 'workspacePath'),
    pinned: booleanOr(dto.pinned, false),
    pinnedAt: optionalString(dto.pinnedAt),
    manuallyCreated: booleanOr(dto.manuallyCreated, false),
    sidebarSessionCounts: counts,
    activeSessionCount: numberOr(dto.activeSessionCount, 0),
    lastActivityAt: optionalString(dto.lastActivityAt),
    createdAt: stringOr(dto.createdAt, ''),
    updatedAt: stringOr(dto.updatedAt, ''),
  };
}

export interface RemoteProjectListDto {
  projects?: RemoteProjectDto[];
  serverTime?: string;
}

export function parseRemoteProjectList(dto: RemoteProjectListDto): AgentProject[] {
  const projects: AgentProject[] = [];
  for (const entry of arrayField(dto.projects)) {
    projects.push(parseRemoteProject(entry as RemoteProjectDto));
  }
  return projects;
}

/** `{ "project": ... }` envelope used by create and patch. */
export interface RemoteProjectEnvelopeDto {
  project?: RemoteProjectDto;
  serverTime?: string;
}

export function parseRemoteProjectEnvelope(dto: RemoteProjectEnvelopeDto): AgentProject {
  if (dto.project === undefined || dto.project === null) {
    requireString(undefined, 'project');
  }
  return parseRemoteProject(dto.project as RemoteProjectDto);
}
