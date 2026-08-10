import Foundation

struct V2AvatarUpdateRequest: Encodable, Hashable {
    let avatar: String
}

struct V2PasswordChangeRequest: Encodable, Hashable {
    let newPassword: String
}
