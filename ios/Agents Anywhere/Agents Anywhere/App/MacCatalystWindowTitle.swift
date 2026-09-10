#if targetEnvironment(macCatalyst)
import SwiftUI
import UIKit

/// Retain a useful title for the Window menu while hiding Catalyst's separate
/// title bar. Page controls continue to use their native navigation bars.
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

private struct WindowTitleWriter: UIViewControllerRepresentable {
    let title: String

    func makeUIViewController(context: Context) -> WindowTitleController {
        WindowTitleController()
    }

    func updateUIViewController(_ controller: WindowTitleController, context: Context) {
        controller.windowTitle = title
        controller.scheduleTitlebarUpdate()
    }
}

private final class WindowTitleController: UIViewController {
    var windowTitle = "Agents Anywhere"
    private var updateScheduled = false

    override func loadView() {
        view = UIView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        updateTitlebar()
        scheduleTitlebarUpdate()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scheduleTitlebarUpdate()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        scheduleTitlebarUpdate()
    }

    func scheduleTitlebarUpdate() {
        guard !updateScheduled else { return }
        updateScheduled = true
        // SwiftUI can configure the window toolbar after attaching its view.
        // Apply our policy after that transaction, including navigation changes
        // and resizing. Coalesce layout callbacks and only write changed values.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateScheduled = false
            self.updateTitlebar()
        }
    }

    private func updateTitlebar() {
        // Target only the containing window, never a sheet or another scene.
        guard let scene = viewIfLoaded?.window?.windowScene,
              let titlebar = scene.titlebar else { return }
        if scene.title != windowTitle { scene.title = windowTitle }
        if titlebar.toolbarStyle != .unifiedCompact { titlebar.toolbarStyle = .unifiedCompact }
        if titlebar.titleVisibility != .hidden { titlebar.titleVisibility = .hidden }
        if let toolbar = titlebar.toolbar {
            toolbar.isVisible = false
            titlebar.toolbar = nil
        }
        if titlebar.separatorStyle != .none { titlebar.separatorStyle = .none }
    }
}
#endif
