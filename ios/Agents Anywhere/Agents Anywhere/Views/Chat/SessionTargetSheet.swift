import SwiftUI

struct SessionTargetSheet: View {
    @Bindable var model: NewSessionModel
    @State private var expandedDeviceID: String?
    @State private var applying: TargetSelection?
    @State private var selectionError: String?
    @Environment(\.dismiss) private var dismiss

    private var devices: [V2Connector] {
        model.connectors.sorted {
            ($0.status == .online ? 0 : 1, $0.name, $0.id) < ($1.status == .online ? 0 : 1, $1.name, $1.id)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if devices.isEmpty {
                    ContentUnavailableView(String(localized: "No devices"), appSymbol: "desktopcomputer")
                }
                Section {
                    ForEach(devices) { device in
                        InlineSelectionGroup(title: device.name, detail: deviceDetail(device),
                            isSelected: model.connectorID == device.id,
                            isExpanded: Binding(get: { expandedDeviceID == device.id }, set: { expandedDeviceID = $0 ? device.id : nil })) {
                            agents(on: device)
                        }
                        .task(id: TargetInventoryKey(id: device.id, isExpanded: expandedDeviceID == device.id, connected: connected(device))) {
                            guard expandedDeviceID == device.id else { return }
                            await model.loadInventory(device.id)
                        }
                    }
                } footer: {
                    Text(String(localized: "同一种 Agent 可以有不同实例；这里显示的是设备上的实际实例名称。"))
                }
                if let error = selectionError ?? model.error {
                    Section { Text(error).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle(String(localized: "运行目标")).navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar(disabled: applying != nil) { dismiss() } }
            .refreshable {
                if let id = expandedDeviceID { await model.loadInventory(id) }
            }
        }
        .appSheetPresentation(.compact)
        .interactiveDismissDisabled(applying != nil)
        .disabled(applying != nil)
    }

    @ViewBuilder private func agents(on device: V2Connector) -> some View {
        let inventory = instances(on: device.id)
        let loading = model.loadingDevices.contains(device.id)
        let error = model.inventoryErrors[device.id]
        if loading || (connected(device) && model.inventories[device.id] == nil && error == nil) {
            ProgressView(String(localized: "正在检查 Agent…"))
        } else if inventory.isEmpty, error == nil, connected(device) {
            Text(String(localized: "这台设备尚无已配置的 Agent。")).font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(inventory) { runtime in
            InlineSelectionButton(title: runtime.sessionDisplayName, detail: runtime.sessionUnavailableReason,
                isSelected: model.connectorID == device.id && model.runtimeID == runtime.id,
                isWorking: applying == TargetSelection(connectorID: device.id, runtimeID: runtime.id)) {
                apply(device: device, runtime: runtime)
            }
            .disabled(!connected(device) || !runtime.isReadyForSession || !model.isValid || model.isCreating)
        }
        if !connected(device) {
            Text(model.network.availability == .offline ? String(localized: "手机网络已断开") : String(localized: "目标设备离线"))
                .font(.footnote).foregroundStyle(.secondary)
        }
        if let error {
            Text(error).font(.footnote).foregroundStyle(.secondary)
            Button(String(localized: "重新加载")) { Task { await model.loadInventory(device.id) } }
                .disabled(!connected(device) || loading)
        }
    }

    private func connected(_ device: V2Connector) -> Bool {
        device.status == .online && model.network.availability != .offline
    }
    private func deviceDetail(_ device: V2Connector) -> String {
        let status = model.network.availability == .offline ? String(localized: "手机网络已断开") :
            device.status == .online ? String(localized: "Online") : String(localized: "Offline")
        return [device.deviceOs, status].compactMap { $0 }.joined(separator: " · ")
    }
    private func instances(on id: String) -> [V2DeviceRuntime] {
        (model.inventories[id] ?? []).sorted {
            ($0.isReadyForSession ? 0 : 1, $0.sessionDisplayName, $0.id) < ($1.isReadyForSession ? 0 : 1, $1.sessionDisplayName, $1.id)
        }
    }
    private func apply(device: V2Connector, runtime: V2DeviceRuntime) {
        guard applying == nil, connected(device), runtime.isReadyForSession else { return }
        let target = TargetSelection(connectorID: device.id, runtimeID: runtime.id)
        applying = target; selectionError = nil
        Task { @MainActor in
            let accepted = await model.selectTarget(connectorID: target.connectorID, runtimeID: target.runtimeID)
            applying = nil
            if accepted { dismiss() }
            else { selectionError = model.error ?? String(localized: "当前设置未保存，请稍后重试。") }
        }
    }
}

private struct TargetSelection: Equatable { let connectorID: String; let runtimeID: String }
private struct TargetInventoryKey: Equatable { let id: String; let isExpanded: Bool; let connected: Bool }
