import SwiftUI
#if DEBUG
import OSLog
#endif

extension View {
    /// Opt-in measurements; ordinary debug runs have no per-row observers.
    @ViewBuilder func traceChatLayout(_ name: @autoclosure () -> String,
                                     state: @autoclosure () -> String = "") -> some View {
#if DEBUG
        if ChatLayoutDiagnostics.isEnabled {
            modifier(ChatLayoutTrace(name: name(), state: state()))
        } else {
            self
        }
#else
        self
#endif
    }
}

#if DEBUG
enum ChatLayoutDiagnostics {
    static let isEnabled = ProcessInfo.processInfo.environment["AA_CHAT_LAYOUT_TRACE"] == "1"
}

private struct ChatLayoutTrace: ViewModifier {
    let name: String
    let state: String
    @Environment(\.sidebarDrawerIsTransitioning) private var transitioning
    @Environment(\.sidebarDrawerObscuresDetail) private var obscured
    private static let log = Logger(subsystem: "agents.anywhere", category: "drawer-layout")

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGSize.self, of: \.size) { previous, next in
                guard transitioning || obscured, previous.height > 0,
                      abs(next.height - previous.height) > 1 || abs(next.width - previous.width) > 1 else { return }
                Self.log.debug("Drawer component \(name, privacy: .public) [\(state, privacy: .public)]: size \(previous.width, privacy: .public)x\(previous.height, privacy: .public) -> \(next.width, privacy: .public)x\(next.height, privacy: .public)")
            }
            .onChange(of: state) { previous, next in
                guard transitioning || obscured else { return }
                Self.log.debug("Drawer component \(name, privacy: .public): state \(previous, privacy: .public) -> \(next, privacy: .public)")
            }
    }
}
#endif
