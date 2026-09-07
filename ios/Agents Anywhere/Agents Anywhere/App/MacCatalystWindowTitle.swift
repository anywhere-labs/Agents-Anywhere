#if targetEnvironment(macCatalyst)
import SwiftUI
import UIKit

/// Keep the native window title in sync without adding another page toolbar.
struct MacCatalystWindowTitle: View {
    @ObservedObject var appState: AppState
    @Environment(\.locale) private var locale

    var body: some View {
        WindowTitleWriter(title: title)
            .frame(width: 0, height: 0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var title: String {
        guard appState.route == .signedIn else { return "Agents Anywhere" }

        let parts: [String?]
        switch appState.chatSelection {
        case .newSession:
            let draft = appState.nativeChatServices?.newSession
            parts = [String(localized: "New session", locale: locale), draft?.connector?.name]
        case .device:
            parts = [String(localized: "Device settings", locale: locale)]
        case let .session(id):
            let session = appState.nativeChatServices?.sessionRepository.session(id: id).metadata
                ?? appState.sessions.first { $0.id == id }
            let device = appState.connectors.first { $0.id == session?.connectorId }
            parts = [device?.name]
        }

        return parts.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct WindowTitleWriter: UIViewRepresentable {
    let title: String

    func makeUIView(context: Context) -> WindowTitleView {
        WindowTitleView()
    }

    func updateUIView(_ view: WindowTitleView, context: Context) {
        view.title = title
    }
}

private final class WindowTitleView: UIView {
    var title = "Agents Anywhere" {
        didSet { updateWindowTitle() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateWindowTitle()
    }

    private func updateWindowTitle() {
        // Target the scene containing this view, including after reattachment.
        guard let scene = window?.windowScene else { return }
        if scene.title != title { scene.title = title }
        scene.titlebar?.titleVisibility = .visible
    }
}
#endif
