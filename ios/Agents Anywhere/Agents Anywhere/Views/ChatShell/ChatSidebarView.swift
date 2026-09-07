import SwiftUI

struct ChatSidebarView: View {
    @EnvironmentObject private var appState: AppState
    let safeAreaInsets: EdgeInsets
    let devices: [ChatSidebarDevice]
    let pinnedSessions: [ChatSidebarSession]
    let recentSessions: [ChatSidebarSession]
    let repository: V2DashboardRepository?
    let onNewProjectSession: (String) -> Void
    let onRestoreSession: (String) async -> Bool
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

    @State private var isShowingPairing = false
    @State private var showsArchives = false
    @AppStorage(ProjectSidebarPreferences.sessionListKey) private var showsSessionList = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ChatSidebarDeviceSection(
                    devices: devices,
                    selectedDeviceId: selectedDeviceId,
                    isLoading: isLoadingDevices,
                    onOpen: onOpenDevice,
                    onCopyId: onCopyDeviceId
                )
                ChatSidebarPairDeviceButton {
                    appState.nativeChatServices?.agentSetup.pairingFormPresented = true
                    isShowingPairing = true
                }

                if let setup = appState.nativeChatServices?.agentSetup {
                    ForEach(setup.requests) { request in
                        HStack {
                            if request.ready { AppSymbol("checkmark.circle") }
                            else if request.error == nil { ProgressView().controlSize(.small) }
                            VStack(alignment: .leading) {
                                Text(request.connector.name).font(.subheadline)
                                Text(request.ready ? String(localized: "设备已连接") : request.error ?? String(localized: "等待设备连接…"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Menu {
                                if request.ready { Button(String(localized: "配置 Agent")) { setup.configure(request.id) } }
                                if request.error != nil { Button(String(localized: "重试")) { setup.retry(request.id) } }
                                Button(request.ready ? String(localized: "稍后配置") : String(localized: "停止等待")) { setup.finish(request.id) }
                            } label: { AppSymbol("ellipsis").frame(width: 36, height: 36) }
                        }.padding(.horizontal, 10).padding(.vertical, 8)
                    }
                }

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

                if let repository {
                    if showsSessionList {
                        HStack {
                            Text("Recent").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                            Spacer()
                            ChatSidebarListMenu(showsSessionList: $showsSessionList,
                                onShowArchives: { showsArchives = true }) {}
                        }
                        .padding(.horizontal, 10).padding(.top, 16)
                        ChatSidebarSessionSection(
                            title: nil,
                            sessions: recentSessions,
                            selectedSessionId: selectedSessionId,
                            isLoading: isLoadingSessions,
                            emptyMessage: "No sessions yet",
                            onOpen: onOpenSession,
                            onRename: onRenameSession,
                            onTogglePinned: onToggleSessionPinned,
                            onArchive: onArchiveSession,
                            onCopyId: onCopySessionId
                        )
                        DashboardPageButton(repository: repository, scope: .init())
                    } else {
                        ChatSidebarProjects(repository: repository, showsSessionList: $showsSessionList,
                            selectedSessionID: selectedSessionId, onShowArchives: { showsArchives = true },
                            onNewSession: onNewProjectSession, onOpenSession: onOpenSession,
                            onRenameSession: onRenameSession, onPinSession: onToggleSessionPinned,
                            onArchiveSession: onArchiveSession, onCopySession: onCopySessionId)
                    }
                }

            }
            .padding(.leading, safeAreaInsets.leading + 14)
            .padding(.trailing, safeAreaInsets.trailing + 14)
            .padding(.top, 10)
            .padding(.bottom, safeAreaInsets.bottom + 82)
        }
        .refreshable { await repository?.refresh() }
        .scrollIndicators(.hidden)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .overlay(alignment: .bottom) {
            if let account {
                ChatSidebarBottomControls(
                    appState: appState,
                    account: account,
                    onNewSession: onNewSession
                )
                    .padding(.leading, safeAreaInsets.leading + 18)
                    .padding(.trailing, safeAreaInsets.trailing + 18)
                    .padding(.bottom, max(safeAreaInsets.bottom, 12))
            }
        }
        .sheet(isPresented: $showsArchives) {
            if let repository { ArchivedSessionsSheet(repository: repository, onOpen: onOpenSession, onRestore: onRestoreSession) }
        }
        .sheet(isPresented: $isShowingPairing, onDismiss: {
            appState.nativeChatServices?.agentSetup.pairingFormPresented = false
        }) {
            PairDeviceSheet()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct ChatSidebarListMenu<Filters: View>: View {
    @Binding var showsSessionList: Bool
    let onShowArchives: () -> Void
    @ViewBuilder var filters: () -> Filters

    var body: some View {
        Menu {
            Picker(String(localized: "侧栏显示"), selection: $showsSessionList) {
                Text(String(localized: "按项目")).tag(false)
                Text(String(localized: "全部会话")).tag(true)
            }
            filters()
            Divider()
            Button(String(localized: "归档会话"), systemImage: "archivebox", action: onShowArchives)
        } label: {
            Label(String(localized: "列表选项"), appSymbol: "ellipsis")
                .labelStyle(.iconOnly).frame(width: 44, height: 44)
        }
    }
}

struct ChatSidebarHeaderView: View {
    var body: some View {
        AAWordmark(fontSize: 24)
            .foregroundStyle(.primary)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct ChatSidebarPairDeviceButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(String(localized: "Pair device"), appSymbol: "plus")
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
    let title: LocalizedStringResource?
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
            if let title { ChatSidebarSectionLabel(title: title) }

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
    @Environment(\.colorScheme) private var colorScheme

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
            .background(isSelected ? AppTheme.sidebarSelectionFill(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onOpen) {
                Label(String(localized: "Open"), systemImage: "folder.fill")
            }
            Divider()
            Button(action: onCopyId) {
                Label(String(localized: "Copy device ID"), systemImage: "doc.on.doc")
            }
        }
    }
}

struct ChatSidebarSessionRow: View {
    @Environment(\.colorScheme) private var colorScheme

    let session: ChatSidebarSession
    let isSelected: Bool
    var inset = false
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
                Text(session.title ?? String(localized: "Untitled session"))
                    .font(.body).foregroundStyle(.primary)
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                ChatSidebarSessionIndicator(indicator: session.presentation.indicator)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Match Web's inset session rows while keeping the selection and
            // the touch target across the full sidebar width.
            .padding(.leading, inset ? 36 : 10)
            .padding(.trailing, 10)
            .frame(minHeight: 42)
            .background(isSelected ? AppTheme.sidebarSelectionFill(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onOpen) {
                Label(String(localized: "Open"), systemImage: "folder.fill")
            }
            Button(action: beginRename) {
                Label(String(localized: "Rename"), systemImage: "pencil")
            }.disabled(session.id.hasPrefix("local:"))
            Button(action: onTogglePinned) {
                if session.pinned {
                    Label(String(localized: "Unpin"), systemImage: "pin")
                } else {
                    Label(String(localized: "Pin"), systemImage: "pin")
                }
            }
            .disabled(session.id.hasPrefix("local:"))
            Button(action: onArchive) {
                Label(session.archived ? String(localized: "Restore") : String(localized: "Archive"), systemImage: "archivebox")
            }.disabled(session.id.hasPrefix("local:"))
            Divider()
            Button(action: onCopyId) {
                Label(String(localized: "Copy session ID"), systemImage: "doc.on.doc")
            }
        }
        .alert(String(localized: "Rename session"), isPresented: $isRenaming) {
            TextField(String(localized: "Session title"), text: $titleDraft)
            Button(String(localized: "Cancel"), role: .cancel) {}
            Button(String(localized: "Save"), action: submitRename)
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

struct ChatSidebarSessionIndicator: View {
    let indicator: SessionSidebarPresentation.Indicator
    var body: some View {
        switch indicator {
        case .waitingApproval:
            Text(String(localized: "等待批准")).font(.system(size: 11, weight: .medium))
                .foregroundStyle(.mint).padding(.horizontal, 8).padding(.vertical, 3)
                .background(.mint.opacity(0.16), in: .capsule)
                .fixedSize().accessibilityLabel(String(localized: "等待批准"))
        case .running:
            ProgressView().controlSize(.mini).tint(.primary)
                .frame(width: 14, height: 14).accessibilityLabel(String(localized: "运行中"))
        case .unread:
            Circle().fill(.green).frame(width: 8, height: 8).accessibilityLabel(String(localized: "未读"))
        case .none:
            EmptyView()
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

private struct ChatSidebarBottomControls: View {
    let appState: AppState
    let account: ChatSidebarAccount
    let onNewSession: () -> Void

    @State private var isShowingSettings = false

    var body: some View {
        HStack(spacing: 10) {
            AppGlassButton(
                String(localized: "New session"),
                systemImage: "square.and.pencil",
                style: .prominent,
                maxWidth: nil,
                action: onNewSession
            )

            Spacer(minLength: 12)

            Button {
                isShowingSettings = true
            } label: {
                ChatSidebarAvatar(account: account)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel(String(localized: "Account"))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $isShowingSettings) {
            AccountSettingsSheet(appState: appState)
        }
    }
}

private struct ChatSidebarAvatar: View {
    let account: ChatSidebarAccount

    var body: some View {
        AccountAvatarView(
            displayName: account.displayName,
            source: account.avatarSource,
            size: 38
        )
    }
}
