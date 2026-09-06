import SwiftUI
import UIKit

/// Native split views already own their safe area; the phone drawer supplies it.
struct DeviceManagementView: View {
    let connector: V2Connector
    let allSessions: [V2SessionMeta]
    let projects: [V2Project]
    let agents: DeviceAgentModel
    let dashboard: V2DashboardRepository
    let service: V2DeviceManagementService
    let workspaceFilesService: V2WorkspaceFilesService
    let serverURL: URL
    let safeAreaInsets: EdgeInsets
    let onMenu: () -> Void
    let onOpenSession: (V2SessionID) -> Void
    let onNewSession: (String?) -> Void
    let onNewProjectSession: (String) -> Void
    let onConnectorUpdated: (V2Connector) -> Void
    let onConnectorDeleted: (V2ConnectorID) -> Void
    let onSessionsUpdated: ([V2SessionMeta]) -> Void
    let onSetSessionsArchived: ([V2SessionID], Bool) async -> Bool

    @State private var model = DeviceManagementModel()
    @State private var tab = DeviceOverviewTab.projects
    @State private var toasts = ChatToastStore()
    @State private var headerHeight: CGFloat = 76
    @State private var isRenaming = false
    @State private var proposedName = ""
    @State private var confirmsRotation = false
    @State private var confirmsDeletion = false
    @State private var confirmsArchiveAll = false
    @State private var credential: V2ConnectorRevokeResponse?
    @State private var selectedWorkspace: V2DeviceWorkspace?
    @State private var createsProject = false
    @State private var editingProject: V2Project?
    @State private var pendingProject: V2Project?
    @State private var projectActionIsDeletion = false
    @State private var busy = false
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22
    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }
    private var deviceProjects: [V2Project] {
        projects.filter { $0.connectorId == connector.id }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            if $0.lastActivityAt != $1.lastActivityAt { return ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    private var canManage: Bool { dashboard.canWrite && !model.isDeviceActionRunning && !model.isArchiveActionRunning && !busy }
    private var canReadFiles: Bool { dashboard.canWrite && connector.status == .online }
    private var pageScopes: [V2SessionListScope] {
        switch model.sessionFilter {
        case .active: [.init(projectID: model.projectID)]
        case .archived: [.init(projectID: model.projectID, archived: true)]
        case .all: [.init(projectID: model.projectID), .init(projectID: model.projectID, archived: true)]
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                DeviceAgentSection(model: agents, showsConnectionNotice: false) { report($0, source: "agents") }
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Device content", selection: $tab) {
                        Text("Projects").tag(DeviceOverviewTab.projects)
                        Text("Sessions").tag(DeviceOverviewTab.sessions)
                    }.pickerStyle(.segmented).accessibilityIdentifier("device.content")
                    if tab == .projects {
                        DeviceProjectGrid(projects: deviceProjects, canManage: canManage, canReadFiles: canReadFiles,
                            onCreate: { createsProject = true }, onOpen: openProjectSessions,
                            onNewSession: { onNewProjectSession($0.id) }, onFiles: openProjectFiles,
                            onEdit: { editingProject = $0 },
                            onPin: { project in perform { try await dashboard.updateProject(project.id, pinned: !project.pinned) } },
                            onArchive: { pendingProject = $0; projectActionIsDeletion = false },
                            onDelete: { pendingProject = $0; projectActionIsDeletion = true })
                    } else {
                        DeviceSessionList(model: model, projects: deviceProjects, canManage: canManage,
                            isWorking: busy || model.isArchiveActionRunning, onNewSession: { onNewSession(nil) },
                            onOpen: selectSession,
                            onArchive: { performArchive([$0.id], archived: !$0.archived) },
                            onArchiveAll: { confirmsArchiveAll = true })
                        ForEach(pageScopes, id: \.self) { DashboardPageButton(repository: dashboard, scope: $0) }
                    }
                }
            }
            .padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 28)
            .frame(maxWidth: 1040).frame(maxWidth: .infinity, alignment: .center)
        }
        .scrollIndicators(.hidden).scrollEdgeEffectStyle(.soft, for: .all)
        .refreshable { await dashboard.refresh(); await agents.refresh() }
        .safeAreaInset(edge: .top, spacing: 0) {
            ChatPageHeader(title: connector.name, subtitle: connectionDescription, controls: controls, onMenu: onMenu) {
                Menu {
                    Button("New session", systemImage: "square.and.pencil") { onNewSession(nil) }
                    Button("Copy device ID", systemImage: "doc.on.doc") { UIPasteboard.general.string = connector.id }
                    Divider()
                    Button("Rename device", systemImage: "pencil") { proposedName = connector.name; isRenaming = true }.disabled(!canManage)
                    Button("Rotate credential", systemImage: "key") { confirmsRotation = true }.disabled(!canManage)
                    Button("Delete device", systemImage: "trash", role: .destructive) { confirmsDeletion = true }.disabled(!canManage)
                } label: {
                    ChatHeaderActionLabel(symbol: "ellipsis", controls: controls)
                        .glassEffect(.regular.interactive(), in: .circle)
                }.accessibilityLabel("Device actions")
            }.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if tab == .sessions && model.isSelectingSessions {
                DeviceSessionSelectionDock(count: model.selectedSessionIds.count,
                    restores: model.sessionFilter == .archived, isWorking: busy, disabled: !canManage,
                    onCancel: model.stopSelectingSessions,
                    onSubmit: { performArchive(Array(model.selectedSessionIds), archived: model.sessionFilter != .archived) })
            }
        }
        .overlay(alignment: .top) {
            ChatErrorToasts(store: toasts, isRetrying: dashboard.isLoading, onRetry: { _ in await dashboard.refresh() })
                .padding(.top, headerHeight)
        }
        .modifier(ChatPageSafeArea(insets: safeAreaInsets))
        .onChange(of: allSessions, initial: true) { _, values in model.updateSessions(connectorId: connector.id, allSessions: values) }
        .onChange(of: model.errorMessage, initial: true) { _, error in report(error, source: "device") }
        .onChange(of: dashboard.error, initial: true) { _, error in report(error, source: "sync") }
        .task(id: pageRequestKey) {
            guard tab == .sessions, dashboard.canWrite else { return }
            for scope in pageScopes where dashboard.pages[scope] == nil { await dashboard.loadPage(scope) }
        }
        .sheet(isPresented: $createsProject) { ProjectEditorSheet(repository: dashboard, connectorID: connector.id) }
        .sheet(item: $editingProject) { ProjectEditorSheet(repository: dashboard, project: $0) }
        .sheet(item: $selectedWorkspace) {
            WorkspaceFilesSheet(connectorId: connector.id, deviceName: connector.name, workspace: $0,
                service: workspaceFilesService, permitsReading: canReadFiles)
        }
        .sheet(item: $credential) { ConnectorCredentialSheet(connector: $0.connector, connectorToken: $0.connectorToken, serverURL: serverURL) }
        .alert("Rename device", isPresented: $isRenaming) {
            TextField("Device name", text: $proposedName)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await renameDevice() } }
                .disabled(proposedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canManage)
        }
        .alert("Rotate connector credential?", isPresented: $confirmsRotation) {
            Button("Cancel", role: .cancel) {}
            Button("Rotate credential", role: .destructive) { Task { await rotateCredential() } }
        } message: { Text("The current desktop Connector will disconnect. Replace its saved token with the new credential before reconnecting.") }
        .alert("Delete this device?", isPresented: $confirmsDeletion) {
            Button("Cancel", role: .cancel) {}
            Button("Delete device", role: .destructive) { Task { await deleteDevice() } }
        } message: { Text("The device and its server-owned metadata will be removed. This action cannot be undone.") }
        .alert(model.sessionFilter == .archived ? "Restore these sessions?" : "Archive these sessions?", isPresented: $confirmsArchiveAll) {
            Button("Cancel", role: .cancel) {}
            Button(model.sessionFilter == .archived ? "Restore" : "Archive") { archiveAll() }
        } message: { Text("This applies to all sessions in the selected scope, including those not loaded yet.") }
        .alert(projectActionIsDeletion ? "Delete project?" : "Archive project sessions?", isPresented: Binding(
            get: { pendingProject != nil }, set: { if !$0 { pendingProject = nil } })) {
            Button("Cancel", role: .cancel) { pendingProject = nil }
            Button(projectActionIsDeletion ? "Delete" : "Archive", role: .destructive) {
                guard let project = pendingProject else { return }; pendingProject = nil
                perform {
                    if projectActionIsDeletion { try await dashboard.deleteProject(project.id) }
                    else { try await dashboard.archiveProject(project.id, archived: true) }
                }
            }
        } message: {
            Text(projectActionIsDeletion ? "Only empty projects can be deleted. Files on the device are kept." :
                "Active sessions in this project will be archived. You can restore them later.")
        }
    }

    private var connectionDescription: String {
        let status = !dashboard.canWrite ? String(localized: "Showing cached content") :
            connector.status == .online ? String(localized: "Online") : String(localized: "Device offline")
        return [connector.deviceOs, status].compactMap { $0 }.joined(separator: " · ")
    }
    private var pageRequestKey: String { "\(tab):\(model.projectID ?? ""):\(model.sessionFilter):\(dashboard.canWrite)" }
    private func report(_ message: String?, source: String) {
        toasts.update(source: source, failure: message.map { .init(kind: .rejected, message: $0) })
    }
    private func openProjectSessions(_ project: V2Project) {
        model.selectProject(project.id); model.setSessionFilter(.active); tab = .sessions
    }
    private func openProjectFiles(_ project: V2Project) {
        selectedWorkspace = .init(path: project.workspacePath, name: project.name,
            sessionCount: project.activeSessionCount, lastActiveAt: project.lastActivityAt)
    }
    private func selectSession(_ id: String) {
        if model.isSelectingSessions { model.toggleSessionSelection(id) } else { onOpenSession(id) }
    }
    private func perform(_ operation: @escaping () async throws -> Void) {
        guard canManage else { return }; busy = true
        Task {
            defer { busy = false }
            do { try await operation(); report(nil, source: "action") }
            catch { report(error.localizedDescription, source: "action") }
        }
    }
    private func performArchive(_ ids: [String], archived: Bool) {
        guard !ids.isEmpty, canManage else { return }; busy = true
        Task {
            defer { busy = false }
            if await onSetSessionsArchived(ids, archived) { model.stopSelectingSessions() }
        }
    }
    private func archiveAll() {
        guard canManage else { return }
        if let id = model.projectID {
            let archived = model.sessionFilter != .archived
            perform { try await dashboard.archiveProject(id, archived: archived) }
        } else {
            Task {
                if let sessions = await model.archiveSessions(connectorId: connector.id,
                    archived: model.sessionFilter != .archived, service: service) { onSessionsUpdated(sessions) }
            }
        }
    }
    private func renameDevice() async {
        guard canManage else { return }
        if let updated = await model.renameConnector(connectorId: connector.id, name: proposedName, service: service) { onConnectorUpdated(updated) }
    }
    private func rotateCredential() async {
        guard canManage else { return }
        credential = await model.revokeConnector(connectorId: connector.id, service: service)
        if let credential { onConnectorUpdated(credential.connector) }
    }
    private func deleteDevice() async {
        guard canManage else { return }
        if await model.deleteConnector(connectorId: connector.id, service: service) { onConnectorDeleted(connector.id) }
    }
}
