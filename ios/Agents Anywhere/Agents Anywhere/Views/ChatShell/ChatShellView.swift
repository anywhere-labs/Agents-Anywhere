import SwiftUI

struct ChatShellView: View {
    @State private var isSidebarOpen = false
    @State private var selectedConversation: ChatMockConversation?

    var body: some View {
        SidebarDrawer(
            isOpen: $isSidebarOpen,
            configuration: .chat
        ) { _ in
            ChatSidebarHeaderView(onSearch: {})
        } sidebar: { safeAreaInsets in
            ChatSidebarView(
                safeAreaInsets: safeAreaInsets,
                selectedConversationID: selectedConversation?.id,
                onSelectConversation: selectConversation,
                onNewChat: startNewChat
            )
        } content: { safeAreaInsets in
            ChatSurfaceView(
                conversationTitle: selectedConversation?.title,
                safeAreaInsets: safeAreaInsets,
                onMenu: toggleSidebar,
                onNewChat: startNewChat
            )
        }
    }

    private func selectConversation(_ conversation: ChatMockConversation) {
        selectedConversation = conversation
        isSidebarOpen = false
    }

    private func startNewChat() {
        selectedConversation = nil
        isSidebarOpen = false
    }

    private func toggleSidebar() {
        isSidebarOpen.toggle()
    }
}

#Preview {
    ChatShellView()
        .preferredColorScheme(.dark)
}
