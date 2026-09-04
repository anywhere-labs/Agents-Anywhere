package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RemoteProject
import com.agentsanywhere.app.model.AgentProject

internal fun RemoteProject.toAgentProject(): AgentProject {
    return AgentProject(
        id = id,
        userId = userId,
        connectorId = connectorId,
        name = name,
        workspacePath = workspacePath,
        pinned = pinned,
        pinnedAt = pinnedAt,
        activeSessionCount = activeSessionCount,
        lastActivityAt = lastActivityAt,
        createdAt = createdAt,
        updatedAt = updatedAt,
    )
}
