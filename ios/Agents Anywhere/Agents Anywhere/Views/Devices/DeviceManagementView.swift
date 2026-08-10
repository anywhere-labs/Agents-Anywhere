import SwiftUI
import UIKit

struct DeviceManagementView: View {
    let connector: V2Connector
    let allSessions: [V2SessionMeta]
    let service: V2DeviceManagementService
    let workspaceFilesService: V2WorkspaceFilesService
    let serverURL: URL
    let safeAreaInsets: EdgeInsets
    let onMenu: () -> Void
    let onOpenSession: (V2SessionID) -> Void
    let onNewSession: (String?) -> Void
    let onConnectorUpdated: (V2Connector) -> Void
    let onConnectorDeleted: (V2ConnectorID) -> Void
    let onSessionsUpdated: ([V2SessionMeta]) -> Void
    let onSetSessionsArchived: ([V2SessionID], Bool) async -> Bool

    @State private var model = DeviceManagementModel()
    @State private var isRenaming = false
    @State private var proposedName = ""
    @State private var isConfirmingCredentialRotation = false
    @State private var isConfirmingDeletion = false
    @State private var credential: V2ConnectorRevokeResponse?
    @State private var runtimeConfiguration: RuntimeConfigurationPresentation?
    @State private var selectedWorkspace: V2DeviceWorkspace?
    @State private var isSelectedArchiveActionRunning = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 30) {
                    DeviceRuntimeSection(
                        connectorIsOnline: connector.status == .online,
                        configuredRuntimes: model.configuredRuntimes,
                        availableRuntimes: model.availableRuntimes,
                        isLoading: model.isLoadingRuntimes,
                        isDiscovering: model.isDiscoveringRuntimes,
                        busyRuntimeId: model.busyRuntimeId,
                        onRefresh: refreshRuntimes,
                        onConfigure: presentRuntimeConfiguration,
                        onToggleActive: setRuntimeActive,
                        onDeleteConfiguration: deleteRuntimeConfiguration
                    )

                    DeviceWorkspaceSection(
                        workspaces: model.workspaces,
                        onOpenWorkspace: { selectedWorkspace = $0 },
                        onNewSession: onNewSession
                    )

                    DeviceSessionSection(
                        sessions: model.filteredSessions,
                        filter: model.sessionFilter,
                        isSelecting: model.isSelectingSessions,
                        selectedSessionIds: model.selectedSessionIds,
                        isArchiveActionRunning: model.isArchiveActionRunning || isSelectedArchiveActionRunning,
                        onFilterChanged: model.setSessionFilter,
                        onToggleSelecting: toggleSelectingSessions,
                        onSelectSession: selectSession,
                        onSetSessionArchived: setSessionArchived,
                        onArchiveSelected: archiveSelectedSessions,
                        onArchiveAll: archiveAllSessions
                    )
                }
                .padding(.leading, safeAreaInsets.leading + 18)
                .padding(.trailing, safeAreaInsets.trailing + 18)
                .padding(.top, 18)
                .padding(.bottom, max(safeAreaInsets.bottom, 24) + 20)
            }
            .scrollIndicators(.hidden)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                DeviceManagementToolbar(
                    connector: connector,
                    onMenu: onMenu,
                    onRename: beginRename,
                    onRotateCredential: { isConfirmingCredentialRotation = true },
                    onDelete: { isConfirmingDeletion = true }
                )
            }
        }
        .background(Color(uiColor: .systemBackground))
        .task(id: connector.id) {
            model.updateSessions(connectorId: connector.id, allSessions: allSessions)
            await model.loadRuntimes(connectorId: connector.id, service: service)
        }
        .onChange(of: allSessions) { _, sessions in
            model.updateSessions(connectorId: connector.id, allSessions: sessions)
        }
        .alert("Rename device", isPresented: $isRenaming) {
            TextField("Device name", text: $proposedName)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await renameConnector() }
            }
        } message: {
            Text("Choose a name that identifies this machine.")
        }
        .confirmationDialog(
            "Rotate connector credential?",
            isPresented: $isConfirmingCredentialRotation,
            titleVisibility: .visible
        ) {
            Button("Rotate credential", role: .destructive) {
                Task { await rotateCredential() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The current desktop Connector will disconnect. Replace its saved token with the new credential before reconnecting.")
        }
        .alert("Delete this device?", isPresented: $isConfirmingDeletion) {
            Button("Delete device", role: .destructive) {
                Task { await deleteConnector() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The device and its server-owned metadata will be removed. This action cannot be undone.")
        }
        .alert("Device action failed", isPresented: errorBinding) {
            Button("OK", role: .cancel) { model.dismissError() }
        } message: {
            Text(model.errorMessage ?? "")
        }
        .sheet(item: $runtimeConfiguration) { presentation in
            RuntimeConfigurationSheet(
                runtime: presentation.runtime,
                schema: presentation.schema,
                startAfterSaving: !presentation.runtime.configured,
                onSave: { config in
                    try await model.saveRuntimeConfig(
                        connectorId: connector.id,
                        runtime: presentation.runtime,
                        config: config,
                        startAfterSaving: !presentation.runtime.configured,
                        service: service
                    )
                }
            )
        }
        .sheet(item: $credential) { response in
            ConnectorCredentialSheet(
                connector: response.connector,
                connectorToken: response.connectorToken,
                serverURL: serverURL
            )
        }
        .sheet(item: $selectedWorkspace) { workspace in
            WorkspaceFilesSheet(
                connectorId: connector.id,
                workspace: workspace,
                service: workspaceFilesService
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: { isPresented in
                if !isPresented { model.dismissError() }
            }
        )
    }

    private func beginRename() {
        proposedName = connector.name
        isRenaming = true
    }

    private func refreshRuntimes() {
        Task {
            await model.discoverRuntimes(connectorId: connector.id, service: service)
        }
    }

    private func presentRuntimeConfiguration(_ runtime: V2DeviceRuntime) {
        guard let schema = model.configSchema(runtime: runtime, service: service) else { return }
        runtimeConfiguration = RuntimeConfigurationPresentation(runtime: runtime, schema: schema)
    }

    private func setRuntimeActive(_ runtime: V2DeviceRuntime, _ active: Bool) {
        Task {
            await model.setRuntimeActive(
                connectorId: connector.id,
                runtime: runtime,
                active: active,
                service: service
            )
        }
    }

    private func deleteRuntimeConfiguration(_ runtime: V2DeviceRuntime) {
        Task {
            await model.deleteRuntimeConfig(
                connectorId: connector.id,
                runtime: runtime,
                service: service
            )
        }
    }

    private func toggleSelectingSessions() {
        if model.isSelectingSessions {
            model.stopSelectingSessions()
        } else {
            model.startSelectingSessions()
        }
    }

    private func selectSession(_ sessionId: V2SessionID) {
        if model.isSelectingSessions {
            model.toggleSessionSelection(sessionId)
        } else {
            onOpenSession(sessionId)
        }
    }

    private func archiveAllSessions() {
        let shouldArchive = model.sessionFilter != .archived
        Task {
            guard let updated = await model.archiveSessions(
                connectorId: connector.id,
                archived: shouldArchive,
                service: service
            ) else { return }
            onSessionsUpdated(updated)
        }
    }

    private func setSessionArchived(_ session: V2SessionMeta, _ archived: Bool) {
        Task {
            _ = await onSetSessionsArchived([session.id], archived)
        }
    }

    private func archiveSelectedSessions() {
        let sessionIds = Array(model.selectedSessionIds)
        guard !sessionIds.isEmpty else { return }
        let shouldArchive = model.sessionFilter != .archived
        Task {
            isSelectedArchiveActionRunning = true
            defer { isSelectedArchiveActionRunning = false }
            if await onSetSessionsArchived(sessionIds, shouldArchive) {
                model.stopSelectingSessions()
            }
        }
    }

    private func renameConnector() async {
        guard let updated = await model.renameConnector(
            connectorId: connector.id,
            name: proposedName,
            service: service
        ) else { return }
        onConnectorUpdated(updated)
    }

    private func rotateCredential() async {
        guard let response = await model.revokeConnector(
            connectorId: connector.id,
            service: service
        ) else { return }
        onConnectorUpdated(response.connector)
        credential = response
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    private func deleteConnector() async {
        let deleted = await model.deleteConnector(
            connectorId: connector.id,
            service: service
        )
        if deleted {
            onConnectorDeleted(connector.id)
        }
    }
}

private struct DeviceManagementToolbar: ToolbarContent {
    let connector: V2Connector
    let onMenu: () -> Void
    let onRename: () -> Void
    let onRotateCredential: () -> Void
    let onDelete: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button(action: onMenu) {
                Label("Open sidebar", systemImage: "line.3.horizontal")
                    .labelStyle(.iconOnly)
            }
        }

        ToolbarItem(placement: .principal) {
            DeviceManagementToolbarTitle(connector: connector)
        }

        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Rename", systemImage: "pencil", action: onRename)
                Button("Rotate credential", systemImage: "key", action: onRotateCredential)
                Divider()
                Button("Delete device", systemImage: "trash", role: .destructive, action: onDelete)
            } label: {
                Label("Device actions", systemImage: "ellipsis")
                    .labelStyle(.iconOnly)
            }
        }
    }
}

private struct DeviceManagementToolbarTitle: View {
    let connector: V2Connector

    var body: some View {
        VStack(spacing: 1) {
            Text(connector.name)
                .font(.headline)
                .lineLimit(1)

            HStack(spacing: 4) {
                Circle()
                    .fill(connector.status == .online ? Color.green : Color.secondary)
                    .frame(width: 5, height: 5)
                Text(connector.status.title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct RuntimeConfigurationPresentation: Identifiable {
    let runtime: V2DeviceRuntime
    let schema: V2RuntimeConfigSchema

    var id: V2RuntimeID { runtime.id }
}

private extension V2ConnectorPresence {
    var title: LocalizedStringResource {
        switch self {
        case .online: "Online"
        case .offline: "Offline"
        case .unknown: "Unknown"
        }
    }
}
