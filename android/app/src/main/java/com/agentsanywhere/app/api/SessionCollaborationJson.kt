package com.agentsanywhere.app.api

import com.agentsanywhere.app.model.SessionOrigin
import com.agentsanywhere.app.model.SupervisionCreator
import com.agentsanywhere.app.model.SupervisionEdge
import com.agentsanywhere.app.model.SupervisionState
import org.json.JSONArray
import org.json.JSONObject

internal const val SESSION_ORIGIN_KIND_AGENT = "agent"

/** `SessionView.origin`; an unknown kind or a missing creator session reads as absent. */
internal fun JSONObject.toSessionOrigin(): SessionOrigin? {
    if (optNullableString("kind") != SESSION_ORIGIN_KIND_AGENT) return null
    val bySessionId = optNullableString("bySessionId") ?: return null
    return SessionOrigin(
        bySessionId = bySessionId,
        byDeviceId = optNullableString("byDeviceId"),
        depth = optNullableInt("depth")?.takeIf { it >= 1 } ?: 1,
    )
}

/** `SessionView.supervisors` / `supervised`; edges with missing ids or an unknown state are skipped. */
internal fun JSONArray?.toSupervisionEdges(): List<SupervisionEdge> {
    if (this == null) return emptyList()
    return List(length()) { index -> optJSONObject(index)?.toSupervisionEdge() }.filterNotNull()
}

private fun JSONObject.toSupervisionEdge(): SupervisionEdge? {
    return SupervisionEdge(
        supervisionId = optNullableString("supervisionId") ?: return null,
        supervisorSessionId = optNullableString("supervisorSessionId") ?: return null,
        targetSessionId = optNullableString("targetSessionId") ?: return null,
        state = SupervisionState.fromWire(optNullableString("state")) ?: return null,
        createdBy = SupervisionCreator.fromWire(optNullableString("createdBy")),
    )
}
