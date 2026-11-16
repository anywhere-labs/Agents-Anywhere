import Foundation

protocol V2RuntimeAPIProtocol {
    func state(sessionId: V2SessionID) async throws -> V2RuntimeStateResponse
    func capabilities(sessionId: V2SessionID) async throws -> V2RuntimeCapabilityResponse
    func modelCatalog(sessionId: V2SessionID) async throws -> V2ModelCatalogResponse
    func permissionCatalog(sessionId: V2SessionID) async throws -> V2PermissionCatalogResponse
    func updateSelections(sessionId: V2SessionID, request: V2RuntimeSelectionUpdateRequest) async throws -> V2RuntimeSelectionUpdateResponse
    func commands(sessionId: V2SessionID) async throws -> V2RuntimeCommandListResponse
    func executeCommand(sessionId: V2SessionID, request: V2RuntimeCommandExecuteRequest) async throws -> V2RuntimeCommandExecuteResponse
    func sendMessage(sessionId: V2SessionID, request: V2RuntimeMessageSendRequest) async throws -> V2RuntimeActionResponse
    func steer(sessionId: V2SessionID, request: V2RuntimeSteerRequest) async throws -> V2RuntimeActionResponse
    func interrupt(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse
    func notices(sessionId: V2SessionID) async throws -> V2RuntimeNoticeSnapshot
    func respondToNotice(sessionId: V2SessionID, noticeId: V2NoticeID, request: V2RuntimeNoticeRespondRequest) async throws -> V2RuntimeActionResponse
    func queue(sessionId: V2SessionID, action: V2SessionQueueAction) async throws -> V2SessionQueueState
}

/// A management call on the server-owned message queue; each returns the whole queue.
nonisolated enum V2SessionQueueAction: Hashable {
    case read
    case edit(messageId: String, content: String)
    case delete(messageId: String)
    case retry(messageId: String)
    case sendNow(messageId: String)
    case resume
    case clear
}

struct V2RuntimeAPI: V2RuntimeAPIProtocol {
    let transport: any HTTPTransport

    func state(sessionId: V2SessionID) async throws -> V2RuntimeStateResponse {
        try await get(sessionId: sessionId, suffix: "state")
    }

    func capabilities(sessionId: V2SessionID) async throws -> V2RuntimeCapabilityResponse {
        try await get(sessionId: sessionId, suffix: "capabilities")
    }

    func modelCatalog(sessionId: V2SessionID) async throws -> V2ModelCatalogResponse {
        try await get(sessionId: sessionId, suffix: "catalogs/model")
    }

    func permissionCatalog(sessionId: V2SessionID) async throws -> V2PermissionCatalogResponse {
        try await get(sessionId: sessionId, suffix: "catalogs/permission")
    }

    func updateSelections(
        sessionId: V2SessionID,
        request body: V2RuntimeSelectionUpdateRequest
    ) async throws -> V2RuntimeSelectionUpdateResponse {
        try await send(sessionId: sessionId, suffix: "selections", method: .patch, body: body)
    }

    func commands(sessionId: V2SessionID) async throws -> V2RuntimeCommandListResponse {
        try await get(sessionId: sessionId, suffix: "commands")
    }

    func executeCommand(
        sessionId: V2SessionID,
        request body: V2RuntimeCommandExecuteRequest
    ) async throws -> V2RuntimeCommandExecuteResponse {
        try await send(sessionId: sessionId, suffix: "commands", method: .post, body: body)
    }

    func sendMessage(
        sessionId: V2SessionID,
        request body: V2RuntimeMessageSendRequest
    ) async throws -> V2RuntimeActionResponse {
        try await send(sessionId: sessionId, suffix: "messages", method: .post, body: body)
    }

    func steer(sessionId: V2SessionID, request body: V2RuntimeSteerRequest) async throws -> V2RuntimeActionResponse {
        try await send(sessionId: sessionId, suffix: "steer", method: .post, body: body)
    }

    func interrupt(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse {
        let request = HTTPRequest<EmptyRequestBody, V2RuntimeActionResponse>(
            method: .post,
            path: runtimePath(sessionId, suffix: "interrupt")
        )
        return try await transport.send(request)
    }

    func notices(sessionId: V2SessionID) async throws -> V2RuntimeNoticeSnapshot {
        try await get(sessionId: sessionId, suffix: "notices")
    }

    func respondToNotice(
        sessionId: V2SessionID,
        noticeId: V2NoticeID,
        request body: V2RuntimeNoticeRespondRequest
    ) async throws -> V2RuntimeActionResponse {
        let suffix = "notices/\(noticeId.v2URLPathComponentEncoded)/respond"
        return try await send(sessionId: sessionId, suffix: suffix, method: .post, body: body)
    }

    func queue(sessionId: V2SessionID, action: V2SessionQueueAction) async throws -> V2SessionQueueState {
        func item(_ id: String) -> String { "queue/\(id.v2URLPathComponentEncoded)" }
        switch action {
        case .read: return try await get(sessionId: sessionId, suffix: "queue")
        case let .edit(id, content):
            return try await send(sessionId: sessionId, suffix: item(id), method: .patch, body: V2SessionQueueEditRequest(content: content))
        case let .delete(id): return try await bodiless(sessionId: sessionId, suffix: item(id), method: .delete)
        case let .retry(id): return try await bodiless(sessionId: sessionId, suffix: item(id) + "/retry", method: .post)
        case let .sendNow(id): return try await bodiless(sessionId: sessionId, suffix: item(id) + "/send-now", method: .post)
        case .resume: return try await bodiless(sessionId: sessionId, suffix: "queue/resume", method: .post)
        case .clear: return try await bodiless(sessionId: sessionId, suffix: "queue", method: .delete)
        }
    }

    private func bodiless<Response: Decodable>(sessionId: V2SessionID, suffix: String, method: HTTPMethod) async throws -> Response {
        try await transport.send(HTTPRequest<EmptyRequestBody, Response>(method: method, path: runtimePath(sessionId, suffix: suffix)))
    }

    private func get<Response: Decodable>(sessionId: V2SessionID, suffix: String) async throws -> Response {
        let request = HTTPRequest<EmptyRequestBody, Response>(
            method: .get,
            path: runtimePath(sessionId, suffix: suffix)
        )
        return try await transport.send(request)
    }

    private func send<Body: Encodable, Response: Decodable & Sendable>(
        sessionId: V2SessionID,
        suffix: String,
        method: HTTPMethod,
        body: Body
    ) async throws -> Response {
        let request = HTTPRequest<Body, Response>(
            method: method,
            path: runtimePath(sessionId, suffix: suffix),
            body: body
        )
        return try await transport.send(request)
    }

    private func runtimePath(_ sessionId: V2SessionID, suffix: String) -> String {
        "/sessions/\(sessionId.v2URLPathComponentEncoded)/runtime/\(suffix)"
    }
}
