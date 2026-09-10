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
final class OAuthLoginCoordinator: NSObject, ObservableObject {
    private let callbackScheme = "agents-anywhere"
    private let redirectURI = "agents-anywhere://oauth/callback"
    private let clientID = "agents-anywhere-mobile"
    private var session: ASWebAuthenticationSession?
    private var attemptID: UUID?
    private var callback: AsyncResultGate<URL>?
    private var context: OAuthPresentationContext?

    func authenticate(serverURL: URL) async throws -> OAuthTokenResponse {
        guard attemptID == nil else { throw OAuthLoginError.busy }
        try Task.checkCancellation()
        guard let window = activeAnchor() else { throw OAuthLoginError.presentationUnavailable }
        let attempt = UUID()
        attemptID = attempt; context = OAuthPresentationContext(anchor: window)
        defer { if attemptID == attempt { cancel() } }
        let pkce = try PKCEPair()
        let state = try PKCEPair.randomURLSafeString(byteCount: 24)
        let authURL = try mobileOAuthURL(serverURL: serverURL, pkce: pkce, state: state)
        let callbackURL = try await callbackURL(for: authURL, attempt: attempt)
        try Task.checkCancellation()
        let code = try OAuthCallback.authorizationCode(callbackURL, expectedState: state)
        let token = try await APIClient(serverURL: serverURL).oauthToken(code: code, codeVerifier: pkce.verifier)
        try Task.checkCancellation()
        guard !token.accessToken.isEmpty else { throw OAuthLoginError.invalidToken }
        return token
    }

    func cancel() {
        callback?.resolve(.failure(CancellationError()))
        callback = nil
        let previous = session; session = nil; attemptID = nil; context = nil
        previous?.cancel()
    }

    private func activeAnchor() -> ASPresentationAnchor? {
        #if canImport(UIKit)
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap(\.windows).first(where: \.isKeyWindow)
        #elseif canImport(AppKit)
        return NSApplication.shared.keyWindow
        #else
        return nil
        #endif
    }

    private func callbackURL(for url: URL, attempt: UUID) async throws -> URL {
        let result = AsyncResultGate<URL>()
        callback = result
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                result.install(continuation)
                guard !Task.isCancelled else { result.resolve(.failure(CancellationError())); return }
                let browser = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] url, error in
                    Task { @MainActor in
                        if self?.attemptID == attempt { self?.session = nil }
                    }
                    if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                        result.resolve(.failure(OAuthLoginError.cancelled))
                    } else if let error { result.resolve(.failure(error)) }
                    else if let url { result.resolve(.success(url)) }
                    else { result.resolve(.failure(OAuthLoginError.invalidCallback)) }
                }
                browser.presentationContextProvider = context
                browser.prefersEphemeralWebBrowserSession = false
                session = browser
                if !browser.start() {
                    session = nil; result.resolve(.failure(OAuthLoginError.couldNotStart))
                }
            }
        } onCancel: { result.resolve(.failure(CancellationError())) }
    }

    private func mobileOAuthURL(serverURL: URL, pkce: PKCEPair, state: String) throws -> URL {
        guard var components = URLComponents(
            url: URL(string: "/", relativeTo: serverURL.normalizedServerURL())?.absoluteURL ?? serverURL,
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

/// Retain the actual foreground window for this attempt. There is no fallback
/// window to manufacture if the user leaves the screen during authentication.
@MainActor private final class OAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    let anchor: ASPresentationAnchor
    init(anchor: ASPresentationAnchor) { self.anchor = anchor }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
}

private func hashRouteFragment(_ route: String, queryItems: [URLQueryItem]) -> String {
    var fragmentComponents = URLComponents()
    fragmentComponents.queryItems = queryItems
    guard let query = fragmentComponents.percentEncodedQuery, !query.isEmpty else {
        return "/\(route)"
    }
    return "/\(route)?\(query)"
}

private struct PKCEPair {
    let verifier: String
    let challenge: String

    init() throws {
        verifier = try Self.randomURLSafeString(byteCount: 32)
        let digest = SHA256.hash(data: Data(verifier.utf8))
        challenge = Data(digest).base64URLEncodedString()
    }

    static func randomURLSafeString(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw OAuthLoginError.randomGenerationFailed }
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
