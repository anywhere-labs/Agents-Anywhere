import PhotosUI
import SwiftUI
import UIKit

private let newSessionAttachmentOnlyPrompt = "Please review the attached file."

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @State private var isShowingNewSession = false
    @State private var sessionToOpen: SessionSummary?

    var body: some View {
        RootTabsView(sessionToOpen: $sessionToOpen) {
            isShowingNewSession = true
        }
        .task {
            await appState.refreshDashboard()
        }
        .sheet(isPresented: $isShowingNewSession) {
            NewSessionSheet { session in
                sessionToOpen = session
            }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct RootTabsView: View {
    @Binding var sessionToOpen: SessionSummary?

    let onNewSession: () -> Void

    @SceneStorage("selectedRootTab")
    private var selectedTab: String = "sessions"
    @State private var sessionPath: [SessionSummary] = []

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("Sessions", systemImage: "rectangle.stack.fill", value: "sessions") {
                NavigationStack(path: $sessionPath) {
                    SessionsView(onNewSession: onNewSession)
                        .navigationDestination(for: SessionSummary.self) { session in
                            SessionDetailView(initialSession: session)
                        }
                }
            }

            Tab("Devices", systemImage: "desktopcomputer", value: "devices") {
                NavigationStack {
                    DevicesView()
                        .navigationTitle("Devices")
                }
            }

            Tab("Me", systemImage: "person.crop.circle.fill", value: "me") {
                NavigationStack {
                    MeView()
                        .navigationTitle("Me")
                }
            }
        }
        .onChange(of: sessionToOpen) { _, session in
            guard let session else { return }
            selectedTab = "sessions"
            sessionPath = [session]
            sessionToOpen = nil
        }
    }
}

private struct SessionsView: View {
    @EnvironmentObject private var appState: AppState

    let onNewSession: () -> Void

    @State private var activeFilter: SessionFilter?
    @State private var selectedStatus = "All"
    @State private var selectedRuntime = "Any Runtime"
    @State private var selectedDevice = "Any Device"
    @State private var selectedSort = "Recent"

    private var filteredSessions: [SessionSummary] {
        sortedSessions.filter { session in
            let matchesStatus = selectedStatus == "All" || session.statusLabel == selectedStatus
            let matchesRuntime = selectedRuntime == "Any Runtime"
                || session.runtime.localizedCaseInsensitiveContains(selectedRuntime)
            let matchesDevice = selectedDevice == "Any Device"
                || session.connectorStatus.localizedCaseInsensitiveContains(selectedDevice)
                || session.connectorId.localizedCaseInsensitiveContains(selectedDevice)
            return matchesStatus && matchesRuntime && matchesDevice
        }
    }

    private var sortedSessions: [SessionSummary] {
        switch selectedSort {
        case "Oldest":
            appState.sessions.sorted { $1.isMoreRecent(than: $0) }
        case "Name":
            appState.sessions.sorted { $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending }
        case "Status":
            appState.sessions.sorted { $0.status.localizedCaseInsensitiveCompare($1.status) == .orderedAscending }
        default:
            appState.sessions.sorted { $0.isMoreRecent(than: $1) }
        }
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                header
                sessionList
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 32)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onNewSession) {
                    Image(systemName: "plus")
                }
            }
        }
        .refreshable {
            await appState.refreshDashboard()
        }
        .sheet(item: $activeFilter) { filter in
            FilterSheet(
                filter: filter,
                selectedStatus: $selectedStatus,
                selectedRuntime: $selectedRuntime,
                selectedDevice: $selectedDevice,
                selectedSort: $selectedSort,
            )
            .presentationDetents([.height(320), .medium])
            .presentationDragIndicator(.visible)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sessions")
                .font(.largeTitle.weight(.bold))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    FilterPill(
                        title: "Status",
                        value: selectedStatus,
                        systemImage: "circle.grid.2x2.fill",
                    ) {
                        activeFilter = .status
                    }

                    FilterPill(
                        title: "Runtime",
                        value: selectedRuntime,
                        systemImage: "terminal.fill",
                    ) {
                        activeFilter = .runtime
                    }

                    FilterPill(
                        title: "Device",
                        value: selectedDevice,
                        systemImage: "laptopcomputer",
                    ) {
                        activeFilter = .device
                    }

                    FilterPill(
                        title: "Sort",
                        value: selectedSort,
                        systemImage: "arrow.up.arrow.down",
                    ) {
                        activeFilter = .sort
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 4)
            }
            .padding(.horizontal, -20)
        }
        .padding(.horizontal, 20)
        .padding(.top, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var sessionList: some View {
        if filteredSessions.isEmpty {
            ContentUnavailableView(
                "No Sessions",
                systemImage: "rectangle.stack",
                description: Text("Start a session from the web console, then monitor it here."),
            )
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(filteredSessions.enumerated()), id: \.element.id) { index, session in
                    NavigationLink(value: session) {
                        SessionRow(
                            session: session,
                            deviceName: deviceName(for: session),
                            showsDivider: index < filteredSessions.count - 1,
                        )
                    }
                    .buttonStyle(SessionRowButtonStyle())
                }
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func deviceName(for session: SessionSummary) -> String {
        if let connector = appState.connectors.first(where: { $0.id == session.connectorId }) {
            return connector.name
        }
        return session.connectorStatus.capitalized
    }
}

private struct DevicesView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        List {
            if appState.connectors.isEmpty {
                ContentUnavailableView(
                    "No Devices",
                    systemImage: "desktopcomputer",
                    description: Text("Pair a connector from the web console to see it here."),
                )
            } else {
                Section("Devices") {
                    ForEach(appState.connectors) { connector in
                        DeviceRow(connector: connector)
                    }
                }
            }
        }
        .refreshable {
            await appState.refreshDashboard()
        }
    }
}

