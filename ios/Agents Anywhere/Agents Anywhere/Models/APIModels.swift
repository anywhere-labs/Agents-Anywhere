import Foundation

enum UserRole: String, Codable, Hashable {
    case admin
    case member
}

struct AuthConfig: Decodable {
    let needsBootstrap: Bool
    let emailVerificationRequired: Bool
    let registrationOpen: Bool
    let oauthRegistrationOpen: Bool
    let oauthEnabled: Bool
    let oauthProviderLabel: String?
    let setupTokenExpiresAt: String?
    let serverTime: String
}

struct AuthResponse: Codable, Hashable {
    let userId: String
    let email: String?
    let displayName: String
    let emailVerified: Bool
    let role: UserRole
    let accessToken: String
    let tokenType: String?
    let serverTime: String
}

struct OAuthTokenResponse: Decodable, Hashable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
    let scope: String
    let refreshToken: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
        case refreshToken = "refresh_token"
    }
}

struct AuthMe: Codable {
    let userId: String
    let email: String?
    let displayName: String
    let emailVerified: Bool
    let role: UserRole
    let disabled: Bool
    let avatar: String?
    let serverTime: String

    var accountLabel: String {
        displayName.isEmpty ? (email ?? String(localized: "Account")) : displayName
    }
}

struct HealthResponse: Decodable {
    let status: String
    let serverTime: String
}

struct MobileLoginPayload: Decodable, Hashable {
    let type: String
    let version: Int
    let webUrl: String
    let userId: String
    let loginToken: String
    let expiresAt: String
}

struct MobileLoginRequest: Encodable {
    let userId: String
    let loginToken: String
    let deviceName: String?
}

struct MobileLoginExchangeRequest: Encodable {
    let userId: String
    let loginToken: String
}

struct MobileLoginStatusRequest: Encodable {
    let loginToken: String
}

struct MobileLoginExchangeResponse: Decodable {
    let auth: AuthResponse
    let refreshToken: String
    let expiresAt: String
    let serverTime: String
}

struct MobileLoginStatusResponse: Decodable {
    let status: String
    let userId: String?
    let deviceName: String?
    let expiresAt: String?
    let requestedAt: String?
    let approvedAt: String?
    let serverTime: String
}

struct APIErrorResponse: Decodable {
    let detail: JSONValue

    var message: String {
        return detail.displayString
    }
}
