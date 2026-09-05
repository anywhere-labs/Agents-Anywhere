import Foundation

protocol V2AccountAPIProtocol {
    func authConfig() async throws -> AuthConfig
    func updateProfile(request: V2ProfileUpdateRequest) async throws -> AuthMe
    func sendEmailCode(request: V2EmailCodeRequest) async throws -> V2EmailCodeResponse
    func bindEmail(request: V2EmailBindingRequest) async throws -> AuthMe
    func profile() async throws -> AuthMe
    func updateAvatar(request: V2AvatarUpdateRequest) async throws -> AuthMe
    func clearAvatar() async throws -> AuthMe
    func changePassword(request: V2PasswordChangeRequest) async throws
}

struct V2AccountAPI: V2AccountAPIProtocol {
    let transport: any HTTPTransport

    func authConfig() async throws -> AuthConfig {
        try await transport.send(HTTPRequest<EmptyRequestBody, AuthConfig>(
            method: .get,
            path: "/auth/config"
        ))
    }

    func updateProfile(request body: V2ProfileUpdateRequest) async throws -> AuthMe {
        try await transport.send(HTTPRequest<V2ProfileUpdateRequest, AuthMe>(
            method: .put,
            path: "/auth/me/profile",
            body: body
        ))
    }

    func sendEmailCode(request body: V2EmailCodeRequest) async throws -> V2EmailCodeResponse {
        try await transport.send(HTTPRequest<V2EmailCodeRequest, V2EmailCodeResponse>(
            method: .post,
            path: "/auth/email-code",
            body: body
        ))
    }

    func bindEmail(request body: V2EmailBindingRequest) async throws -> AuthMe {
        try await transport.send(HTTPRequest<V2EmailBindingRequest, AuthMe>(
            method: .put,
            path: "/auth/me/email",
            body: body
        ))
    }

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
