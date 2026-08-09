import SwiftUI

struct ChatSidebarView: View {
    let safeAreaInsets: EdgeInsets
    let devices: [ChatSidebarDevice]
    let pinnedSessions: [ChatSidebarSession]
    let recentSessions: [ChatSidebarSession]
    let account: ChatSidebarAccount?
    let selectedDeviceId: V2ConnectorID?
    let selectedSessionId: V2SessionID?
    let isLoadingDevices: Bool
    let isLoadingSessions: Bool
    let onNewSession: () -> Void
    let onOpenDevice: (V2ConnectorID) -> Void
    let onOpenSession: (V2SessionID) -> Void
    let onRenameSession: (V2SessionID, String) -> Void
    let onToggleSessionPinned: (V2SessionID, Bool) -> Void
    let onArchiveSession: (V2SessionID) -> Void
    let onCopyDeviceId: (V2ConnectorID) -> Void
    let onCopySessionId: (V2SessionID) -> Void
    let onSignOut: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ChatSidebarNewSessionButton(action: onNewSession)
                    ChatSidebarDeviceSection(
                        devices: devices,
                        selectedDeviceId: selectedDeviceId,
                        isLoading: isLoadingDevices,
                        onOpen: onOpenDevice,
                        onCopyId: onCopyDeviceId
                    )

                    if !pinnedSessions.isEmpty {
                        ChatSidebarSessionSection(
                            title: "Pinned",
                            sessions: pinnedSessions,
                            selectedSessionId: selectedSessionId,
                            emptyMessage: "No pinned sessions",
                            onOpen: onOpenSession,
                            onRename: onRenameSession,
                            onTogglePinned: onToggleSessionPinned,
                            onArchive: onArchiveSession,
                            onCopyId: onCopySessionId
                        )
                    }

                    ChatSidebarSessionSection(
                        title: "Recent",
                        sessions: recentSessions,
                        selectedSessionId: selectedSessionId,
                        isLoading: isLoadingSessions,
                        emptyMessage: "No sessions match",
                        onOpen: onOpenSession,
                        onRename: onRenameSession,
                        onTogglePinned: onToggleSessionPinned,
                        onArchive: onArchiveSession,
                        onCopyId: onCopySessionId
                    )
                }
                .padding(.leading, safeAreaInsets.leading + 14)
                .padding(.trailing, safeAreaInsets.trailing + 14)
                .padding(.top, 10)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)

            if let account {
                ChatSidebarAccountButton(account: account, onSignOut: onSignOut)
                    .padding(.leading, safeAreaInsets.leading + 18)
                    .padding(.trailing, safeAreaInsets.trailing + 18)
                    .padding(.bottom, max(safeAreaInsets.bottom, 12))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct ChatSidebarHeaderView: View {
    @Binding var searchText: String
    @Binding var isSearching: Bool

    @FocusState private var isSearchFocused: Bool

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                AAWordmark(fontSize: 24)

                Spacer(minLength: 8)

                Button(action: toggleSearch) {
                    Image(systemName: isSearching ? "xmark" : "magnifyingglass")
                        .font(.body.weight(.semibold))
                        .frame(width: 38, height: 38)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel(isSearching ? "Close search" : "Search sessions")
            }

            if isSearching {
                TextField("Search session titles", text: $searchText)
                    .focused($isSearchFocused)
                    .textFieldStyle(.plain)
                    .submitLabel(.search)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 38)
                    .background(.primary.opacity(0.07), in: Capsule())
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .onChange(of: isSearching) { _, searching in
            isSearchFocused = searching
        }
    }

    private func toggleSearch() {
        withAnimation(.snappy(duration: 0.22)) {
            if isSearching {
                searchText = ""
                isSearching = false
            } else {
                isSearching = true
            }
        }
    }
}

private struct ChatSidebarNewSessionButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("New session", systemImage: "plus")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .frame(minHeight: 46)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct ChatSidebarDeviceSection: View {
    let devices: [ChatSidebarDevice]
    let selectedDeviceId: V2ConnectorID?
    let isLoading: Bool
    let onOpen: (V2ConnectorID) -> Void
    let onCopyId: (V2ConnectorID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ChatSidebarSectionLabel(title: "Devices")

            if isLoading {
                ChatSidebarLoadingRow(title: "Loading devices...")
            } else if devices.isEmpty {
                ChatSidebarEmptyRow(title: "No devices")
            } else {
                ForEach(devices) { device in
                    ChatSidebarDeviceRow(
                        device: device,
                        isSelected: selectedDeviceId == device.id,
                        onOpen: { onOpen(device.id) },
                        onCopyId: { onCopyId(device.id) }
                    )
                }
            }
        }
    }
}

