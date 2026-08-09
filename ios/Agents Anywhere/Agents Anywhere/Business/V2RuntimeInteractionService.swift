import Foundation

struct V2RuntimeInteractionService {
    let runtimeAPI: any V2RuntimeAPIProtocol

    func notices(sessionId: V2SessionID) async throws -> [V2RuntimeNotice] {
        try await runtimeAPI.notices(sessionId: sessionId).notices
    }

    func respond(
        sessionId: V2SessionID,
        noticeId: V2NoticeID,
        actionId: String,
        input: JSONValue?
    ) async throws -> V2RuntimeActionResponse {
        try await runtimeAPI.respondToNotice(
            sessionId: sessionId,
            noticeId: noticeId,
            request: V2RuntimeNoticeRespondRequest(actionId: actionId, input: input)
        )
    }

    func commands(sessionId: V2SessionID) async throws -> [V2RuntimeCommand] {
        try await runtimeAPI.commands(sessionId: sessionId).commands
    }

    func executeCommand(
        sessionId: V2SessionID,
        command: String,
        arguments: [String],
        raw: String?
    ) async throws -> V2RuntimeCommandExecuteResponse {
        try await runtimeAPI.executeCommand(
            sessionId: sessionId,
            request: V2RuntimeCommandExecuteRequest(command: command, args: arguments, raw: raw)
        )
    }

    func modelCatalog(sessionId: V2SessionID) async throws -> V2ModelCatalog {
        try await runtimeAPI.modelCatalog(sessionId: sessionId).catalog
    }

    func permissionCatalog(sessionId: V2SessionID) async throws -> V2PermissionCatalog {
        try await runtimeAPI.permissionCatalog(sessionId: sessionId).catalog
    }

    func capabilities(sessionId: V2SessionID) async throws -> V2RuntimeCapabilitySnapshot {
        try await runtimeAPI.capabilities(sessionId: sessionId).capabilitySet
    }
}
