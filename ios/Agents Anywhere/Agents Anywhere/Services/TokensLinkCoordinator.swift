import AuthenticationServices
import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

/// Runs the Tokens Anywhere authorization in a browser sheet. The flow never
/// calls back into the app; it ends on the Tokens "done" page. The page tells
/// this coordinator when a snapshot shows the link, and it closes the sheet.
@MainActor @Observable
final class TokensLinkCoordinator {
    private(set) var isActive = false
    @ObservationIgnored private var session: ASWebAuthenticationSession?
    @ObservationIgnored private var context: TokensLinkPresentationContext?
    @ObservationIgnored private var watch: TokensLinkWatch?
    @ObservationIgnored private var onFinish: (() -> Void)?
    @ObservationIgnored private var attempt: UUID?

    /// Returns false when the browser sheet could not be shown.
    @discardableResult
    func start(url: URL, current link: V2TokensLink?, onFinish: @escaping () -> Void) -> Bool {
        cancel()
        guard let anchor = Self.activeAnchor() else { return false }
        let context = TokensLinkPresentationContext(anchor: anchor)
        let attempt = UUID()
        // The app's own scheme: nothing redirects to it, so the sheet stays
        // open until the user closes it or the link shows up in a snapshot.
        let browser = ASWebAuthenticationSession(url: url, callbackURLScheme: "agents-anywhere") { [weak self] _, _ in
            Task { @MainActor in self?.closed(attempt) }
        }
        browser.presentationContextProvider = context
        browser.prefersEphemeralWebBrowserSession = false
        self.context = context; session = browser; self.attempt = attempt
        watch = TokensLinkWatch(current: link); self.onFinish = onFinish
        guard browser.start() else { cancel(); return false }
        isActive = true
        return true
    }

    /// Called with every snapshot's link while the sheet is open.
    func observe(_ link: V2TokensLink?) {
        guard isActive, let watch, watch.isFinished(by: link) else { return }
        let finish = onFinish
        cancel()
        finish?()
    }

    func cancel() {
        let previous = session
        session = nil; context = nil; watch = nil; onFinish = nil; attempt = nil; isActive = false
        previous?.cancel()
    }

    /// The user closed the sheet; a later attempt keeps its own state.
    private func closed(_ finished: UUID) {
        guard attempt == finished else { return }
        session = nil; context = nil; watch = nil; onFinish = nil; attempt = nil; isActive = false
    }

    private static func activeAnchor() -> ASPresentationAnchor? {
        #if canImport(UIKit)
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap(\.windows).first(where: \.isKeyWindow)
        #else
        return nil
        #endif
    }
}

@MainActor private final class TokensLinkPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    let anchor: ASPresentationAnchor
    init(anchor: ASPresentationAnchor) { self.anchor = anchor }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
}
