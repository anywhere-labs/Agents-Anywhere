package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus

internal enum class SessionListIndicator {
    None,
    Busy,
    WaitingApproval,
    Error,
    Unread,
}

internal fun AgentSession.listIndicator(): SessionListIndicator {
    return when {
        status == SessionStatus.WaitingApproval -> SessionListIndicator.WaitingApproval
        status == SessionStatus.Error -> SessionListIndicator.Error
        status in setOf(SessionStatus.Running, SessionStatus.Waiting, SessionStatus.Pending) -> SessionListIndicator.Busy
        status == SessionStatus.Idle && unread -> SessionListIndicator.Unread
        else -> SessionListIndicator.None
    }
}
