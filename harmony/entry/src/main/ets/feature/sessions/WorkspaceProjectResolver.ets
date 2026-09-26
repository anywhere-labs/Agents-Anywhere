import { AgentProject } from '../../model/AgentSession';
import { availableProjectName, workspaceProject, workspaceProjectName } from './NewSessionWorkspaces';
import { AAApiError } from '../../api/ApiError';

/**
 * Finds or creates the project that owns a workspace directory.
 *
 * Port of `feature/sessions/WorkspaceProjectResolver.kt`.
 *
 * The Server treats a project as the owner of a directory, so a session started
 * in a directory that already belongs to a project must join that project rather
 * than create a second one. A freshly created project can lose a race with
 * another client picking the same name ("project_name_conflict"), so the list is
 * re-read and the attempt repeated — at most three times, which is Android's
 * cap.
 */
export async function resolveWorkspaceProject(
  connectorId: string,
  path: string,
  deviceOs: string | null,
  knownProjects: AgentProject[],
  list: () => Promise<AgentProject[]>,
  create: (name: string, workspacePath: string) => Promise<AgentProject>,
): Promise<AgentProject> {
  if (connectorId.trim().length === 0 || path.trim().length === 0) {
    throw new Error('A device and directory are required.');
  }
  const known: AgentProject | null = workspaceProject(knownProjects, connectorId, path, deviceOs);
  if (known !== null) {
    return known;
  }
  let projects: AgentProject[] = await list();
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing: AgentProject | null = workspaceProject(projects, connectorId, path, deviceOs);
    if (existing !== null) {
      return existing;
    }
    try {
      return await create(availableProjectName(workspaceProjectName(path), projects), path.trim());
    } catch (error) {
      if (attempt === 2 || !isProjectNameConflict(error)) {
        throw asError(error);
      }
      projects = await list();
    }
  }
  throw new Error('Could not resolve this workspace.');
}

/** ArkTS only allows an `Error` to be thrown, so anything else is wrapped. */
function asError(value: Object): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(value === null || value === undefined ? 'Could not resolve this workspace.' : `${value}`);
}

/** The Server's name-collision answer, which is the only retryable failure here. */
function isProjectNameConflict(error: Object): boolean {
  if (!(error instanceof AAApiError)) {
    return false;
  }
  return error.statusCode === 409 && error.errorCode === 'project_name_conflict';
}
