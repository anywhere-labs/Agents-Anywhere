import Foundation

nonisolated struct V2AvatarUpdateRequest: Encodable, Hashable {
    let avatar: String
}

nonisolated struct V2PasswordChangeRequest: Encodable, Hashable {
    let newPassword: String
}

nonisolated struct V2ProfileUpdateRequest: Encodable, Hashable {
    let displayName: String
}

nonisolated struct V2EmailCodeRequest: Encodable, Hashable {
    let email: String
    let purpose = "bind"
}

nonisolated struct V2EmailCodeResponse: Decodable {
    let expiresIn: Int
    let retryAfter: Int
}

nonisolated struct V2EmailBindingRequest: Encodable, Hashable {
    let email: String
    let code: String?
}
