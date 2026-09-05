import Foundation

struct V2AvatarUpdateRequest: Encodable, Hashable {
    let avatar: String
}

struct V2PasswordChangeRequest: Encodable, Hashable {
    let newPassword: String
}

struct V2ProfileUpdateRequest: Encodable, Hashable {
    let displayName: String
}

struct V2EmailCodeRequest: Encodable, Hashable {
    let email: String
    let purpose = "bind"
}

struct V2EmailCodeResponse: Decodable {
    let expiresIn: Int
    let retryAfter: Int
}

struct V2EmailBindingRequest: Encodable, Hashable {
    let email: String
    let code: String?
}
