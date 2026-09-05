import Foundation

protocol V2SessionAPIProtocol {
    func setTakeover(sessionId: V2SessionID, enabled: Bool) async throws -> V2SessionTakeoverResponse
    func sync(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse
    func listSessions() async throws -> V2SessionListResponse
    func sessionMeta(sessionId: V2SessionID) async throws -> V2SessionMetaResponse
    func patchSessionMeta(sessionId: V2SessionID, request: V2SessionMetaPatchRequest) async throws -> V2SessionMetaResponse
    func createSession(request: V2SessionCreateRequest) async throws -> V2SessionCreateResponse
    func createAndStartSession(request: V2SessionCreateAndStartRequest) async throws -> V2SessionCreateResponse
    func markRead(sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse
    func archive(sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse
    func unarchive(sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse
    func snapshot(sessionId: V2SessionID, limit: Int) async throws -> V2SessionSnapshot
    func latestTimeline(sessionId: V2SessionID, limit: Int) async throws -> V2SessionTimelinePage
    func timelineChanges(sessionId: V2SessionID, afterSeq: Int, limit: Int) async throws -> V2SessionTimelinePage
    func timelineHistory(sessionId: V2SessionID, beforeOrderSeq: Int, limit: Int) async throws -> V2SessionTimelinePage
}

struct V2SessionAPI: V2SessionAPIProtocol {
    let transport: any HTTPTransport

    func listSessions() async throws -> V2SessionListResponse {
        let request = HTTPRequest<EmptyRequestBody, V2SessionListResponse>(method: .get, path: "/sessions")
        return try await transport.send(request)
    }

    func sessionMeta(sessionId: V2SessionID) async throws -> V2SessionMetaResponse {
        let request = HTTPRequest<EmptyRequestBody, V2SessionMetaResponse>(
            method: .get,
            path: sessionPath(sessionId, suffix: "meta")
        )
        return try await transport.send(request)
    }

    func patchSessionMeta(
        sessionId: V2SessionID,
        request body: V2SessionMetaPatchRequest
    ) async throws -> V2SessionMetaResponse {
        let request = HTTPRequest<V2SessionMetaPatchRequest, V2SessionMetaResponse>(
            method: .patch,
            path: sessionPath(sessionId, suffix: "meta"),
            body: body
        )
        return try await transport.send(request)
    }

    func createSession(request body: V2SessionCreateRequest) async throws -> V2SessionCreateResponse {
        let request = HTTPRequest<V2SessionCreateRequest, V2SessionCreateResponse>(
            method: .post,
            path: "/sessions",
            body: body
        )
        return try await transport.send(request)
    }

    func createAndStartSession(request body: V2SessionCreateAndStartRequest) async throws -> V2SessionCreateResponse {
        let request = HTTPRequest<V2SessionCreateAndStartRequest, V2SessionCreateResponse>(
            method: .post,
            path: "/sessions/create-and-start",
            body: body
        )
        return try await transport.send(request)
    }

    func markRead(sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse {
        try await bulkAction(path: "/sessions/read", sessionIds: sessionIds)
    }

    func archive(sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse {
        try await bulkAction(path: "/sessions/archive", sessionIds: sessionIds)
    }

    func unarchive(sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse {
        try await bulkAction(path: "/sessions/unarchive", sessionIds: sessionIds)
    }

    func snapshot(sessionId: V2SessionID, limit: Int) async throws -> V2SessionSnapshot {
        let request = HTTPRequest<EmptyRequestBody, V2SessionSnapshot>(
            method: .get,
            path: sessionPath(sessionId, suffix: "snapshot"),
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
        )
        return try await transport.send(request)
    }

    func latestTimeline(sessionId: V2SessionID, limit: Int) async throws -> V2SessionTimelinePage {
        try await timeline(sessionId: sessionId, mode: .latest, limit: limit)
    }

    func timelineChanges(sessionId: V2SessionID, afterSeq: Int, limit: Int) async throws -> V2SessionTimelinePage {
        try await timeline(sessionId: sessionId, mode: .changes, afterSeq: afterSeq, limit: limit)
    }

    func timelineHistory(
        sessionId: V2SessionID,
        beforeOrderSeq: Int,
        limit: Int
    ) async throws -> V2SessionTimelinePage {
        try await timeline(
            sessionId: sessionId,
            mode: .history,
            beforeOrderSeq: beforeOrderSeq,
            limit: limit
        )
    }

    func setTakeover(sessionId: V2SessionID, enabled: Bool) async throws -> V2SessionTakeoverResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2SessionTakeoverResponse>(
            method: enabled ? .post : .delete, path: sessionPath(sessionId, suffix: "takeover")
        ))
    }

    func sync(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2RuntimeActionResponse>(
            method: .post, path: sessionPath(sessionId, suffix: "sync")
        ))
    }

    private func bulkAction(path: String, sessionIds: [V2SessionID]) async throws -> V2SessionBulkActionResponse {
        let request = HTTPRequest<[V2SessionID], V2SessionBulkActionResponse>(
            method: .post,
            path: path,
            body: sessionIds
        )
        return try await transport.send(request)
    }

    private func timeline(
        sessionId: V2SessionID,
        mode: V2TimelineMode,
        afterSeq: Int? = nil,
        beforeOrderSeq: Int? = nil,
        limit: Int
    ) async throws -> V2SessionTimelinePage {
        var queryItems = [
            URLQueryItem(name: "mode", value: mode.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let afterSeq {
            queryItems.append(URLQueryItem(name: "afterSeq", value: String(afterSeq)))
        }
        if let beforeOrderSeq {
            queryItems.append(URLQueryItem(name: "beforeOrderSeq", value: String(beforeOrderSeq)))
        }
        let request = HTTPRequest<EmptyRequestBody, V2SessionTimelinePage>(
            method: .get,
            path: sessionPath(sessionId, suffix: "timeline"),
            queryItems: queryItems
        )
        return try await transport.send(request)
    }

    private func sessionPath(_ sessionId: V2SessionID, suffix: String) -> String {
        "/sessions/\(sessionId.v2URLPathComponentEncoded)/\(suffix)"
    }
}
