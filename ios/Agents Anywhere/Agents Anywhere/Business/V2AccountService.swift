import Foundation

struct V2AccountService {
    let accountAPI: any V2AccountAPIProtocol

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
