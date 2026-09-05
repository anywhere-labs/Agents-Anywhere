import Foundation
import Observation

struct NewSessionPreference: Codable {
    var connectorID = ""
    var runtimeID = ""
    var workspaces: [String: String] = [:]
    var selections: [String: [String: String]] = [:]
}

/// Account-scoped draft and target selection. A target is committed only after
/// both the device and its configured Agent instance have been chosen.
@MainActor @Observable
final class NewSessionModel {
    let draft = ComposerDraft()
    let settings = ConversationSettings()
    private(set) var connectors: [V2Connector] = []
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
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let preferenceKey: String
    @ObservationIgnored private var preference: NewSessionPreference
    @ObservationIgnored private var preparationVersion = 0

    init(scope: V2ClientScope, devices: V2DeviceManagementService,
         preparation: V2SessionPreparationService, creation: V2SessionCreationService,
         defaults: UserDefaults = .standard) {
        self.devices = devices; self.preparation = preparation; self.creation = creation; self.defaults = defaults
        preferenceKey = "aa.native.new-session.v1." + Data((scope.serverURL.absoluteString + "\n" + scope.accountID).utf8).base64EncodedString()
        preference = defaults.data(forKey: preferenceKey).flatMap { try? JSONDecoder().decode(NewSessionPreference.self, from: $0) } ?? .init()
        connectorID = preference.connectorID; runtimeID = preference.runtimeID
    }

    var connector: V2Connector? { connectors.first { $0.id == connectorID } }
    var runtime: V2DeviceRuntime? { inventories[connectorID]?.first { $0.id == runtimeID } }
    var workspace: String {
        _ = workspaceRevision
        return preference.workspaces[connectorID] ?? ""
    }
    var canAttach: Bool { prepared?.capabilities.allows("runtime.attachment") == true }
    var canCreate: Bool {
        isValid && !isCreating && !isPreparing && !creationUncertain && network.availability != .offline
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
        if let workspace { setWorkspace(workspace) }
    }

    func refresh(connectors: [V2Connector]) async {
        guard isValid else { return }
        self.connectors = connectors
        if !connectors.isEmpty, !connectors.contains(where: { $0.id == connectorID }) {
            connectorID = connectors.first { $0.id == preference.connectorID }?.id
                ?? connectors.first { $0.status == .online }?.id ?? connectors.first?.id ?? ""
            runtimeID = ""
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
              connectors.contains(where: { $0.id == deviceID && $0.status == .online }),
              !loadingDevices.contains(deviceID) else { return }
        loadingDevices.insert(deviceID); inventoryErrors[deviceID] = nil
        defer { loadingDevices.remove(deviceID) }
        do {
            let runtimes = try await devices.runtimes(connectorId: deviceID)
            guard isValid, !Task.isCancelled else { return }
            inventories[deviceID] = runtimes.filter(\.configured)
        } catch { if isValid { inventoryErrors[deviceID] = error.localizedDescription } }
    }

    @discardableResult func selectTarget(connectorID: String, runtimeID: String) async -> Bool {
        guard !isCreating, isValid, connectors.contains(where: { $0.id == connectorID && $0.status == .online }),
              inventories[connectorID]?.contains(where: { $0.id == runtimeID && $0.isReadyForSession }) == true else { return false }
        saveSelections()
        self.connectorID = connectorID; self.runtimeID = runtimeID
        preference.connectorID = connectorID; preference.runtimeID = runtimeID
        persist()
        await prepareTarget()
        return true
    }

    func prepareTarget() async {
        preparationVersion += 1
        let version = preparationVersion
        prepared = nil; error = nil
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

    func setWorkspace(_ path: String) {
        guard !isCreating else { return }
        preference.workspaces[connectorID] = path.trimmingCharacters(in: .whitespacesAndNewlines)
        persist()
        // Preference is non-observable; announce the target summary's new value.
        workspaceRevision += 1
    }
    private(set) var workspaceRevision = 0

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
        defer { isCreating = false }
        do {
            let response = try await creation.createAndStart(connectorId: connectorID, runtime: runtime.runtimeType,
                runtimeId: runtime.id, title: nil, cwd: workspace.isEmpty ? nil : workspace,
                content: text, selections: settings.selections, attachments: files.map(\.local),
                clientMessageId: UUID().uuidString)
            guard isValid else { return nil }
            if draft.text == text, draft.attachments.map(\.id) == files.map(\.id) { draft.clear() }
            return response.session
        } catch {
            guard isValid else { return nil }
            creationUncertain = !V2ClientFailure.isDefiniteWriteRejection(error)
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
        draft.clear(); inventories = [:]; settings.replace(.init()); error = nil
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
