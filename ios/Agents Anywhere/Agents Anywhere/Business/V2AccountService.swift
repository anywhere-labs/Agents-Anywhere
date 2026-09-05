import Foundation

struct V2AccountService {
    let accountAPI: any V2AccountAPIProtocol

    func authConfig() async throws -> AuthConfig {
        try await accountAPI.authConfig()
    }

    func updateProfile(displayName: String) async throws -> AuthMe {
        try await accountAPI.updateProfile(request: V2ProfileUpdateRequest(
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
    }

    func sendEmailCode(email: String) async throws -> V2EmailCodeResponse {
        try await accountAPI.sendEmailCode(request: V2EmailCodeRequest(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
    }

    func bindEmail(email: String, code: String?) async throws -> AuthMe {
        try await accountAPI.bindEmail(request: V2EmailBindingRequest(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            code: code?.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
    }

    func profile() async throws -> AuthMe {
        try await accountAPI.profile()
    }

    /// Validates the avatar payload, then replaces the server-side account avatar.
    func updateAvatar(dataURL: String) async throws -> AuthMe {
        let normalizedDataURL = dataURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedDataURL.isEmpty else { throw V2BusinessError.emptyAvatar }
        return try await accountAPI.updateAvatar(
            request: V2AvatarUpdateRequest(avatar: normalizedDataURL)
        )
    }

    /// Removes the server-side account avatar.
    func clearAvatar() async throws -> AuthMe {
        try await accountAPI.clearAvatar()
    }

    /// Validates the new password, then updates it on the server.
    func changePassword(newPassword: String, confirmation: String) async throws {
        guard newPassword.count >= 8 else { throw V2BusinessError.passwordTooShort }
        guard newPassword == confirmation else { throw V2BusinessError.passwordMismatch }
        try await accountAPI.changePassword(
            request: V2PasswordChangeRequest(newPassword: newPassword)
        )
    }
}
