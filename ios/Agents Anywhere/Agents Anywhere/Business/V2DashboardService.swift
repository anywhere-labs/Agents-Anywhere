import Foundation

struct V2DashboardData: Hashable {
    let connectors: [V2Connector]
    let projects: [V2Project]
    let active: V2SessionListResponse
    let archived: V2SessionListResponse
    var sessions: [V2SessionMeta] { active.sessions + archived.sessions }
}

struct V2DashboardService {
    let connectorAPI: any V2ConnectorAPIProtocol
    let projectAPI: V2ProjectAPI
    let sessionAPI: any V2SessionAPIProtocol
    let realtimeAPI: any V2RealtimeAPIProtocol

    /// Reads the durable dashboard resources concurrently.
    func load() async throws -> V2DashboardData {
        async let connectors = connectorAPI.listConnectors()
        async let projects = projectAPI.list()
        async let active = sessionAPI.listSessions(archived: false, cursor: nil)
        async let archived = sessionAPI.listSessions(archived: true, cursor: nil)
        let (connectorResponse, projectResponse, activeResponse, archivedResponse) = try await (connectors, projects, active, archived)
        return V2DashboardData(
            connectors: connectorResponse.connectors,
            projects: projectResponse.projects, active: activeResponse, archived: archivedResponse
        )
    }

    /// Opens the dashboard push channel after obtaining a single-use ticket.
    func updates(clientId: String) async throws -> AsyncThrowingStream<V2DashboardSnapshot, Error> {
        let ticket = try await realtimeAPI.ticket(clientId: clientId, scope: .dashboard)
        return try realtimeAPI.dashboardSnapshots(ticket: ticket.ticket)
    }

    func markRead(sessionIds: [V2SessionID]) async throws -> [V2SessionMeta] {
        try validateSessionIds(sessionIds)
        return try await sessionAPI.markRead(sessionIds: sessionIds).sessions
    }

    func renameSession(sessionId: V2SessionID, title: String) async throws -> V2SessionMeta {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { throw V2BusinessError.emptySessionTitle }
        let request = V2SessionMetaPatchRequest(
            title: trimmedTitle,
            pinned: nil,
            archived: nil
        )
        return try await sessionAPI.patchSessionMeta(sessionId: sessionId, request: request).session
    }

    func setSessionPinned(sessionId: V2SessionID, pinned: Bool) async throws -> V2SessionMeta {
        let request = V2SessionMetaPatchRequest(
            title: nil,
            pinned: pinned,
            archived: nil
        )
        return try await sessionAPI.patchSessionMeta(sessionId: sessionId, request: request).session
    }

    func archive(sessionIds: [V2SessionID]) async throws -> [V2SessionMeta] {
        try validateSessionIds(sessionIds)
        return try await sessionAPI.archive(sessionIds: sessionIds).sessions
    }

    func unarchive(sessionIds: [V2SessionID]) async throws -> [V2SessionMeta] {
        try validateSessionIds(sessionIds)
        return try await sessionAPI.unarchive(sessionIds: sessionIds).sessions
    }

    private func validateSessionIds(_ sessionIds: [V2SessionID]) throws {
        if sessionIds.isEmpty {
            throw V2BusinessError.emptySessionSelection
        }
        if sessionIds.count > 200 { throw V2BusinessError.tooManySessions }
    }
}
