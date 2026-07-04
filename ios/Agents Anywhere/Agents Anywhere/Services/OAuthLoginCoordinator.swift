import AuthenticationServices
import Combine
import CryptoKit
import Foundation
import Security
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

@MainActor
final class OAuthLoginCoordinator: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    private let callbackScheme = "agents-anywhere"
    private let redirectURI = "agents-anywhere://oauth/callback"
    private let clientID = "agents-anywhere-mobile"
    private var session: ASWebAuthenticationSession?

    func authenticate(serverURL: URL) async throws -> OAuthTokenResponse {
        let pkce = PKCEPair()
        let state = PKCEPair.randomURLSafeString(byteCount: 24)
        let authURL = try mobileOAuthURL(serverURL: serverURL, pkce: pkce, state: state)
        let callbackURL = try await callbackURL(for: authURL)
        let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []
        if queryItems.first(where: { $0.name == "state" })?.value != state {
            throw OAuthLoginError.invalidCallback
        }
        guard let code = queryItems.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw OAuthLoginError.invalidCallback
        }
        return try await APIClient(serverURL: serverURL).oauthToken(code: code, codeVerifier: pkce.verifier)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #elseif canImport(AppKit)
        return NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }

    private func callbackURL(for authURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let authSession = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.session = nil
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: error ?? OAuthLoginError.cancelled)
                }
            }
            authSession.presentationContextProvider = self
            authSession.prefersEphemeralWebBrowserSession = false
            session = authSession
            if !authSession.start() {
                session = nil
                continuation.resume(throwing: OAuthLoginError.cancelled)
            }
        }
    }

    private func mobileOAuthURL(serverURL: URL, pkce: PKCEPair, state: String) throws -> URL {
        guard var components = URLComponents(
            url: URL(string: "/en", relativeTo: serverURL.normalizedServerURL())?.absoluteURL ?? serverURL,
            resolvingAgainstBaseURL: false,
        ) else {
            throw OAuthLoginError.invalidAuthorizeURL
        }
        let queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "scope", value: "profile"),
            URLQueryItem(name: "state", value: state),
        ]
        components.percentEncodedFragment = hashRouteFragment("mobile-oauth", queryItems: queryItems)
        guard let url = components.url else { throw OAuthLoginError.invalidAuthorizeURL }
        return url
    }
}

private func hashRouteFragment(_ route: String, queryItems: [URLQueryItem]) -> String {
    var fragmentComponents = URLComponents()
    fragmentComponents.queryItems = queryItems
    guard let query = fragmentComponents.percentEncodedQuery, !query.isEmpty else {
        return "/\(route)"
    }
    return "/\(route)?\(query)"
}

private enum OAuthLoginError: LocalizedError {
    case cancelled
    case invalidAuthorizeURL
    case invalidCallback

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Sign in was cancelled."
        case .invalidAuthorizeURL:
            return "The server returned an invalid sign-in URL."
        case .invalidCallback:
            return "The sign-in callback was invalid."
        }
    }
}

private struct PKCEPair {
    let verifier: String
    let challenge: String

    init() {
        verifier = Self.randomURLSafeString(byteCount: 32)
        let digest = SHA256.hash(data: Data(verifier.utf8))
        challenge = Data(digest).base64URLEncodedString()
    }

    static func randomURLSafeString(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedString()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
