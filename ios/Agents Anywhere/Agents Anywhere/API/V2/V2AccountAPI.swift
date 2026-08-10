import Foundation

protocol V2AccountAPIProtocol {
    func profile() async throws -> AuthMe
    func updateAvatar(request: V2AvatarUpdateRequest) async throws -> AuthMe
    func clearAvatar() async throws -> AuthMe
    func changePassword(request: V2PasswordChangeRequest) async throws
}

struct V2AccountAPI: V2AccountAPIProtocol {
    let transport: any HTTPTransport

    func profile() async throws -> AuthMe {
        let request = HTTPRequest<EmptyRequestBody, AuthMe>(
            method: .get,
            path: "/auth/me"
        )
        return try await transport.send(request)
    }

    func updateAvatar(request body: V2AvatarUpdateRequest) async throws -> AuthMe {
        let request = HTTPRequest<V2AvatarUpdateRequest, AuthMe>(
            method: .put,
            path: "/auth/me/avatar",
            body: body
        )
        return try await transport.send(request)
    }

    func clearAvatar() async throws -> AuthMe {
        let request = HTTPRequest<EmptyRequestBody, AuthMe>(
            method: .delete,
            path: "/auth/me/avatar"
        )
        return try await transport.send(request)
    }

    func changePassword(request body: V2PasswordChangeRequest) async throws {
        let request = HTTPRequest<V2PasswordChangeRequest, EmptyResponse>(
            method: .post,
            path: "/auth/change-password",
            body: body
        )
        _ = try await transport.send(request)
    }
}
