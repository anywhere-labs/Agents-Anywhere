import SwiftUI

struct ChatPageHeader<Actions: View>: View {
    let title: String
    var subtitle: String?
    let controls: ChatControlMetrics
    let onMenu: () -> Void
    @ViewBuilder var actions: () -> Actions
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 12) {
                Button(action: onMenu) {
                    SidebarMenuIcon()
                        .foregroundStyle(AppTheme.primaryText(colorScheme))
                        .frame(width: controls.diameter, height: controls.diameter)
                        .glassEffect(.regular.interactive(), in: .circle)
                }.accessibilityLabel("打开侧栏")
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline).lineLimit(1)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                actions()
            }.buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 10)
    }
}

private struct SidebarMenuIcon: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4.5) {
            Capsule().frame(width: 21, height: 2)
            Capsule().frame(width: 21, height: 2)
            Capsule().frame(width: 13, height: 2)
        }.frame(width: 24, height: 24).accessibilityHidden(true)
    }
}

struct ChatHeaderActionLabel: View {
    let symbol: String
    let controls: ChatControlMetrics
    var body: some View {
        Image(systemName: symbol).font(.system(size: 19, weight: .regular))
            .frame(width: controls.diameter, height: controls.diameter).contentShape(Rectangle())
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
            // These pages supply their own safe-area header. Suppress the
            // NavigationSplitView column's otherwise empty navigation bar.
            .toolbar(.hidden, for: .navigationBar)
            .padding(presentation == .drawer ? insets : EdgeInsets())
            .background(Color(uiColor: .systemBackground))
            .tint(AppTheme.primaryControlBackground(colorScheme))
            .accentColor(AppTheme.primaryControlBackground(colorScheme))
    }
}
