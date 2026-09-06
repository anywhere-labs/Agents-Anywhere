import Foundation
import Observation

struct NewSessionPreference: Codable {
    var connectorID = ""
    var runtimeID = ""
    var workspaces: [String: String] = [:] // Legacy directory preference, used only to match an existing project.
    var projectIDs: [String: String]? = nil
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
    @ObservationIgnored private let devices: V2DeviceManagementService
    @ObservationIgnored private let preparation: V2SessionPreparationService
    @ObservationIgnored private let creation: V2SessionCreationService
    @ObservationIgnored private let projectAPI: V2ProjectAPI
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let preferenceKey: String
    @ObservationIgnored private var preference: NewSessionPreference
    @ObservationIgnored private var preparationVersion = 0
    @ObservationIgnored private var inventoryTasks: [String: Task<[V2DeviceRuntime], Error>] = [:]

    init(scope: V2ClientScope, devices: V2DeviceManagementService,
         preparation: V2SessionPreparationService, creation: V2SessionCreationService, projectAPI: V2ProjectAPI,
         defaults: UserDefaults = .standard) {
        self.projectAPI = projectAPI
        self.devices = devices; self.preparation = preparation; self.creation = creation; self.defaults = defaults
        preferenceKey = "aa.native.new-session.v1." + Data((scope.serverURL.absoluteString + "\n" + scope.accountID).utf8).base64EncodedString()
        preference = defaults.data(forKey: preferenceKey).flatMap { try? JSONDecoder().decode(NewSessionPreference.self, from: $0) } ?? .init()
        connectorID = preference.connectorID; runtimeID = preference.runtimeID
        projectID = preference.projectIDs?[preference.connectorID]
    }

    var connector: V2Connector? { connectors.first { $0.id == connectorID } }
    var runtime: V2DeviceRuntime? { inventories[connectorID]?.first { $0.id == runtimeID } }
    var project: V2Project? { projects.first { $0.id == projectID && $0.connectorId == connectorID } }
    var workspace: String { project?.workspacePath ?? "" }
    var availableProjects: [V2Project] { projects.filter { $0.connectorId == connectorID }.sorted { $0.name < $1.name } }

    func updateProjects(_ values: [V2Project]) {
        guard isValid else { return }
        projects = values; hasLoadedProjects = true
        // A removed selection stays unresolved; never silently send a draft to a different project.
        if let projectID, !values.contains(where: { $0.id == projectID && $0.connectorId == connectorID }) {
            self.projectID = nil
            error = "原来选择的项目已不可用，请重新选择。草稿已保留。"
        }
    }

    @discardableResult func selectProject(_ id: String) -> Bool {
        guard !isCreating, isValid, let value = projects.first(where: { $0.id == id }) else { return false }
        if connectorID != value.connectorId { focusDevice(value.connectorId, workspace: nil) }
        projectID = id
        var saved = preference.projectIDs ?? [:]; saved[connectorID] = id; preference.projectIDs = saved
        preference.connectorID = connectorID
        persist()
        return true
    }

