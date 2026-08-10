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

    private func get<Response: Decodable>(sessionId: V2SessionID, suffix: String) async throws -> Response {
        let request = HTTPRequest<EmptyRequestBody, Response>(
            method: .get,
            path: runtimePath(sessionId, suffix: suffix)
        )
        return try await transport.send(request)
    }

    private func send<Body: Encodable, Response: Decodable>(
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
