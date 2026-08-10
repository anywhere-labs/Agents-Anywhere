import SwiftUI
import UIKit

struct ChatShellView: View {
    @EnvironmentObject private var appState: AppState

    @State private var isSidebarOpen = false
    @State private var isSearching = false
    @State private var searchText = ""
    @State private var selection = ChatShellSelection.newSession

    var body: some View {
        SidebarDrawer(
            isOpen: $isSidebarOpen,
            configuration: .chat
        ) { _ in
            ChatSidebarHeaderView(
                searchText: $searchText,
                isSearching: $isSearching
            )
        } sidebar: { safeAreaInsets in
            ChatSidebarView(
                safeAreaInsets: safeAreaInsets,
                devices: sidebarDevices,
                pinnedSessions: matchingSessions.filter(\.pinned),
                recentSessions: matchingSessions.filter { !$0.pinned },
                account: sidebarAccount,
                selectedDeviceId: selectedDeviceId,
                selectedSessionId: selectedSessionId,
                isLoadingDevices: appState.isDashboardLoading && !appState.hasLoadedConnectors,
                isLoadingSessions: appState.isDashboardLoading && !appState.hasLoadedSessions,
                onNewSession: startNewSession,
                onOpenDevice: openDevice,
                onOpenSession: openSession,
                onRenameSession: renameSession,
                onToggleSessionPinned: setSessionPinned,
                onArchiveSession: archiveSession,
                onCopyDeviceId: copyDeviceId,
                onCopySessionId: copySessionId
            )
        } content: { _ in
            ChatShellPlaceholderPage(
                title: selectedContentTitle ?? "Agents Anywhere",
                onOpenSidebar: openSidebar
            )
        }
        .alert("Could not update session", isPresented: sessionActionErrorBinding) {
            Button("OK", role: .cancel) {
                appState.dismissSessionActionError()
            }
        } message: {
            Text(appState.sessionActionError ?? "")
        }
    }

    private var sidebarDevices: [ChatSidebarDevice] {
        appState.connectors.map { connector in
            ChatSidebarDevice(connector: connector)
        }
    }

    private var sidebarAccount: ChatSidebarAccount? {
        guard let me = appState.me else { return nil }
        return ChatSidebarAccount(me: me, avatarSource: appState.accountAvatarSource)
    }

    private var matchingSessions: [ChatSidebarSession] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return appState.sessions
            .filter { !$0.archived }
            .filter { session in
                query.isEmpty || session.title?.localizedStandardContains(query) == true
            }
            .map { session in
                ChatSidebarSession(session: session)
            }
    }

    private var selectedDeviceId: V2ConnectorID? {
        guard case let .device(id) = selection else { return nil }
        return id
    }

    private var selectedSessionId: V2SessionID? {
        guard case let .session(id) = selection else { return nil }
        return id
    }

    private var selectedContentTitle: String? {
        switch selection {
        case .newSession:
            return nil
        case let .device(id):
            return appState.connectors.first { $0.id == id }?.name
        case let .session(id):
            return appState.sessions.first { $0.id == id }?.title
        }
    }

    private var sessionActionErrorBinding: Binding<Bool> {
        Binding(
            get: { appState.sessionActionError != nil },
            set: { isPresented in
                if !isPresented {
                    appState.dismissSessionActionError()
                }
            }
        )
    }

    private func startNewSession() {
        selection = .newSession
        isSidebarOpen = false
    }

    private func openDevice(_ id: V2ConnectorID) {
        selection = .device(id)
        isSidebarOpen = false
    }

    private func openSession(_ id: V2SessionID) {
        selection = .session(id)
        isSidebarOpen = false
    }

    private func renameSession(_ id: V2SessionID, title: String) {
        Task {
            _ = await appState.renameSession(sessionId: id, title: title)
        }
    }

    private func setSessionPinned(_ id: V2SessionID, pinned: Bool) {
        Task {
            _ = await appState.setSessionPinned(sessionId: id, pinned: pinned)
        }
    }

    private func archiveSession(_ id: V2SessionID) {
        Task {
            let archived = await appState.setSessionArchived(sessionId: id, archived: true)
            if archived, selectedSessionId == id {
                selection = .newSession
            }
        }
    }

    private func copyDeviceId(_ id: V2ConnectorID) {
        UIPasteboard.general.string = id
    }

    private func copySessionId(_ id: V2SessionID) {
        UIPasteboard.general.string = id
    }

    private func openSidebar() {
        isSidebarOpen = true
    }
}

private struct ChatShellPlaceholderPage: View {
    let title: String
    let onOpenSidebar: () -> Void

    var body: some View {
        NavigationStack {
            Color(.systemBackground)
                .ignoresSafeArea()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(action: onOpenSidebar) {
                            Image(systemName: "sidebar.left")
                        }
                        .accessibilityLabel("Open sidebar")
                    }
                }
        }
    }
}

#Preview {
    ChatShellView()
        .environmentObject(AppState())
        .preferredColorScheme(.dark)
}
