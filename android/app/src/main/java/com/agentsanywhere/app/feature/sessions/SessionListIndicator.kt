package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus

internal enum class SessionListIndicator {
    None,
    Busy,
    WaitingApproval,
    Unread,
}

internal fun AgentSession.listIndicator(): SessionListIndicator {
    return when {
        status == SessionStatus.WaitingApproval -> SessionListIndicator.WaitingApproval
        status in setOf(SessionStatus.Running, SessionStatus.Waiting, SessionStatus.Pending) -> SessionListIndicator.Busy
        status == SessionStatus.Idle && unread -> SessionListIndicator.Unread
        else -> SessionListIndicator.None
    }
}
