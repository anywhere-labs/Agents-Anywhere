import Foundation

protocol AuthTokenProvider: Sendable {
    func accessToken() async throws -> String?
}

struct StaticAuthTokenProvider: AuthTokenProvider {
    let token: String?

    func accessToken() async throws -> String? {
        token
    }
}
