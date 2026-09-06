import SwiftUI
import UIKit

struct ChatShellView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var sidebar = ChatSidebarState()
    private var selection: ChatShellSelection {
        get { appState.chatSelection }
        nonmutating set { appState.chatSelection = newValue }
    }

    var body: some View {
        SidebarDrawer(
            isOpen: $sidebar.isOpen,
            configuration: .chat
        ) { _ in
            ChatSidebarHeaderView()
        } sidebar: { safeAreaInsets in
            ChatSidebarView(
                safeAreaInsets: safeAreaInsets,
                devices: sidebarDevices,
                pinnedSessions: sidebarSessions.filter(\.pinned),
                recentSessions: sidebarSessions.filter { !$0.pinned },
                repository: appState.nativeChatServices?.dashboardRepository,
                onNewProjectSession: startProjectSession,
                onRestoreSession: { await appState.setSessionArchived(sessionId: $0, archived: false) },
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
        } content: { safeAreaInsets in
            mainContent(safeAreaInsets: safeAreaInsets)
        }
        .alert("Could not update session", isPresented: sessionActionErrorBinding) {
            Button("OK", role: .cancel) {
                appState.dismissSessionActionError()
            }
        } message: {
            Text(appState.sessionActionError ?? "")
        }
        .sheet(item: agentSetupBinding) { connector in
            if let services = appState.nativeChatServices {
                AgentSetupSheet(connector: connector, model: services.agents(on: connector.id)) {
                    services.agentSetup.finish(connector.id)
                    Task { await appState.refreshDashboard() }
                }
            }
        }
        .onChange(of: visibleSessionID, initial: true) { _, id in
            appState.setVisibleSession(id)
        }
        .onChange(of: sidebarLayout, initial: true) { _, layout in sidebar.setLayout(layout) }
        .onDisappear { appState.setVisibleSession(nil) }
    }

    private var agentSetupBinding: Binding<V2Connector?> {
        Binding(get: { appState.nativeChatServices?.agentSetup.presentedConnector }, set: { value in
            if value == nil, let setup = appState.nativeChatServices?.agentSetup, let connector = setup.presentedConnector {
                setup.finish(connector.id)
            }
        })
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

    private var sidebarSessions: [ChatSidebarSession] {
        appState.sessions
            .filter { !$0.archived }
            .map { session in
                ChatSidebarSession(session: session)
            }
            .sorted { $0.presentation.precedes($1.presentation, id: $0.id, otherID: $1.id) }
    }

    private var visibleSessionID: V2SessionID? {
        scenePhase == .active && !sidebar.obscuresDetail ? selectedSessionId : nil
    }

    private var sidebarLayout: ChatSidebarState.Layout {
        guard UIDevice.current.userInterfaceIdiom == .pad else { return .drawer }
        return horizontalSizeClass == .compact ? .compactSplit : .regularSplit
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

    @ViewBuilder
    private func mainContent(safeAreaInsets: EdgeInsets) -> some View {
        if case let .device(connectorId) = selection,
           let connector = appState.connectors.first(where: { $0.id == connectorId }),
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
                safeAreaInsets: safeAreaInsets,
                onMenu: toggleSidebar,
                onOpenSession: openSession,
                onNewSession: { path in
                    if let model = appState.nativeChatServices?.newSession {
                        model.focusDevice(connectorId, workspace: path)
                    }
                    startNewSession()
                },
                onConnectorUpdated: appState.updateConnector,
                onConnectorDeleted: removeConnector,
                onSessionsUpdated: appState.updateSessions,
                onSetSessionsArchived: appState.setSessionsArchived
            )
        } else if let services = appState.nativeChatServices {
            if case let .session(id) = selection {
                let session = services.sessionRepository.session(id: id)
                let connectorID = session.metadata?.connectorId ?? appState.sessions.first { $0.id == id }?.connectorId
                SessionChatView(session: session, services: services,
                    deviceName: appState.connectors.first { $0.id == connectorID }?.name,
                    safeAreaInsets: safeAreaInsets, onMenu: toggleSidebar)
                    .equatable()
                    .id(id)
            } else {
                NewSessionView(model: services.newSession, connectors: appState.connectors, sessions: appState.sessions, repository: services.dashboardRepository,
                    safeAreaInsets: safeAreaInsets, dashboardLoading: appState.isDashboardLoading,
                    dashboardError: appState.connectorsError,
                    onMenu: toggleSidebar, onManageDevice: openDevice,
                    onCreated: { session in
                        appState.updateSession(session)
                        if case .newSession = selection { openSession(session.id) }
                    },
                    onRefresh: { await appState.refreshDashboard(); return appState.connectors })
                    .equatable()
            }
        } else {
            ChatShellPlaceholderPage(
                isConnecting: appState.isRetryingServerConnection,
                title: selectedContentTitle ?? "Agents Anywhere",
                onOpenSidebar: openSidebar
            )
        }
    }

    private func startProjectSession(_ id: String) {
        guard let services = appState.nativeChatServices else { return }
        services.newSession.updateProjects(services.dashboardRepository.projects)
        guard services.newSession.selectProject(id) else { return }
        startNewSession()
    }

    private func startNewSession() {
        selection = .newSession
        sidebar.selectDestination()
    }

    private func openDevice(_ id: V2ConnectorID) {
        selection = .device(id)
        sidebar.selectDestination()
    }

    private func openSession(_ id: V2SessionID) {
        selection = .session(id)
        sidebar.selectDestination()
    }

    private func removeConnector(_ id: V2ConnectorID) {
        appState.removeConnector(connectorId: id)
        selection = .newSession
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
            let shouldArchive = appState.sessions.first { $0.id == id }?.archived != true
            let changed = await appState.setSessionArchived(sessionId: id, archived: shouldArchive)
            if changed && shouldArchive, selectedSessionId == id {
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

    private func toggleSidebar() {
        sidebar.isOpen.toggle()
    }

    private func openSidebar() {
        sidebar.isOpen = true
    }
}

private struct ChatShellPlaceholderPage: View {
    let isConnecting: Bool
    let title: String
    let onOpenSidebar: () -> Void

    var body: some View {
        NavigationStack {
            Color(.systemBackground)
                .ignoresSafeArea()
                .overlay {
                    if isConnecting {
                        Label("正在连接，首次同步后即可保留本地内容", systemImage: "network")
                            .font(.footnote).foregroundStyle(.secondary).padding(24)
                    }
                }
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
