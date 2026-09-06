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

/// A token refresh changes authentication for the next request without replacing
/// the account's repositories, drafts, pagination or active navigation state.
@MainActor final class MutableAuthTokenProvider: AuthTokenProvider {
    private var token: String?
    init(token: String) { self.token = token }
    func update(_ token: String?) { self.token = token }
    func accessToken() async throws -> String? { token }
}
