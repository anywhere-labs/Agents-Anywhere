import Foundation
import Observation

struct NewSessionPreference: Codable {
    var draftText: String? = nil
    var connectorID = ""
    var runtimeID = ""
    var workspaces: [String: String] = [:]
    var projectIDs: [String: String]? = nil
    var homePaths: [String: String]? = nil
    var selections: [String: [String: String]] = [:]
}

/// Account-scoped draft and target selection. A target is committed only after
/// both the device and its configured Agent instance have been chosen.
@MainActor @Observable
final class NewSessionModel {
    let draft = ComposerDraft()
    let settings = ConversationSettings()
    private(set) var connectors: [V2Connector] = []
    private(set) var projects: [V2Project] = []
    private(set) var projectID: String?
    private(set) var workspace = ""
    private(set) var homePaths: [String: String] = [:]
    private(set) var homeErrors: [String: String] = [:]
    private(set) var loadingHomes: Set<String> = []
    private(set) var hasLoadedProjects = false
    private(set) var inventories: [String: [V2DeviceRuntime]] = [:]
    private(set) var inventoryErrors: [String: String] = [:]
    private(set) var loadingDevices: Set<String> = []
    private(set) var connectorID: String
    private(set) var runtimeID: String
    private(set) var prepared: V2PreparedSession?
    private(set) var isPreparing = false
    private(set) var isCreating = false
    private(set) var isValid = true
    private(set) var creationUncertain = false
    private(set) var network = V2NetworkStatus()
    var error: String?
    @ObservationIgnored var onStaged: ((NewSessionSubmission) async -> Void)?
    @ObservationIgnored var onFailed: ((NewSessionSubmission) -> Void)?
    @ObservationIgnored var onBound: ((NewSessionSubmission, V2SessionCreateResponse) -> Void)?
    @ObservationIgnored var onProjectResolved: ((V2Project) -> Void)?
    @ObservationIgnored private let devices: V2DeviceManagementService
    @ObservationIgnored private let preparation: V2SessionPreparationService
    @ObservationIgnored private let creation: V2SessionCreationService
    @ObservationIgnored private let projectAPI: V2ProjectAPI
    @ObservationIgnored private let files: V2WorkspaceFilesService
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let preferenceKey: String
    @ObservationIgnored private var preference: NewSessionPreference
    @ObservationIgnored private var preparationVersion = 0
    @ObservationIgnored private var inventoryTasks: [String: Task<[V2DeviceRuntime], Error>] = [:]
    @ObservationIgnored private var homeTasks: [String: Task<String, Error>] = [:]
    @ObservationIgnored private var resolvedHomes: Set<String> = []

    init(scope: V2ClientScope, devices: V2DeviceManagementService,
         preparation: V2SessionPreparationService, creation: V2SessionCreationService, projectAPI: V2ProjectAPI,
         defaults: UserDefaults = .standard) {
        self.projectAPI = projectAPI
        files = V2WorkspaceFilesService(connectorAPI: devices.connectorAPI, serverURL: scope.serverURL)
        self.devices = devices; self.preparation = preparation; self.creation = creation; self.defaults = defaults
        preferenceKey = "aa.native.new-session.v1." + Data((scope.serverURL.absoluteString + "\n" + scope.accountID).utf8).base64EncodedString()
        preference = defaults.data(forKey: preferenceKey).flatMap { try? JSONDecoder().decode(NewSessionPreference.self, from: $0) } ?? .init()
        connectorID = preference.connectorID; runtimeID = preference.runtimeID
        projectID = preference.projectIDs?[preference.connectorID]
        workspace = preference.workspaces[preference.connectorID] ?? ""
        homePaths = preference.homePaths ?? [:]
        draft.text = preference.draftText ?? ""
    }

    var connector: V2Connector? { connectors.first { $0.id == connectorID } }
    var runtime: V2DeviceRuntime? { inventories[connectorID]?.first { $0.id == runtimeID } }
    var project: V2Project? { projects.first { $0.id == projectID && $0.connectorId == connectorID } }
    var homePath: String? { homePaths[connectorID] }
    var isHome: Bool {
        guard let homePath else { return false }
        return ProjectWorkspacePath.key(workspace, deviceOS: connector?.deviceOs) == ProjectWorkspacePath.key(homePath, deviceOS: connector?.deviceOs)
    }
    var availableProjects: [V2Project] { projects.filter { $0.connectorId == connectorID }.sorted { $0.name < $1.name } }

    func updateProjects(_ values: [V2Project]) {
        guard isValid else { return }
        projects = values; hasLoadedProjects = true
        // The path is the draft's identity. Late lists, renames and display-mode
        // changes may discover a project without changing the chosen directory.
        if workspace.isEmpty, let saved = project { workspace = saved.workspacePath }
        identifyProject()
    }

