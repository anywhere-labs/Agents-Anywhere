import SwiftUI

struct ChatPageHeader: View {
    let title: String
    var subtitle: String?
    let controls: ChatControlMetrics
    let onMenu: () -> Void
    let onNewSession: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 12) {
                circle("line.3.horizontal.decrease", label: "打开侧栏", action: onMenu)
                VStack(spacing: 3) {
                    Text(title).font(.headline).lineLimit(1)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                .frame(maxWidth: .infinity)
                circle("square.and.pencil", label: "新建会话", action: onNewSession)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private func circle(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 20, weight: .medium))
                .frame(width: controls.diameter, height: controls.diameter)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .accessibilityLabel(label)
    }
}

/// The phone drawer provides a full-screen card and passes the original safe
/// area (including keyboard avoidance). The native iPad split already owns it.
struct ChatPageSafeArea: ViewModifier {
    let insets: EdgeInsets
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.sidebarDrawerPresentation) private var presentation
    func body(content: Content) -> some View {
        content
            .padding(presentation == .drawer ? insets : EdgeInsets())
            .background(Color(uiColor: .systemBackground))
            .tint(AppTheme.primaryControlBackground(colorScheme))
            .accentColor(AppTheme.primaryControlBackground(colorScheme))
    }
}
