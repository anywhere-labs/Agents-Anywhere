import Foundation

/// Model profiles, their assignments to runtimes, and the Tokens Anywhere link.
/// Keys go in and never come back.
struct V2ModelConfigAPI {
    let transport: any HTTPTransport

    func createProfile(_ request: V2ModelProfileCreateRequest) async throws -> V2ModelProfile {
        try await transport.send(HTTPRequest<V2ModelProfileCreateRequest, V2ModelProfile>(
            method: .post, path: "/model-profiles", body: request))
    }

    func deleteProfile(id: String) async throws {
        _ = try await transport.send(HTTPRequest<EmptyRequestBody, EmptyResponse>(
            method: .delete, path: "/model-profiles/\(id.v2URLPathComponentEncoded)"))
    }

    func preview(profileId: String) async throws -> V2ModelPreviewResponse {
        try await transport.send(HTTPRequest<V2ModelPreviewRequest, V2ModelPreviewResponse>(
            method: .post, path: "/model-config/assignments/preview", body: .init(profileId: profileId)))
    }

    /// One key per apply sheet: a retried request with the same key returns the
    /// first result instead of writing the connection again.
    func apply(_ request: V2ModelApplyRequest, idempotencyKey: String) async throws -> V2ModelOperation {
        try await transport.send(HTTPRequest<V2ModelApplyRequest, V2ModelOperation>(
            method: .post, path: "/model-config/assignments", body: request,
            headers: ["Idempotency-Key": idempotencyKey]))
    }

    func restore(_ target: V2ModelTarget, allowInterrupt: Bool) async throws -> V2ModelOperationResult {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2ModelOperationResult>(
            method: .delete,
            path: "/model-config/assignments/\(target.connectorId.v2URLPathComponentEncoded)/\(target.runtimeId.v2URLPathComponentEncoded)",
            queryItems: [URLQueryItem(name: "allow_interrupt", value: allowInterrupt ? "true" : "false")]))
    }

    /// A one-time address to open in a browser that authorizes the link.
    func beginTokensLink() async throws -> V2TokensLinkStart {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2TokensLinkStart>(
            method: .post, path: "/integrations/tokens/link"))
    }

    /// Runtimes a one-click Tokens Anywhere setup would configure, with reasons for the rest.
    func quickSetupCandidates() async throws -> V2QuickSetupCandidatesResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2QuickSetupCandidatesResponse>(
            method: .get, path: "/integrations/tokens/quick-setup"))
    }

    /// Starts the setup; when the account must link first, returns the address to open.
    func startQuickSetup(_ request: V2QuickSetupRequest) async throws -> V2QuickSetupStartResponse {
        try await transport.send(HTTPRequest<V2QuickSetupRequest, V2QuickSetupStartResponse>(
            method: .post, path: "/integrations/tokens/quick-setup", body: request))
    }

    func syncTokens() async throws -> V2ModelProfile {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2ModelProfile>(
            method: .post, path: "/integrations/tokens/sync"))
    }

    func unlinkTokens(allowInterrupt: Bool) async throws -> V2TokensUnlinkResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2TokensUnlinkResponse>(
            method: .delete, path: "/integrations/tokens/link",
            queryItems: [URLQueryItem(name: "allow_interrupt", value: allowInterrupt ? "true" : "false")]))
    }

    func rotateTokensKey(profileId: String, allowInterrupt: Bool, idempotencyKey: String) async throws -> V2ModelOperation {
        try await transport.send(HTTPRequest<V2AllowInterruptRequest, V2ModelOperation>(
            method: .post, path: "/model-profiles/\(profileId.v2URLPathComponentEncoded)/rotate-key",
            body: .init(allowInterrupt: allowInterrupt), headers: ["Idempotency-Key": idempotencyKey]))
    }
}
