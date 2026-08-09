import Foundation

struct ChatSidebarAction: Identifiable {
    let id: String
    let title: LocalizedStringResource
    let systemImage: String
}

struct ChatMockConversation: Identifiable, Equatable {
    let id: String
    let title: String
}

enum ChatMockData {
    static let actions = [
        ChatSidebarAction(id: "new-chat", title: "New chat", systemImage: "square.and.pencil"),
        ChatSidebarAction(id: "devices", title: "Devices", systemImage: "desktopcomputer"),
        ChatSidebarAction(id: "agents", title: "Agents", systemImage: "command"),
        ChatSidebarAction(id: "files", title: "Files", systemImage: "folder"),
    ]

    static let conversations = [
        ChatMockConversation(id: "runtime-shell", title: "Runtime protocol shell"),
        ChatMockConversation(id: "ios-navigation", title: "iOS navigation redesign"),
        ChatMockConversation(id: "codex-sync", title: "Codex timeline sync"),
        ChatMockConversation(id: "approval-flow", title: "Approval interaction flow"),
        ChatMockConversation(id: "attachment-history", title: "Attachment history"),
        ChatMockConversation(id: "dashboard-realtime", title: "Dashboard realtime updates"),
        ChatMockConversation(id: "connector-architecture", title: "Connector architecture"),
        ChatMockConversation(id: "local-development", title: "Local development stack"),
    ]
}
