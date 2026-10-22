import SwiftUI

/// Compact-width shell: two tabs (sessions / more) instead of the drawer.
/// Selection stays in `appState.chatSelection` so switching between compact
/// and the regular split keeps the same session visible.
struct CompactChatShellView: View {
    @Environment(AppState.self) private var appState

    private enum CompactTab: Hashable { case sessions, more }
    @State private var tab: CompactTab = .sessions
    @State private var showsNewSession = false

    private var selection: ChatShellSelection {
        get { appState.chatSelection }
        nonmutating set { appState.chatSelection = newValue }
    }

    private var selectedSessionId: Binding<V2SessionID?> {
        // Popping the detail returns to the list root; `.newSession` is the
        // shell's neutral state (regular width shows the new-session page).
        Binding(
            get: { if case let .session(id) = selection { id } else { nil } },
            set: { selection = $0.map(ChatShellSelection.session) ?? .newSession }
        )
    }

    private var selectedDeviceId: Binding<V2ConnectorID?> {
        Binding(
            get: { if case let .device(id) = selection { id } else { nil } },
            set: { selection = $0.map(ChatShellSelection.device) ?? .newSession }
        )
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab(String(localized: "会话"), systemImage: "message", value: .sessions) {
                sessionsTab
            }
            Tab(String(localized: "更多"), systemImage: "ellipsis.circle", value: .more) {
                moreTab
            }
        }
        // Selection can change from places outside this shell (session
        // recovery, device management); follow it into the right tab.
        .onChange(of: selection) { _, next in
            switch next {
            case .session: tab = .sessions
            case .device: tab = .more
            case .newSession: break
            }
        }
    }

    private var sessionsTab: some View {
        NavigationStack {
            CompactSessionListView(
                appState: appState,
                selectedSessionId: selectedSessionId.wrappedValue,
                onOpenSession: openSession,
                onRenameSession: renameSession,
                onToggleSessionPinned: setSessionPinned,
                onArchiveSession: archiveSession
            )
            .navigationTitle(String(localized: "会话"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showsNewSession = true } label: {
                        AppSymbol("square.and.pencil")
                    }
                    .accessibilityLabel(String(localized: "New session"))
                }
            }
            .navigationDestination(item: selectedSessionId) { id in
                sessionDetail(id)
            }
            .sheet(isPresented: $showsNewSession) {
                newSessionSheet
            }
        }
    }

    private var moreTab: some View {
        NavigationStack {
            CompactMoreView(appState: appState, onOpenDevice: openDevice)
                .navigationTitle(String(localized: "更多"))
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(item: selectedDeviceId) { id in
                    deviceDetail(id)
                }
        }
    }

    @ViewBuilder
    private func sessionDetail(_ id: V2SessionID) -> some View {
        if let services = appState.nativeChatServices {
            let session = services.sessionRepository.session(id: id)
            let connectorID = session.metadata?.connectorId
                ?? appState.sessions.first { $0.id == id }?.connectorId
            SessionChatView(session: session, services: services,
                deviceName: appState.connectors.first { $0.id == connectorID }?.name,
                // No sidebar in this form; the leading menu button pops back
                // to the list instead of toggling a drawer.
                onMenu: { selection = .newSession })
                .equatable()
                .id(id)
        } else {
            connectingPlaceholder
        }
    }

    @ViewBuilder
    private func deviceDetail(_ connectorId: V2ConnectorID) -> some View {
        if let connector = appState.connectors.first(where: { $0.id == connectorId }),
           let clients = appState.nativeChatServices,
           let service = appState.deviceManagementService,
           let workspaceFilesService = appState.workspaceFilesService,
           let serverURL = appState.serverURL
        {
            DeviceManagementView(
                connector: connector,
                allSessions: appState.sessions,
                projects: appState.projects,
                agents: clients.agents(on: connectorId),
                dashboard: clients.dashboardRepository,
                service: service,
                workspaceFilesService: workspaceFilesService,
                serverURL: serverURL,
                onMenu: { selection = .newSession },
                onOpenSession: openSession,
                onNewSession: { path in
                    if let model = appState.nativeChatServices?.newSession {
                        model.focusDevice(connectorId, workspace: path)
                    }
                    showsNewSession = true
                },
                // Project rows route through the same draft focus as the
                // regular sidebar; a no-op would leave a dead button here.
                onNewProjectSession: startProjectSession,
                onConnectorUpdated: appState.updateConnector,
                onConnectorDeleted: removeConnector,
                onSessionsUpdated: appState.updateSessions,
                onSetSessionsArchived: appState.setSessionsArchived
            )
            .id(connectorId)
        } else {
            connectingPlaceholder
        }
    }

    private var connectingPlaceholder: some View {
        Color(.systemBackground)
            .overlay {
                Label(String(localized: "正在连接，首次同步后即可保留本地内容"), appSymbol: "network")
                    .font(.footnote).foregroundStyle(.secondary).padding(24)
            }
    }

    private var newSessionSheet: some View {
        NavigationStack {
            if let services = appState.nativeChatServices {
                NewSessionView(model: services.newSession, connectors: appState.connectors,
                    sessions: appState.sessions, repository: services.dashboardRepository,
                    dashboardLoading: appState.isDashboardLoading,
                    dashboardError: appState.connectorsError,
                    onMenu: { showsNewSession = false },
                    onOpenDevice: { id in
                        showsNewSession = false
                        openDevice(id)
                    },
                    onCreated: { session in
                        appState.updateSession(session)
                        showsNewSession = false
                        openSession(session.id)
                    },
                    onRefresh: { await appState.refreshDashboard(); return appState.connectors })
            } else {
                connectingPlaceholder
            }
        }
    }

    private func openDevice(_ id: V2ConnectorID) {
        selection = .device(id)
    }

    private func openSession(_ id: V2SessionID) {
        selection = .session(id)
    }

    private func startProjectSession(_ id: String) {
        guard let services = appState.nativeChatServices else { return }
        services.newSession.updateProjects(services.dashboardRepository.projects)
        guard services.newSession.selectProject(id) else { return }
        showsNewSession = true
    }

    private func removeConnector(_ id: V2ConnectorID) {
        appState.removeConnector(connectorId: id)
        selection = .newSession
    }

    private func renameSession(_ id: V2SessionID, title: String) {
        Task { _ = await appState.renameSession(sessionId: id, title: title) }
    }

    private func setSessionPinned(_ id: V2SessionID, pinned: Bool) {
        Task { _ = await appState.setSessionPinned(sessionId: id, pinned: pinned) }
    }

    private func archiveSession(_ id: V2SessionID) {
        Task {
            let shouldArchive = appState.sessions.first { $0.id == id }?.archived != true
            let changed = await appState.setSessionArchived(sessionId: id, archived: shouldArchive)
            if changed && shouldArchive, selectedSessionId.wrappedValue == id {
                selection = .newSession
            }
        }
    }
}

#Preview {
    CompactChatShellView()
        .environment(AppState())
        .preferredColorScheme(.dark)
}
