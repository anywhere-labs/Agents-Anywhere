import Foundation

nonisolated enum OAuthLoginError: LocalizedError, Equatable {
    case cancelled, busy, presentationUnavailable, couldNotStart, invalidAuthorizeURL, invalidCallback, randomGenerationFailed, invalidToken
    case providerError(String)
    var errorDescription: String? {
        switch self {
        case .cancelled: "Sign in was cancelled. You can try again."
        case .busy: "A sign-in attempt is already in progress."
        case .presentationUnavailable: "Return to the app and try signing in again."
        case .couldNotStart: "The secure sign-in browser could not open. Please try again."
        case .invalidAuthorizeURL: "The sign-in URL is invalid. Check the server address."
        case .invalidCallback: "The sign-in callback is missing, expired or does not match this attempt. Please sign in again."
        case .invalidToken: "The server did not return a valid sign-in token. Please try again."
        case .randomGenerationFailed: "A secure sign-in request could not be created. Please try again."
        case .providerError(let message): "Sign in was not completed: \(message)"
        }
    }
}

nonisolated enum OAuthCallback {
    static func authorizationCode(_ url: URL, expectedState: String) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "agents-anywhere", parts.host == "oauth", parts.path == "/callback",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil else { throw OAuthLoginError.invalidCallback }
        let values = parts.queryItems ?? []
        func unique(_ name: String) throws -> String? {
            let matches = values.filter { $0.name == name }
            guard matches.count <= 1 else { throw OAuthLoginError.invalidCallback }
            return matches.first?.value
        }
        guard !expectedState.isEmpty, try unique("state") == expectedState else { throw OAuthLoginError.invalidCallback }
        let code = try unique("code"), error = try unique("error"), description = try unique("error_description")
        guard code == nil || error == nil else { throw OAuthLoginError.invalidCallback }
        if let error, !error.isEmpty {
            if error == "access_denied" { throw OAuthLoginError.cancelled }
            throw OAuthLoginError.providerError(description?.isEmpty == false ? description! : error)
        }
        guard let code, !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw OAuthLoginError.invalidCallback }
        return code
    }
}
