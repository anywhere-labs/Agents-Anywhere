package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.model.AgentProject

internal fun resolveWorkspaceProject(
    connectorId: String,
    path: String,
    deviceOs: String?,
    knownProjects: List<AgentProject>,
    list: () -> List<AgentProject>,
    create: (String, String) -> AgentProject,
): AgentProject {
    require(connectorId.isNotBlank() && path.isNotBlank()) { "A device and directory are required." }
    workspaceProject(knownProjects, connectorId, path, deviceOs)?.let { return it }
    var projects = list()
    repeat(3) { attempt ->
        workspaceProject(projects, connectorId, path, deviceOs)?.let { return it }
        try {
            return create(availableProjectName(workspaceProjectName(path), projects), path.trim())
        } catch (error: ApiException) {
            if (attempt == 2 || error.statusCode != 409 || error.errorCode != "project_name_conflict") throw error
            projects = list()
        }
    }
    error("Could not resolve this workspace.")
}