    @discardableResult func selectProject(_ id: String) -> Bool {
        guard !isCreating, isValid, let value = projects.first(where: { $0.id == id }) else { return false }
        if connectorID != value.connectorId { focusDevice(value.connectorId, workspace: nil) }
        workspace = value.workspacePath
        identifyProject()
        return true
    }

    private func restoreProjectForDevice() {
        workspace = preference.workspaces[connectorID] ?? ""
        projectID = preference.projectIDs?[connectorID]
        if workspace.isEmpty { workspace = project?.workspacePath ?? homePaths[connectorID] ?? "" }
        identifyProject()
    }

    @discardableResult func selectWorkspace(_ path: String) -> Bool {
        guard isValid, !isCreating, !connectorID.isEmpty,
              ProjectWorkspacePath.key(path, deviceOS: connector?.deviceOs) != nil else { return false }
        workspace = path.trimmingCharacters(in: .whitespacesAndNewlines)
        identifyProject()
        return true
    }

    private func identifyProject() {
        projectID = ProjectWorkspacePath.project(in: projects, connectorID: connectorID, path: workspace, deviceOS: connector?.deviceOs)?.id
        guard !connectorID.isEmpty else { return }
        preference.connectorID = connectorID
        preference.workspaces[connectorID] = workspace
        var saved = preference.projectIDs ?? [:]; saved[connectorID] = projectID; preference.projectIDs = saved
        persist()
    }

    /// The connector expands '~'. URL/FileManager on the phone must never
    /// participate in resolving a remote home or comparing remote paths.
    func resolveHome() async {
        let device = connectorID
        guard isValid, connector?.status == .online, network.availability != .offline,
              !resolvedHomes.contains(device) else { return }
        let task: Task<String, Error>
        let ownsTask = homeTasks[device] == nil
        if let existing = homeTasks[device] { task = existing }
        else {
            let os = connector?.deviceOs
            task = Task {
                let directory = try await files.directory(connectorId: device, root: "~", path: ".")
                guard directory.targetType == nil || directory.targetType == "directory",
                      ProjectWorkspacePath.key(directory.path, deviceOS: os) != nil else { throw HTTPError.invalidResponse }
                return directory.path
            }
            homeTasks[device] = task; loadingHomes.insert(device); homeErrors[device] = nil
        }
        defer { if ownsTask { homeTasks[device] = nil; loadingHomes.remove(device) } }
        do {
            let path = try await task.value
            guard isValid, !Task.isCancelled else { return }
            homePaths[device] = path
            resolvedHomes.insert(device)
            preference.homePaths = homePaths; persist()
            if connectorID == device, workspace.isEmpty { workspace = path; identifyProject() }
        } catch { if isValid, !Task.isCancelled { homeErrors[device] = error.localizedDescription } }
    }
    var canAttach: Bool { prepared?.capabilities.allows("runtime.attachment") == true }
    var canCreate: Bool {
        isValid && !isCreating && !isPreparing && !creationUncertain && network.availability != .offline
            && ProjectWorkspacePath.key(workspace, deviceOS: connector?.deviceOs) != nil
            && connector?.status == .online && runtime?.isReadyForSession == true && prepared != nil
            && settings.hasValidSelections && draft.canAttemptSend && (draft.attachments.isEmpty || canAttach)
    }

    func updateNetwork(_ status: V2NetworkStatus) {
        network = status
        if status.availability == .offline { prepared = nil; preparationVersion += 1; isPreparing = false }
    }

    func focusDevice(_ id: String, workspace: String?) {
        guard !isCreating else { return }
        saveSelections()
        connectorID = id
        runtimeID = preference.connectorID == id ? preference.runtimeID : ""
        prepared = nil; preparationVersion += 1
        restoreProjectForDevice()
        if let workspace { _ = selectWorkspace(workspace) }
    }

    func refresh(connectors: [V2Connector]) async {
        guard isValid else { return }
        self.connectors = connectors
        if !connectors.isEmpty, !connectors.contains(where: { $0.id == connectorID }) {
            connectorID = connectors.first { $0.id == preference.connectorID }?.id
                ?? connectors.first { $0.status == .online }?.id ?? connectors.first?.id ?? ""
            runtimeID = ""
            restoreProjectForDevice()
        }
        guard connector?.status == .online, network.availability != .offline else {
            prepared = nil; preparationVersion += 1; isPreparing = false; return
        }
        let device = connectorID
        async let home: Void = resolveHome()
        await loadInventory(device)
        guard isValid, connectorID == device else { return }
        let available = inventories[device] ?? []
        if !available.contains(where: { $0.id == runtimeID }) {
            let saved = preference.connectorID == device ? preference.runtimeID : ""
            runtimeID = available.first { $0.id == saved && $0.isReadyForSession }?.id
                ?? available.first { $0.isReadyForSession }?.id ?? ""
        }
        await prepareTarget()
        await home
    }

