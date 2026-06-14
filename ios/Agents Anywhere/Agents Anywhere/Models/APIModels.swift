import Foundation

enum UserRole: String, Codable, Hashable {
    case admin
    case member
}

struct AuthConfig: Decodable {
    let needsBootstrap: Bool
    let registrationOpen: Bool
    let oauthRegistrationOpen: Bool
    let oauthEnabled: Bool
    let oauthProviderLabel: String?
    let setupTokenExpiresAt: String?
    let serverTime: String
}

struct AuthResponse: Codable, Hashable {
    let userId: String
    let role: UserRole
    let accessToken: String
    let tokenType: String?
    let serverTime: String
}

struct AuthMe: Codable {
    let userId: String
    let role: UserRole
    let disabled: Bool
    let avatar: String?
    let serverTime: String
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

struct ConnectorListResponse: Decodable {
    let connectors: [ConnectorSummary]
    let serverTime: String
}

struct ConnectorSummary: Decodable, Identifiable, Hashable {
    let id: String
    let userId: String
    let name: String
    let status: String
    let lastSeenAt: String?
    let createdAt: String
    let updatedAt: String
}

struct SessionListResponse: Decodable {
    let sessions: [SessionSummary]
    let serverTime: String
}

struct SessionSummary: Decodable, Identifiable, Hashable {
    let id: String
    let connectorId: String
    let runtime: String
    let externalSessionId: String?
    let title: String?
    let cwd: String?
    let status: String
    let connectorStatus: String
    let takeover: Bool
    let archived: Bool
    let pinned: Bool
    let unread: Bool
    let lastActivityAt: String?
    let lastItemAt: String?
    let sortAt: String?
    let updatedSeq: Int
    let createdAt: String
    let updatedAt: String
}

struct APIErrorResponse: Decodable {
    let detail: String
}
