import SwiftUI

struct SessionTargetSheet: View {
    @Bindable var model: NewSessionModel
    let onManageDevice: (String) -> Void
    @State private var path: [String] = []
    @State private var applying = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(model.connectors.sorted { ($0.status == .online ? 0 : 1, $0.name) < ($1.status == .online ? 0 : 1, $1.name) }) { device in
                        NavigationLink(value: device.id) {
                            HStack(spacing: 14) {
                                Image(systemName: device.deviceOs?.lowercased().contains("linux") == true ? "server.rack" : "desktopcomputer")
                                    .font(.title3).foregroundStyle(.primary).frame(width: 30)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(device.name).font(.headline)
                                    Text(device.status == .online ? "在线 · 选择此设备上的 Agent" : "离线 · 可查看上次的实例")
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 4)
                                if device.id == model.connectorID { Image(systemName: "checkmark").foregroundStyle(.primary) }
                            }
                            .padding(.vertical, 8)
                        }
                    }
                } header: { Text("1 · 选择设备") } footer: {
                    Text("接下来选择这台设备上的 Agent。选完后才会更改当前运行目标。")
                }
                if model.connectors.isEmpty {
                    ContentUnavailableView("没有设备", systemImage: "desktopcomputer", description: Text("请先从侧栏添加并连接设备。"))
                }
            }
            .navigationTitle("运行目标")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .navigationDestination(for: String.self) { deviceID in agents(on: deviceID) }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(applying)
        .disabled(applying)
    }

    private func agents(on deviceID: String) -> some View {
        let device = model.connectors.first { $0.id == deviceID }
        let connected = device?.status == .online && model.network.availability != .offline
        let instances = (model.inventories[deviceID] ?? []).sorted {
            ($0.isReadyForSession ? 0 : 1, $0.sessionDisplayName) < ($1.isReadyForSession ? 0 : 1, $1.sessionDisplayName)
        }
        return List {
            Section {
                Label(device?.name ?? "设备已移除", systemImage: "desktopcomputer")
                if !connected {
                    Label(model.network.availability == .offline ? "手机网络已断开" : "设备离线", systemImage: "wifi.slash")
                        .foregroundStyle(.secondary)
                    Text("连接恢复前无法应用新目标。返回不会更改原来的选择。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                ForEach(instances) { runtime in
                    Button {
                        applying = true
                        Task { @MainActor in
                            let applied = await model.selectTarget(connectorID: deviceID, runtimeID: runtime.id)
                            applying = false
                            if applied { dismiss() }
                        }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "sparkle").font(.title3).foregroundStyle(.primary).frame(width: 30)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(runtime.sessionDisplayName).font(.headline).foregroundStyle(.primary)
                                Text(runtime.typeDisplayName).font(.subheadline).foregroundStyle(.secondary)
                                if let reason = runtime.sessionUnavailableReason {
                                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 8)
                            if deviceID == model.connectorID && runtime.id == model.runtimeID {
                                Image(systemName: "checkmark").foregroundStyle(.primary)
                            }
                        }
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .disabled(!connected || !runtime.isReadyForSession || applying)
                }
                if model.loadingDevices.contains(deviceID) { ProgressView("正在检查 Agent…") }
                if instances.isEmpty && !model.loadingDevices.contains(deviceID) {
                    Text("这台设备尚无已配置的 Agent。")
                        .foregroundStyle(.secondary)
                }
                if let error = model.inventoryErrors[deviceID] {
                    Text(error).font(.footnote).foregroundStyle(.secondary)
                    Button("重新加载") { Task { await model.loadInventory(deviceID) } }.disabled(!connected)
                }
            } header: { Text("2 · 选择 Agent 实例") } footer: {
                Text("同一种 Agent 可以有不同实例；这里显示的是设备上的实际实例名称。")
            }
            Section {
                Button("管理这台设备", systemImage: "slider.horizontal.3") { onManageDevice(deviceID) }
            }
        }
        .navigationTitle("选择 Agent")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: TargetInventoryKey(id: deviceID, connected: connected)) { await model.loadInventory(deviceID) }
        .refreshable { await model.loadInventory(deviceID) }
    }
}

private struct TargetInventoryKey: Equatable { let id: String; let connected: Bool }

struct SessionWorkspaceSheet: View {
    let model: NewSessionModel
    let recent: [V2DeviceWorkspace]
    @State private var path = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(model.connector?.name ?? "设备", systemImage: "desktopcomputer")
                    TextField("例如 /Users/me/projects/app", text: $path)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("设备上的工作目录") } footer: {
                    Text("留空时使用 Agent 的默认目录。这里填写的是远程设备路径。")
                }
                Section {
                    Button("使用默认目录") { model.setWorkspace(""); dismiss() }
                }
                if !recent.isEmpty {
                    Section("最近的工作目录") {
                        ForEach(recent) { workspace in
                            Button {
                                model.setWorkspace(workspace.path); dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(workspace.name).foregroundStyle(.primary)
                                    Text(workspace.path).font(.footnote).foregroundStyle(.secondary)
                                }.padding(.vertical, 5)
                            }
                        }
                    }
                }
            }
            .navigationTitle("工作目录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { model.setWorkspace(path); dismiss() } }
            }
            .onAppear { path = model.workspace }
        }
        .presentationDetents([.large])
    }
}