    func loadInventory(_ deviceID: String) async {
        guard isValid, network.availability != .offline,
              connectors.contains(where: { $0.id == deviceID && $0.status == .online }) else { return }
        if let existing = inventoryTasks[deviceID] {
            if let result = try? await existing.value, isValid { inventories[deviceID] = result.filter(\.configured) }
            return
        }
        loadingDevices.insert(deviceID); inventoryErrors[deviceID] = nil
        let task = Task { try await devices.runtimes(connectorId: deviceID) }
        inventoryTasks[deviceID] = task
        defer { loadingDevices.remove(deviceID); inventoryTasks[deviceID] = nil }
        do {
            let runtimes = try await task.value
            guard isValid else { return }
            inventories[deviceID] = runtimes.filter(\.configured)
        } catch { if isValid { inventoryErrors[deviceID] = error.localizedDescription } }
    }

    @discardableResult func selectTarget(connectorID: String, runtimeID: String) async -> Bool {
        guard !isCreating, isValid, network.availability != .offline,
              connectors.contains(where: { $0.id == connectorID && $0.status == .online }),
              inventories[connectorID]?.contains(where: { $0.id == runtimeID && $0.isReadyForSession }) == true else { return false }
        saveSelections()
        let changedDevice = self.connectorID != connectorID
        self.connectorID = connectorID; self.runtimeID = runtimeID
        if changedDevice { restoreProjectForDevice() }
        preference.connectorID = connectorID; preference.runtimeID = runtimeID
        persist()
        async let home: Void = resolveHome()
        await prepareTarget()
        await home
        return true
    }

    func prepareTarget() async {
        preparationVersion += 1
        let version = preparationVersion
        prepared = nil
        if !creationUncertain { error = nil }
        guard isValid, connector?.status == .online, runtime?.isReadyForSession == true,
              network.availability != .offline else { isPreparing = false; return }
        isPreparing = true
        defer { if version == preparationVersion { isPreparing = false } }
        do {
            let value = try await preparation.prepare(connectorId: connectorID, runtimeId: runtimeID)
            guard isValid, version == preparationVersion, !Task.isCancelled else { return }
            guard value.runtime.isReadyForSession else {
                error = value.runtime.sessionUnavailableReason ?? String(localized: "Agent 尚未就绪")
                return
            }
            prepared = value
            settings.replace(ChatSettingsCatalog(value.catalogs), selections: savedSelections)
        } catch { if isValid, version == preparationVersion { self.error = error.localizedDescription } }
    }

    func saveSelections() {
        guard prepared != nil, !connectorID.isEmpty, !runtimeID.isEmpty else { return }
        preference.selections[targetKey] = Dictionary(uniqueKeysWithValues: settings.selections.map { ($0.key.rawValue, $0.value) })
        persist()
    }

