import Foundation

struct V2DashboardData: Hashable {
    let connectors: [V2Connector]
    let sessions: [V2SessionMeta]
}

struct V2DashboardService {
    let connectorAPI: any V2ConnectorAPIProtocol
    let sessionAPI: any V2SessionAPIProtocol
    let realtimeAPI: any V2RealtimeAPIProtocol

    /// Reads the durable dashboard resources concurrently.
    func load() async throws -> V2DashboardData {
        async let connectors = connectorAPI.listConnectors()
        async let sessions = sessionAPI.listSessions()
        let (connectorResponse, sessionResponse) = try await (connectors, sessions)
        return V2DashboardData(
            connectors: connectorResponse.connectors,
            sessions: sessionResponse.sessions
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
    }
}
