import SwiftUI

struct SessionTargetSheet: View {
    @Bindable var model: NewSessionModel
    let onManageDevice: (String) -> Void
    @State private var connectorID: String
    @State private var runtimeID: String
    @State private var applying = false
    @Environment(\.dismiss) private var dismiss

    init(model: NewSessionModel, onManageDevice: @escaping (String) -> Void) {
        self.model = model
        self.onManageDevice = onManageDevice
        _connectorID = State(initialValue: model.connectorID)
        _runtimeID = State(initialValue: model.runtimeID)
    }

    private var device: V2Connector? { model.connectors.first { $0.id == connectorID } }
    private var connected: Bool { device?.status == .online && model.network.availability != .offline }
    private var instances: [V2DeviceRuntime] {
        (model.inventories[connectorID] ?? []).sorted {
            ($0.isReadyForSession ? 0 : 1, $0.sessionDisplayName) < ($1.isReadyForSession ? 0 : 1, $1.sessionDisplayName)
        }
    }
    private var canApply: Bool {
        connected && instances.contains { $0.id == runtimeID && $0.isReadyForSession }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(String(localized: "设备"), selection: $connectorID) {
                        Text(String(localized: "选择设备")).tag("")
                        ForEach(model.connectors.sorted { ($0.status == .online ? 0 : 1, $0.name) < ($1.status == .online ? 0 : 1, $1.name) }) { device in
                            Text(verbatim: device.name).tag(device.id)
                        }
                    }.pickerStyle(.navigationLink)
                } footer: {
                    if !connected {
                        Text(model.network.availability == .offline ? String(localized: "手机网络已断开") : String(localized: "目标设备离线"))
                    }
                }
                Section {
                    Picker(String(localized: "Agent"), selection: $runtimeID) {
                        Text(String(localized: "选择 Agent")).tag("")
                        ForEach(instances) { runtime in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(verbatim: runtime.sessionDisplayName)
                                if let reason = runtime.sessionUnavailableReason {
                                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                                }
                            }.tag(runtime.id).disabled(!runtime.isReadyForSession)
                        }
                    }.pickerStyle(.navigationLink).disabled(device == nil || instances.isEmpty)
                    if model.loadingDevices.contains(connectorID) {
                        ProgressView(String(localized: "正在检查 Agent…"))
                    } else if instances.isEmpty {
                        Text(String(localized: "这台设备尚无已配置的 Agent。")).foregroundStyle(.secondary)
                    }
                    if let error = model.inventoryErrors[connectorID] {
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                        Button(String(localized: "重新加载")) { Task { await loadInstances() } }.disabled(!connected)
                    }
                } footer: {
                    Text(String(localized: "同一种 Agent 可以有不同实例；这里显示的是设备上的实际实例名称。"))
                }
                if device != nil {
                    Section {
                        Button(String(localized: "管理这台设备"), appSymbol: "slider.horizontal.3") { onManageDevice(connectorID) }
                    }
                }
                if let error = model.error {
                    Section { Text(error).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle(String(localized: "运行目标")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetEditorToolbar(saveTitle: String(localized: "Done"), isWorking: applying, saveDisabled: !canApply,
                    onCancel: { dismiss() }, onSave: apply)
            }
            .onChange(of: connectorID) { _, id in runtimeID = id == model.connectorID ? model.runtimeID : "" }
            .task(id: TargetInventoryKey(id: connectorID, connected: connected)) { await loadInstances() }
            .refreshable { await loadInstances() }
        }
        .appSheetPresentation(.compact)
        .interactiveDismissDisabled(applying)
        .disabled(applying)
    }

    private func loadInstances() async {
        guard device != nil else { return }
        let requestedID = connectorID
        await model.loadInventory(requestedID)
        guard !Task.isCancelled, connectorID == requestedID, runtimeID.isEmpty else { return }
        runtimeID = instances.first(where: \.isReadyForSession)?.id ?? ""
    }
    private func apply() {
        guard canApply, !applying else { return }
        applying = true
        Task { @MainActor in
            let applied = await model.selectTarget(connectorID: connectorID, runtimeID: runtimeID)
            applying = false
            if applied { dismiss() }
        }
    }
}

private struct TargetInventoryKey: Equatable { let id: String; let connected: Bool }
