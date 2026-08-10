import SwiftUI

struct ChatShellView: View {
    @State private var isSidebarOpen = false

    var body: some View {
        SidebarDrawer(
            isOpen: $isSidebarOpen,
            configuration: .chat
        ) { _ in
            EmptyView()
        } sidebar: { _ in
            EmptyView()
        } content: { safeAreaInsets in
            ChatShellPlaceholderView(
                safeAreaInsets: safeAreaInsets,
                onOpenSidebar: openSidebar
            )
        }
    }

    private func openSidebar() {
        isSidebarOpen = true
    }
}

private struct ChatShellPlaceholderView: View {
    let safeAreaInsets: EdgeInsets
    let onOpenSidebar: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(.systemBackground)
                .ignoresSafeArea()

            Button {
                onOpenSidebar()
            } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open sidebar")
            .padding(.top, safeAreaInsets.top + 8)
            .padding(.leading, max(safeAreaInsets.leading, 0) + 12)
        }
    }
}

#Preview {
    ChatShellView()
        .preferredColorScheme(.dark)
}
