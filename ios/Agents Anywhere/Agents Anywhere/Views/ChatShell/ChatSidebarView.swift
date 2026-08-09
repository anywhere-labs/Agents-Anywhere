import SwiftUI

struct ChatSidebarView: View {
    let width: CGFloat
    let safeAreaInsets: EdgeInsets
    let selectedConversationID: String?
    let onSelectConversation: (ChatMockConversation) -> Void
    let onNewChat: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ChatSidebarHeader(onSearch: {})
                .padding(.top, safeAreaInsets.top + 12)
                .padding(.leading, safeAreaInsets.leading + 22)
                .padding(.trailing, safeAreaInsets.trailing + 22)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ChatSidebarActions(onNewChat: onNewChat)
                    ChatSidebarRecents(
                        conversations: ChatMockData.conversations,
                        selectedConversationID: selectedConversationID,
                        onSelectConversation: onSelectConversation,
                    )
                }
                .padding(.leading, safeAreaInsets.leading + 14)
                .padding(.trailing, safeAreaInsets.trailing + 14)
                .padding(.top, 18)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)

            ChatSidebarAccount()
                .padding(.leading, safeAreaInsets.leading + 18)
                .padding(.trailing, safeAreaInsets.trailing + 18)
                .padding(.bottom, max(safeAreaInsets.bottom, 12))
        }
        .frame(width: width, alignment: .leading)
    }
}

private struct ChatSidebarHeader: View {
    let onSearch: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            AAWordmark(fontSize: 34)

            Spacer(minLength: 12)

            Button(action: onSearch) {
                Image(systemName: "magnifyingglass")
                    .font(.title3.weight(.semibold))
                    .frame(width: 46, height: 46)
                    .background(.thinMaterial, in: Circle())
                    .overlay {
                        Circle()
                            .strokeBorder(.primary.opacity(0.12), lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")
        }
    }
}

private struct ChatSidebarActions: View {
    let onNewChat: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            ForEach(ChatMockData.actions) { action in
                Button {
                    if action.id == "new-chat" {
                        onNewChat()
                    }
                } label: {
                    Label {
                        Text(action.title)
                    } icon: {
                        Image(systemName: action.systemImage)
                            .font(.body.weight(.medium))
                            .frame(width: 28)
                    }
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct ChatSidebarRecents: View {
    let conversations: [ChatMockConversation]
    let selectedConversationID: String?
    let onSelectConversation: (ChatMockConversation) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recent", comment: "Heading above recent conversations in the sidebar.")
                .font(.headline)
                .padding(.horizontal, 10)
                .padding(.top, 24)
                .padding(.bottom, 8)

            ForEach(conversations) { conversation in
                Button {
                    onSelectConversation(conversation)
                } label: {
                    Text(conversation.title)
                        .font(.body)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 44)
                        .background(
                            .primary.opacity(selectedConversationID == conversation.id ? 0.08 : 0),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous),
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct ChatSidebarAccount: View {
    var body: some View {
        HStack(spacing: 12) {
            Text(verbatim: "AA")
                .font(.subheadline.weight(.semibold))
                .frame(width: 40, height: 40)
                .foregroundStyle(.white)
                .background(Color.green, in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "Agents Anywhere")
                    .font(.subheadline.weight(.semibold))
                Text("Local workspace", comment: "Subtitle for the mock local account in the sidebar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Image(systemName: "ellipsis")
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 58)
    }
}
