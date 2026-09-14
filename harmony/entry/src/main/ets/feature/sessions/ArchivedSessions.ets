import { AgentProject, AgentSession } from '../../model/AgentSession';
import { compareArchivedSessions, parseIsoInstantMillis } from './SessionMappers';

/**
 * Archived session grouping and formatting.
 *
 * Port of `groupArchivedSessions` and the timestamp formatting in
 * `ui/screens/home/ArchivedSessionsScreen.kt`.
 *
 * Groups follow the project list order with the unknown-project bucket last,
 * which is what makes the page stable as sessions are restored.
 */

/** Sessions for one project, or for the unknown bucket. */
export interface ArchivedSessionGroup {
  /** Null for sessions whose project is no longer resolvable. */
  projectId: string | null;
  projectName: string;
  projectPath: string;
  sessions: AgentSession[];
}

export function groupArchivedSessions(
  sessions: AgentSession[],
  projects: AgentProject[],
): ArchivedSessionGroup[] {
  const sorted: AgentSession[] = sessions.slice().sort(compareArchivedSessions);
  const groups: ArchivedSessionGroup[] = [];
  const indexByProjectId: Map<string, number> = new Map();

  for (const project of projects) {
    indexByProjectId.set(project.id, groups.length);
    groups.push({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.workspacePath,
      sessions: [],
    });
  }

  const unknownSessions: AgentSession[] = [];
  for (const session of sorted) {
    const projectId: string | null = session.projectId;
    const index: number | undefined = projectId === null ? undefined : indexByProjectId.get(projectId);
    if (index === undefined) {
      unknownSessions.push(session);
    } else {
      groups[index].sessions.push(session);
    }
  }

  // The unknown bucket is always last so it never displaces a real project.
  const withSessions: ArchivedSessionGroup[] = groups
    .filter((group: ArchivedSessionGroup) => group.sessions.length > 0);
  if (unknownSessions.length > 0) {
    withSessions.push({
      projectId: null,
      projectName: '',
      projectPath: '',
      sessions: unknownSessions,
    });
  }
  return withSessions;
}

/** Sessions in one group, used by the "restore all" action. */
export function groupSessionIds(group: ArchivedSessionGroup): string[] {
  return group.sessions.map((session: AgentSession) => session.id);
}

const MONTHS: string[] = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12',
];

/**
 * `yyyy-MM-dd HH:mm` in local time, or an empty string when the timestamp is
 * missing or has no UTC offset — the caller substitutes the "unavailable" copy.
 */
export function formatArchivedAt(instant: string | null): string {
  const millis: number | null = parseIsoInstantMillis(instant);
  if (millis === null) {
    return '';
  }
  const date: Date = new Date(millis);
  const year: number = date.getFullYear();
  const month: string = MONTHS[date.getMonth()];
  const day: string = pad2(date.getDate());
  const hours: string = pad2(date.getHours());
  const minutes: string = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}