private struct ChatSidebarSessionSection: View {
    let title: LocalizedStringResource
    let sessions: [ChatSidebarSession]
    let selectedSessionId: V2SessionID?
    var isLoading = false
    let emptyMessage: LocalizedStringResource
    let onOpen: (V2SessionID) -> Void
    let onRename: (V2SessionID, String) -> Void
    let onTogglePinned: (V2SessionID, Bool) -> Void
    let onArchive: (V2SessionID) -> Void
    let onCopyId: (V2SessionID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ChatSidebarSectionLabel(title: title)

            if isLoading {
                ChatSidebarLoadingRow(title: "Loading sessions...")
            } else if sessions.isEmpty {
                ChatSidebarEmptyRow(title: emptyMessage)
            } else {
                ForEach(sessions) { session in
                    ChatSidebarSessionRow(
                        session: session,
                        isSelected: selectedSessionId == session.id,
                        onOpen: { onOpen(session.id) },
                        onRename: { onRename(session.id, $0) },
                        onTogglePinned: { onTogglePinned(session.id, !session.pinned) },
                        onArchive: { onArchive(session.id) },
                        onCopyId: { onCopyId(session.id) }
                    )
                }
            }
        }
    }
}

private struct ChatSidebarSectionLabel: View {
    let title: LocalizedStringResource

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, 20)
            .padding(.bottom, 6)
    }
}

private struct ChatSidebarDeviceRow: View {
    let device: ChatSidebarDevice
    let isSelected: Bool
    let onOpen: () -> Void
    let onCopyId: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Circle()
                    .fill(device.presence == .online ? .green : .secondary.opacity(0.45))
                    .frame(width: 7, height: 7)

                Text(device.name)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(device.presence == .offline ? .secondary : .primary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .frame(minHeight: 42)
            .background(.primary.opacity(isSelected ? 0.08 : 0), in: RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onOpen) {
                Label("Open", systemImage: "folder")
            }
            Divider()
            Button(action: onCopyId) {
                Label("Copy device ID", systemImage: "doc.on.doc")
            }
        }
    }
}

private struct ChatSidebarSessionRow: View {
    let session: ChatSidebarSession
    let isSelected: Bool
    let onOpen: () -> Void
    let onRename: (String) -> Void
    let onTogglePinned: () -> Void
    let onArchive: () -> Void
    let onCopyId: () -> Void

    @State private var isRenaming = false
    @State private var titleDraft = ""

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                ChatSidebarSessionStatusDot(
                    status: session.status,
                    unread: session.unread
                )

                Text(session.title ?? String(localized: "Untitled session"))
                    .font(.body)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .frame(minHeight: 42)
            .background(.primary.opacity(isSelected ? 0.08 : 0), in: RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onOpen) {
                Label("Open", systemImage: "folder")
            }
            Button(action: beginRename) {
                Label("Rename", systemImage: "pencil")
            }
            Button(action: onTogglePinned) {
                if session.pinned {
                    Label("Unpin", systemImage: "pin.slash")
                } else {
                    Label("Pin", systemImage: "pin")
                }
            }
            Button(action: onArchive) {
                Label("Archive", systemImage: "archivebox")
            }
            Divider()
            Button(action: onCopyId) {
                Label("Copy session ID", systemImage: "doc.on.doc")
            }
        }
        .alert("Rename session", isPresented: $isRenaming) {
            TextField("Session title", text: $titleDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save", action: submitRename)
                .disabled(titleDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func beginRename() {
        titleDraft = session.title ?? ""
        isRenaming = true
    }

    private func submitRename() {
        let title = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        onRename(title)
    }
}

private struct ChatSidebarSessionStatusDot: View {
    let status: V2RuntimeStatus
    let unread: Bool

    var body: some View {
        Circle()
            .fill(fillColor)
            .overlay {
                Circle().stroke(borderColor, lineWidth: 1)
            }
            .frame(width: 7, height: 7)
    }

    private var fillColor: Color {
        if unread { return .primary }
        if status == .running { return .green }
        return .clear
    }

    private var borderColor: Color {
        if unread { return .primary }
        switch status {
        case .running:
            return .green
        case .blocked:
            return .orange.opacity(0.8)
        case .waiting, .pending, .stopping:
            return .blue.opacity(0.8)
        default:
            return .secondary.opacity(0.55)
        }
    }
}

private struct ChatSidebarLoadingRow: View {
    let title: LocalizedStringResource

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text(title)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .frame(minHeight: 38)
    }
}

private struct ChatSidebarEmptyRow: View {
    let title: LocalizedStringResource

    var body: some View {
        Text(title)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .frame(minHeight: 38)
    }
}

private struct ChatSidebarAccountButton: View {
    let account: ChatSidebarAccount
    let onSignOut: () -> Void

    @State private var isConfirmingSignOut = false

    var body: some View {
        Menu {
            Button(role: .destructive) {
                isConfirmingSignOut = true
            } label: {
                Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            ChatSidebarAvatar(account: account)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Account")
        .alert("Sign out?", isPresented: $isConfirmingSignOut) {
            Button("Cancel", role: .cancel) {}
            Button("Sign out", role: .destructive, action: onSignOut)
        } message: {
            Text("You will need to connect to the server again to continue.")
        }
    }
}

private struct ChatSidebarAvatar: View {
    let account: ChatSidebarAccount

    var body: some View {
        AsyncImage(url: account.avatarURL) { phase in
            if case let .success(image) = phase {
                image
                    .resizable()
                    .scaledToFill()
            } else {
                Text(account.initials)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.background)
            }
        }
        .frame(width: 42, height: 42)
        .background(.primary, in: Circle())
        .clipShape(Circle())
    }
}