private struct MeView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(appState.me?.userId ?? "")
                            .font(.headline)

                        Text(appState.me?.role.rawValue.capitalized ?? "")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
            }

            Section("Server") {
                Text(appState.serverURL?.absoluteString ?? "")
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            Section {
                Button("Sign Out", role: .destructive) {
                    appState.signOut()
                }
            }
        }
    }
}

private struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    let onCreated: (SessionSummary) -> Void

    @State private var prompt = ""
    @State private var isPromptFocused = false
    @State private var selectedConnectorId: String?
    @State private var selectedRuntime = ""
    @State private var permissionMode: NewSessionPermissionMode = .ask
    @State private var homeWorkspacePath: String?
    @State private var selectedWorkspacePath: String?
    @State private var resolvedWorkspaceSelectionKey: String?
    @State private var isShowingWorkspaceSheet = false
    @State private var isShowingPathBrowser = false
    @State private var isResolvingHomeWorkspace = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var pendingUploads: [AttachmentUpload] = []
    @State private var isPhotoPickerPresented = false
    @State private var isCameraPickerPresented = false
    @State private var isCameraUnavailable = false
    @State private var isCreating = false
    @State private var errorMessage: String?

    private var availableConnectors: [ConnectorSummary] {
        appState.connectors.filter(\.canStartSession)
    }

    private var selectedConnector: ConnectorSummary? {
        if let selectedConnectorId,
           let connector = availableConnectors.first(where: { $0.id == selectedConnectorId })
        {
            return connector
        }
        return availableConnectors.first
    }

    private var availableRuntimes: [String] {
        selectedConnector?.attachedRuntimeNames ?? []
    }

    private var selectedRuntimeValue: String {
        if availableRuntimes.contains(selectedRuntime) {
            return selectedRuntime
        }
        return availableRuntimes.first ?? ""
    }

    private var recentWorkspaces: [String] {
        guard let connectorId = selectedConnector?.id else { return [] }
        var seen = Set<String>()
        return appState.sessions
            .filter { $0.connectorId == connectorId && ($0.cwd?.isEmpty == false) }
            .sorted { $0.isMoreRecent(than: $1) }
            .compactMap(\.cwd)
            .filter { cwd in
                guard !seen.contains(cwd) else { return false }
                seen.insert(cwd)
                return true
            }
            .prefix(8)
            .map { $0 }
    }

    private var runtimeChoices: [NewSessionRuntimeChoice] {
        availableConnectors.flatMap { connector in
            connector.attachedRuntimeNames.map { runtime in
                NewSessionRuntimeChoice(connector: connector, runtime: runtime)
            }
        }
    }

    private var selectedRuntimeChoice: NewSessionRuntimeChoice? {
        if let selectedConnectorId,
           !selectedRuntime.isEmpty,
           let choice = runtimeChoices.first(where: { $0.connector.id == selectedConnectorId && $0.runtime == selectedRuntime })
        {
            return choice
        }
        return runtimeChoices.first
    }

    private var selectedWorkspaceForCreate: String {
        selectedWorkspacePath ?? homeWorkspacePath ?? "~"
    }

    private var workspaceTitle: String {
        selectedWorkspacePath.map(workspaceDisplayName) ?? "Home directory"
    }

    private var workspaceSubtitle: String {
        selectedWorkspacePath ?? homeWorkspacePath ?? (isResolvingHomeWorkspace ? "Resolving home..." : "Default workspace")
    }

    private var messageInputActions: [MessageInputAction] {
        var actions = [
            MessageInputAction(title: "Photos", systemImage: "photo") {
                isPhotoPickerPresented = true
            },
            MessageInputAction(title: "Camera", systemImage: "camera") {
                openCamera()
            },
            MessageInputAction(title: "Workspace", systemImage: "folder") {
                isShowingWorkspaceSheet = true
            },
        ]
        actions.append(contentsOf: NewSessionPermissionMode.allCases.map { mode in
            MessageInputAction(
                title: permissionMode == mode ? "\(mode.title) Access" : "Use \(mode.title) Access",
                systemImage: mode.systemImage,
            ) {
                permissionMode = mode
            }
        })
        return actions
    }

    private var canSubmit: Bool {
        selectedConnector != nil &&
            !selectedRuntimeValue.isEmpty &&
            !isCreating &&
            (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingUploads.isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header

                    if availableConnectors.isEmpty {
                        ContentUnavailableView(
                            "No Online Agents",
                            systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                            description: Text("Pair an online connector and attach an agent before starting a session."),
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, 48)
                    }

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 2)
                    }
                }
                .padding(20)
                .padding(.bottom, 136)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    HStack(spacing: 14) {
                        Button("Cancel") { dismiss() }
                        runtimeMenu
                    }
                }
            }
            .onAppear {
                reconcileSelection()
            }
            .onChange(of: appState.connectors) { _, _ in
                reconcileSelection()
            }
            .onChange(of: selectedConnectorId) { _, _ in
                reconcileSelection()
            }
            .onChange(of: selectedRuntime) { _, _ in
                reconcileSelection()
            }
            .sheet(isPresented: $isShowingWorkspaceSheet) {
                WorkspacePickerSheet(
                    homeWorkspacePath: homeWorkspacePath,
                    selectedWorkspacePath: $selectedWorkspacePath,
                    recentWorkspaces: recentWorkspaces,
                    isResolvingHomeWorkspace: isResolvingHomeWorkspace,
                    onChoosePath: {
                        isShowingWorkspaceSheet = false
                        isShowingPathBrowser = true
                    },
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $isShowingPathBrowser) {
                if let api = appState.api,
                   let token = appState.accessToken(),
                   let connector = selectedConnector
                {
                    RemoteFileBrowserSheet(
                        api: api,
                        token: token,
                        connector: connector,
                        mode: .pickDirectory,
                        initialPath: selectedWorkspaceForCreate,
                    ) { selection in
                        selectedWorkspacePath = selection.path
                    }
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    if availableConnectors.isEmpty {
                        EmptyView()
                    } else {
                        workspaceButton
                            .padding(.horizontal, 12)
                    }

                    if !pendingUploads.isEmpty {
                        AttachmentStrip(uploads: pendingUploads) { upload in
                            pendingUploads.removeAll { $0 == upload }
                        }
                    }

                    LiquidGlassMessageInputBar(
                        text: $prompt,
                        isFocused: $isPromptFocused,
                        isSending: isCreating,
                        hasPendingAttachments: !pendingUploads.isEmpty,
                        placeholder: selectedConnector == nil ? "No online agent" : "Message to agent",
                        actions: messageInputActions,
                        isSubmitEnabled: { _ in canSubmit },
                        showsActionsButton: true,
                        onSend: {
                            Task { await createSession() }
                        },
                        onDismissKeyboard: {
                            isPromptFocused = false
                        },
                    )
                }
            }
            .photosPicker(isPresented: $isPhotoPickerPresented, selection: $selectedPhotoItems, maxSelectionCount: 4, matching: .images)
            .onChange(of: selectedPhotoItems) { _, items in
                Task { await importPhotos(items) }
            }
            .fullScreenCover(isPresented: $isCameraPickerPresented) {
                CameraImagePicker { image in
                    importCameraImage(image)
                }
                .ignoresSafeArea()
            }
            .alert("Camera", isPresented: $isCameraUnavailable) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Camera capture is not available on this device.")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What should the agent do?")
                .font(.title.weight(.bold))
            Text("Choose a workspace and send the first message.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private var runtimeMenu: some View {
        Menu {
            ForEach(runtimeChoices) { choice in
                Button {
                    selectedConnectorId = choice.connector.id
                    selectedRuntime = choice.runtime
                } label: {
                    Label {
                        VStack(alignment: .leading) {
                            Text(choice.title)
                            Text(choice.subtitle)
                        }
                    } icon: {
                        Image(systemName: runtimeIcon(choice.runtime))
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: runtimeIcon(selectedRuntimeValue))
                Text(selectedRuntimeChoice?.shortTitle ?? "Agent")
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
            }
        }
        .disabled(runtimeChoices.isEmpty || isCreating)
        .accessibilityLabel("Device and Agent")
    }

    private var workspaceButton: some View {
        Button {
            isShowingWorkspaceSheet = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(workspaceTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(workspaceSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if isResolvingHomeWorkspace {
                    ProgressView()
                        .scaleEffect(0.75)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .newSessionGlassEffect(shape: RoundedRectangle(cornerRadius: 25, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func reconcileSelection() {
        guard let connector = selectedConnector else {
            selectedConnectorId = nil
            selectedRuntime = ""
            return
        }
        selectedConnectorId = connector.id
        let runtimes = connector.attachedRuntimeNames
        if !runtimes.contains(selectedRuntime) {
            selectedRuntime = runtimes.first ?? ""
        }
        let selectionKey = "\(connector.id):\(selectedRuntimeValue)"
        guard resolvedWorkspaceSelectionKey != selectionKey else { return }
        resolvedWorkspaceSelectionKey = selectionKey
        homeWorkspacePath = nil
        selectedWorkspacePath = nil
        resolveHomeWorkspaceForSelection(connectorId: connector.id, runtime: selectedRuntimeValue)
    }

    private func resolveHomeWorkspaceForSelection(connectorId: String, runtime: String) {
        guard let api = appState.api,
              let token = appState.accessToken()
        else { return }
        isResolvingHomeWorkspace = true
        Task {
            let resolved: String?
            do {
                let response = try await api.connectorFsList(token: token, connectorId: connectorId, root: "~")
                let path = response.result.path.trimmingCharacters(in: .whitespacesAndNewlines)
                resolved = path.isEmpty || path == "~" ? nil : path
            } catch {
                resolved = nil
            }
            await MainActor.run {
                guard selectedConnector?.id == connectorId, selectedRuntimeValue == runtime else { return }
                homeWorkspacePath = resolved
                isResolvingHomeWorkspace = false
            }
        }
    }

    private func createSession() async {
        guard canSubmit,
              let api = appState.api,
              let token = appState.accessToken(),
              let connector = selectedConnector
        else { return }

        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }

        do {
            let created = try await api.createSession(
                token: token,
                connectorId: connector.id,
                runtime: selectedRuntimeValue,
                title: text.isEmpty ? nil : text,
                cwd: selectedWorkspaceForCreate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : selectedWorkspaceForCreate,
                approvalPolicy: permissionMode.approvalPolicy,
                sandbox: permissionMode.sandbox,
            )
            let takeover = try await api.enableTakeover(token: token, sessionId: created.session.id)
            let uploads = pendingUploads
            let uploaded = uploads.isEmpty
                ? []
                : try await api.uploadSessionAttachments(token: token, sessionId: takeover.session.id, uploads: uploads).attachments
            let sendContent = text.isEmpty && !uploaded.isEmpty ? newSessionAttachmentOnlyPrompt : text
            _ = try await api.sendSessionMessage(
                token: token,
                sessionId: takeover.session.id,
                content: sendContent,
                attachments: uploaded.map { AttachmentRef(fileId: $0.fileId) },
                clientMessageId: "new_\(UUID().uuidString)",
            )
            prompt = ""
            pendingUploads = []
            await appState.refreshDashboard()
            onCreated(takeover.session)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openCamera() {
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            isCameraPickerPresented = true
        } else {
            isCameraUnavailable = true
        }
    }

    private func importCameraImage(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.86) else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        pendingUploads.append(AttachmentUpload(
            name: "camera-\(formatter.string(from: Date())).jpg",
            mediaType: "image/jpeg",
            data: data,
        ))
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        defer { selectedPhotoItems = [] }
        for item in items {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                pendingUploads.append(AttachmentUpload(
                    name: "photo-\(UUID().uuidString.prefix(8)).jpg",
                    mediaType: "image/jpeg",
                    data: data,
                ))
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct SectionLabel: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}

private struct NewSessionRuntimeChoice: Identifiable, Hashable {
    let connector: ConnectorSummary
    let runtime: String

    var id: String {
        "\(connector.id):\(runtime)"
    }

    var title: String {
        "\(connector.name) / \(runtimeDisplayName(runtime))"
    }

    var shortTitle: String {
        "\(connector.name) / \(runtimeDisplayName(runtime))"
    }

    var subtitle: String {
        runtime
    }
}

private struct WorkspacePickerSheet: View {
    @Environment(\.dismiss) private var dismiss

    let homeWorkspacePath: String?
    @Binding var selectedWorkspacePath: String?
    let recentWorkspaces: [String]
    let isResolvingHomeWorkspace: Bool
    let onChoosePath: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        selectedWorkspacePath = nil
                        dismiss()
                    } label: {
                        WorkspacePickerRow(
                            title: "Home directory",
                            subtitle: homeWorkspacePath ?? (isResolvingHomeWorkspace ? "Resolving home..." : "Default workspace"),
                            systemImage: "house",
                            isSelected: selectedWorkspacePath == nil,
                            showsProgress: isResolvingHomeWorkspace,
                        )
                    }
                } header: {
                    Text("Default")
                }

                Section {
                    Button {
                        dismiss()
                        onChoosePath()
                    } label: {
                        WorkspacePickerRow(
                            title: "Choose path",
                            subtitle: "Browse this device",
                            systemImage: "folder.badge.plus",
                            isSelected: false,
                        )
                    }

                    if recentWorkspaces.isEmpty {
                        ContentUnavailableView(
                            "No Recent Workspaces",
                            systemImage: "clock",
                            description: Text("Recent workspaces appear after sessions are created."),
                        )
                    } else {
                        ForEach(recentWorkspaces, id: \.self) { path in
                            Button {
                                selectedWorkspacePath = path
                                dismiss()
                            } label: {
                                WorkspacePickerRow(
                                    title: workspaceDisplayName(path),
                                    subtitle: path,
                                    systemImage: "folder",
                                    isSelected: selectedWorkspacePath == path,
                                )
                            }
                        }
                    }
                } header: {
                    Text("Recent Workspaces")
                }
            }
            .navigationTitle("Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct WorkspacePickerRow: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let isSelected: Bool
    var showsProgress = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if showsProgress {
                ProgressView()
                    .scaleEffect(0.75)
            } else if isSelected {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.tint)
            }
        }
        .contentShape(Rectangle())
    }
}

private extension View {
    @ViewBuilder
    func newSessionGlassEffect<S: Shape>(shape: S) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self.background {
                shape.fill(.regularMaterial)
            }
        }
    }
}

private enum NewSessionPermissionMode: String, CaseIterable, Identifiable {
    case ask
    case full
    case read

    var id: String { rawValue }

    var title: String {
        switch self {
        case .ask:
            return "Ask"
        case .full:
            return "Full"
        case .read:
            return "Read"
        }
    }

    var description: String {
        switch self {
        case .ask:
            return "The agent asks before sensitive actions."
        case .full:
            return "No approval prompts; full filesystem and command access."
        case .read:
            return "Read-only sandbox with approval required for writes."
        }
    }

    var systemImage: String {
        switch self {
        case .ask:
            return "questionmark.circle"
        case .full:
            return "bolt.circle"
        case .read:
            return "lock.circle"
        }
    }

    var approvalPolicy: String? {
        switch self {
        case .ask:
            return nil
        case .full:
            return "never"
        case .read:
            return "on-request"
        }
    }

    var sandbox: String? {
        switch self {
        case .ask:
            return nil
        case .full:
            return "danger-full-access"
        case .read:
            return "read-only"
        }
    }
}

private func runtimeDisplayName(_ runtime: String) -> String {
    if runtime.localizedCaseInsensitiveContains("claude") {
        return "Claude"
    }
    if runtime.localizedCaseInsensitiveContains("codex") {
        return "Codex"
    }
    return runtime.capitalized
}

private func runtimeIcon(_ runtime: String) -> String {
    runtime.localizedCaseInsensitiveContains("claude") ? "sparkles" : "terminal"
}

private func workspaceDisplayName(_ path: String) -> String {
    let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if trimmed.isEmpty || trimmed == "~" {
        return path
    }
    return trimmed.split(separator: "/").last.map(String.init) ?? path
}

private enum SessionFilter: String, Identifiable {
    case status
    case runtime
    case device
    case sort

    var id: String { rawValue }

    var title: String {
        switch self {
        case .status:
            return "Status"
        case .runtime:
            return "Runtime"
        case .device:
            return "Device"
        case .sort:
            return "Sort"
        }
    }

    var options: [String] {
        switch self {
        case .status:
            ["All", "Running", "Idle", "Waiting", "Error"]
        case .runtime:
            ["Any Runtime", "Codex", "Claude Code"]
        case .device:
            ["Any Device", "online", "offline"]
        case .sort:
            ["Recent", "Oldest", "Name", "Status"]
        }
    }
}

private struct FilterSheet: View {
    @Environment(\.dismiss) private var dismiss

    let filter: SessionFilter

    @Binding var selectedStatus: String
    @Binding var selectedRuntime: String
    @Binding var selectedDevice: String
    @Binding var selectedSort: String

    var body: some View {
        NavigationStack {
            List {
                ForEach(filter.options, id: \.self) { option in
                    Button {
                        setSelection(option)
                        dismiss()
                    } label: {
                        HStack {
                            Text(option)
                                .foregroundStyle(.primary)

                            Spacer()

                            if isSelected(option) {
                                Image(systemName: "checkmark")
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                }
            }
            .navigationTitle(filter.title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func isSelected(_ option: String) -> Bool {
        switch filter {
        case .status:
            return selectedStatus == option
        case .runtime:
            return selectedRuntime == option
        case .device:
            return selectedDevice == option
        case .sort:
            return selectedSort == option
        }
    }

    private func setSelection(_ option: String) {
        switch filter {
        case .status:
            selectedStatus = option
        case .runtime:
            selectedRuntime = option
        case .device:
            selectedDevice = option
        case .sort:
            selectedSort = option
        }
    }
}

private struct FilterPill: View {
    let title: String
    let value: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: systemImage)
                Text(value)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background {
                Capsule(style: .continuous)
                    .fill(.regularMaterial)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title): \(value)")
    }
}

private struct SessionRow: View {
    let session: SessionSummary
    let deviceName: String
    let showsDivider: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            title

                            HStack(spacing: 6) {
                                SessionMetadataPill(title: deviceName)
                                SessionMetadataPill(title: session.runtime)
                            }
                        }

                        title
                    }

                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 8)

                Text(session.displayTime)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)

            if showsDivider {
                Divider()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var title: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusDotStyle)
                .frame(width: 8, height: 8)

            Text(session.displayTitle)
                .font(.headline)
                .lineLimit(1)
        }
        .layoutPriority(1)
    }

    private var subtitle: String {
        return session.cwd ?? "No workspace"
    }

    private var statusDotStyle: AnyShapeStyle {
        if session.status == "waiting_approval" {
            return AnyShapeStyle(Color.blue)
        }
        if session.connectorStatus == "online" {
            return AnyShapeStyle(.primary)
        }
        return AnyShapeStyle(Color.gray.opacity(0.55))
    }
}

private struct SessionRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(configuration.isPressed ? Color.secondary.opacity(0.14) : Color.clear)
            }
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

private struct SessionMetadataPill: View {
    let title: String

    var body: some View {
        HStack(spacing: 0) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 120, alignment: .leading)
        }
        .fixedSize(horizontal: true, vertical: false)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background {
            Capsule(style: .continuous)
                .fill(.secondary.opacity(0.10))
        }
    }
}

private struct DeviceRow: View {
    let connector: ConnectorSummary

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(connector.name)
                statusText
            }
        } icon: {
            Image(systemName: "desktopcomputer")
        }
    }

    @ViewBuilder
    private var statusText: some View {
        if connector.status == "online" {
            Text(connector.status.capitalized)
                .font(.caption)
                .foregroundStyle(.green)
        } else {
            Text(connector.status.capitalized)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}


#Preview {
    DashboardView()
        .environmentObject(AppState())
}
