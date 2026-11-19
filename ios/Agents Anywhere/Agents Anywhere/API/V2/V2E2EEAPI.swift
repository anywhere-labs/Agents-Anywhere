import Foundation

nonisolated protocol V2E2EEAPIProtocol {
    func bootstrapContent() async throws -> EncryptedTunnelGrant

    /// `POST /api/v3/e2ee/commands`：加密命令在经通道发出前登记，Server 据此去重。
    func registerCommand(_ registration: E2EECommandRegistration) async throws -> E2EECommandRegistrationResponse
}

nonisolated extension V2E2EEAPIProtocol {
    func bootstrapContent() async throws -> EncryptedTunnelGrant {
        throw E2EEError(code: E2EEError.unsupported, message: "MeshCall bootstrap is unavailable")
    }
}

nonisolated struct V2E2EEAPI: V2E2EEAPIProtocol {
    let transport: any HTTPTransport

    func bootstrapContent() async throws -> EncryptedTunnelGrant {
        try await transport.send(HTTPRequest<EmptyRequestBody, EncryptedTunnelGrant>(
            method: .post, path: "/api/v3/mobile/control-tunnel", body: EmptyRequestBody()
        ))
    }

    func registerCommand(_ registration: E2EECommandRegistration) async throws -> E2EECommandRegistrationResponse {
        try await transport.send(HTTPRequest<E2EECommandRegistration, E2EECommandRegistrationResponse>(
            method: .post,
            path: "/api/v3/e2ee/commands",
            body: registration
        ))
    }
}