    func create(text: String) async -> V2SessionMeta? {
        guard canCreate, let runtime else { return nil }
        draft.text = text
        guard draft.canAttemptSend else { return nil }
        let files = draft.attachments
        isCreating = true; error = nil
        saveSelections()
        defer { isCreating = false; saveDraft() }
        let selectedDevice = connectorID, selectedPath = workspace
        let project: V2Project
        do {
            project = try await V2WorkspaceProjectResolver(api: projectAPI).resolve(
                projects: projects, connectorID: selectedDevice, path: selectedPath, deviceOS: connector?.deviceOs,
                validate: { [self] in
                    guard isValid, !Task.isCancelled else { throw CancellationError() }
                    guard connectorID == selectedDevice, workspace == selectedPath,
                          network.availability != .offline, connector?.status == .online else { throw URLError(.notConnectedToInternet) }
                })
            guard isValid, !Task.isCancelled else { return nil }
            guard project.connectorId == selectedDevice,
                  ProjectWorkspacePath.key(project.workspacePath, deviceOS: connector?.deviceOs) == ProjectWorkspacePath.key(selectedPath, deviceOS: connector?.deviceOs) else {
                throw HTTPError.invalidResponse
            }
            projects.removeAll { $0.id == project.id }; projects.append(project)
            workspace = project.workspacePath; identifyProject()
            onProjectResolved?(project)
        } catch {
            if isValid { self.error = error.localizedDescription }
            return nil
        }
        let submission = NewSessionSubmission(project: project, runtime: runtime, text: text, attachments: files)
        draft.clear(); saveDraft()
        var completed = false
        defer {
            if !completed, isValid {
                let failure = V2ClientFailure(kind: .unavailable, message: error ?? String(localized: "未能完成创建，请检查设备连接和运行选项。"))
                submission.pending.update(creationUncertain ? .uncertain(failure) : .rejected(failure))
                onFailed?(submission)
                if draft.text.isEmpty, draft.attachments.isEmpty { draft.text = text; draft.attachments = files }
            }
        }
        await onStaged?(submission)
        guard isValid, !Task.isCancelled else { return nil }
        let target = (project.connectorId, runtime.id, project.id)
        let chosenSelections = settings.selections
        await prepareTarget()
        guard isValid, !Task.isCancelled, prepared != nil, connectorID == target.0, runtimeID == target.1,
              connector?.status == .online, network.availability != .offline else { return nil }
        guard settings.hasValidSelections, chosenSelections == settings.selections else {
            error = String(localized: "可用选项已变化，请检查模型和权限后再次发送。")
            return nil
        }
        var didSubmit = false
        do {
            guard isValid, !Task.isCancelled, projectID == target.2,
                  let current = self.project, current.connectorId == target.0,
                  current.workspacePath == project.workspacePath,
                  network.availability != .offline, connector?.status == .online else {
                error = String(localized: "项目或设备状态已变化，请检查运行目标后再次发送。草稿已保留。")
                return nil
            }
            didSubmit = true
            let response = try await creation.createAndStart(connectorId: connectorID, projectId: project.id, runtime: runtime.runtimeType,
                runtimeId: runtime.id, title: nil, cwd: project.workspacePath,
                content: text, selections: settings.selections, attachments: files.map(\.local),
                clientMessageId: submission.pending.id)
            guard isValid else { return nil }
            completed = true
            onBound?(submission, response)
            return response.session
        } catch {
            guard isValid else { return nil }
            creationUncertain = didSubmit && !V2ClientFailure.isDefiniteWriteRejection(error)
            self.error = creationUncertain
                ? String(localized: "创建结果尚未确认。请先检查会话列表，避免重复创建。草稿已保留。\n\(error.localizedDescription)")
                : error.localizedDescription
            return nil
        }
    }

    func restoreCreationDraft(meta: V2SessionMeta, pending: V2PendingMessage) {
        guard isValid, !isCreating else { return }
        if (!draft.text.isEmpty || !draft.attachments.isEmpty),
           draft.text != pending.content || draft.attachments.map(\.id) != pending.attachments.map(\.id) {
            error = String(localized: "新会话中已有其他草稿，已为你保留。请先处理该草稿，再返回这条发送记录。")
            return
        }
        focusDevice(meta.connectorId, workspace: meta.cwd)
        if let project = meta.projectId { _ = selectProject(project) }
        runtimeID = meta.effectiveRuntimeId
        draft.text = pending.content; draft.attachments = pending.attachments
        if case .uncertain = pending.delivery { creationUncertain = true }
        error = creationUncertain ? String(localized: "请先检查会话列表，确认上次创建结果后再发送。") : nil
        saveDraft()
    }

    /// Explicitly reviewed by the user. Network recovery alone never retries creation.
    func acknowledgeUncertainCreation() { creationUncertain = false; error = nil }

    func invalidate() {
        isValid = false; preparationVersion += 1; prepared = nil
        inventoryTasks.values.forEach { $0.cancel() }; inventoryTasks = [:]
        homeTasks.values.forEach { $0.cancel() }; homeTasks = [:]
        draft.invalidate(); inventories = [:]; settings.replace(.init()); error = nil
    }

    private var targetKey: String { connectorID + "\u{1f}" + runtimeID }
    private var savedSelections: [V2RuntimeSelectionScope: V2SelectionID] {
        Dictionary(uniqueKeysWithValues: (preference.selections[targetKey] ?? [:]).map { (V2RuntimeSelectionScope(rawValue: $0.key), $0.value) })
    }
    func saveDraft() { preference.draftText = draft.text; persist() }

    private func persist() {
        if let data = try? JSONEncoder().encode(preference) { defaults.set(data, forKey: preferenceKey) }
    }
}

extension V2DeviceRuntime {
    var isReadyForSession: Bool { configured && active && available && status == .running }
    var sessionUnavailableReason: String? {
        if !configured { return String(localized: "尚未配置") }
        if !active { return String(localized: "未启用，请在设备管理中启动") }
        if let reason, !reason.isEmpty { return reason }
        if status != .running { return String(localized: "尚未就绪 · \(status.displayName)") }
        return available ? nil : String(localized: "当前不可用")
    }
    var sessionDisplayName: String { name.isEmpty ? displayName : name }
}