    private func restoreProjectForDevice() {
        if let saved = preference.projectIDs?[connectorID], projects.contains(where: { $0.id == saved && $0.connectorId == connectorID }) {
            projectID = saved
        } else if let path = preference.workspaces[connectorID], let match = availableProjects.first(where: { $0.workspacePath == path }) {
            projectID = match.id
        } else { projectID = nil }
    }
    var canAttach: Bool { prepared?.capabilities.allows("runtime.attachment") == true }
    var canCreate: Bool {
        isValid && !isCreating && !isPreparing && !creationUncertain && network.availability != .offline
            && project != nil && connector?.status == .online && runtime?.isReadyForSession == true && prepared != nil
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
        if let workspace, let match = availableProjects.first(where: { $0.workspacePath == workspace }) { projectID = match.id }
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
        await loadInventory(device)
        guard isValid, connectorID == device else { return }
        let available = inventories[device] ?? []
        if !available.contains(where: { $0.id == runtimeID }) {
            let saved = preference.connectorID == device ? preference.runtimeID : ""
            runtimeID = available.first { $0.id == saved && $0.isReadyForSession }?.id
                ?? available.first { $0.isReadyForSession }?.id ?? ""
        }
        await prepareTarget()
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
        await prepareTarget()
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
                error = value.runtime.sessionUnavailableReason ?? "Agent 尚未就绪"
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
        guard canCreate, let runtime, let project else { return nil }
        draft.text = text
        guard draft.canAttemptSend else { return nil }
        let files = draft.attachments
        isCreating = true; error = nil
        saveSelections()
        defer { isCreating = false }
        let target = (connectorID, runtimeID, project.id)
        let chosenSelections = settings.selections
        await prepareTarget()
        guard isValid, !Task.isCancelled, prepared != nil, connectorID == target.0, runtimeID == target.1,
              connector?.status == .online, network.availability != .offline else { return nil }
        guard settings.hasValidSelections, chosenSelections == settings.selections else {
            error = "可用选项已变化，请检查模型和权限后再次发送。"
            return nil
        }
        var didSubmit = false
        do {
            // Project deletion/rebinding may happen on another client while the composer is open.
            let latest = try await projectAPI.list()
            updateProjects(latest.projects)
            guard isValid, !Task.isCancelled, projectID == target.2,
                  let current = self.project, current.connectorId == target.0,
                  current.workspacePath == project.workspacePath,
                  network.availability != .offline, connector?.status == .online else {
                error = "项目或设备状态已变化，请检查运行目标后再次发送。草稿已保留。"
                return nil
            }
            didSubmit = true
            let response = try await creation.createAndStart(connectorId: connectorID, projectId: project.id, runtime: runtime.runtimeType,
                runtimeId: runtime.id, title: nil, cwd: project.workspacePath,
                content: text, selections: settings.selections, attachments: files.map(\.local),
                clientMessageId: UUID().uuidString)
            guard isValid else { return nil }
            if draft.text == text, draft.attachments.map(\.id) == files.map(\.id) { draft.clear() }
            return response.session
        } catch {
            guard isValid else { return nil }
            creationUncertain = didSubmit && !V2ClientFailure.isDefiniteWriteRejection(error)
            self.error = creationUncertain
                ? "创建结果尚未确认。请先检查会话列表，避免重复创建。草稿已保留。\n\(error.localizedDescription)"
                : error.localizedDescription
            return nil
        }
    }

    /// Explicitly reviewed by the user. Network recovery alone never retries creation.
    func acknowledgeUncertainCreation() { creationUncertain = false; error = nil }

    func invalidate() {
        isValid = false; preparationVersion += 1; prepared = nil
        inventoryTasks.values.forEach { $0.cancel() }; inventoryTasks = [:]
        draft.invalidate(); inventories = [:]; settings.replace(.init()); error = nil
    }

    private var targetKey: String { connectorID + "\u{1f}" + runtimeID }
    private var savedSelections: [V2RuntimeSelectionScope: V2SelectionID] {
        Dictionary(uniqueKeysWithValues: (preference.selections[targetKey] ?? [:]).map { (V2RuntimeSelectionScope(rawValue: $0.key), $0.value) })
    }
    private func persist() {
        if let data = try? JSONEncoder().encode(preference) { defaults.set(data, forKey: preferenceKey) }
    }
}

extension V2DeviceRuntime {
    var isReadyForSession: Bool { configured && active && available && status == .running }
    var sessionUnavailableReason: String? {
        if !configured { return "尚未配置" }
        if !active { return "未启用，请在设备管理中启动" }
        if let reason, !reason.isEmpty { return reason }
        if status != .running { return "尚未就绪 · \(status.rawValue)" }
        return available ? nil : "当前不可用"
    }
    var sessionDisplayName: String { name.isEmpty ? displayName : name }
}
