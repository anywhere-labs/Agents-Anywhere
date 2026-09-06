import SwiftUI

struct DeviceAgentSection: View {
    @Bindable var model: DeviceAgentModel
    @State private var configuration: Configuration?
    @State private var deleting: V2DeviceRuntime?
    @State private var renaming: V2DeviceRuntime?
    @State private var proposedName = ""
    @State private var schemaError: String?

    private enum Configuration: Identifiable {
        case instance(V2DeviceRuntime, V2RuntimeConfigSchema)
        case addition(V2RuntimeType, V2RuntimeConfigSchema)
        var id: String {
            switch self { case .instance(let item, _): "instance:" + item.id; case .addition(let item, _): "type:" + item.id }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Agent").font(.headline)
                Spacer()
                Button("重新发现", systemImage: "arrow.clockwise") { Task { await model.refresh(discover: true) } }
                    .font(.subheadline).disabled(!model.connected || model.isLoading || model.busyID != nil)
            }
            if !model.connected {
                Label("设备或网络已离线，连接恢复后可继续。", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if model.isLoading { ProgressView("正在检查 Agent…").font(.footnote) }
            ForEach(model.inventory.configuredInstances) { runtime in
                VStack(alignment: .leading, spacing: 8) {
                    Toggle(isOn: Binding(get: { runtime.active }, set: { active in
                        Task { try? await model.setActive(runtime, active) }
                    })) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(runtime.sessionDisplayName).font(.headline)
                            Text(runtime.sessionUnavailableReason ?? "已就绪")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }.disabled(!model.connected || model.busyID != nil)
                    HStack {
                        Text(runtime.typeDisplayName).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if model.busyID == runtime.id { ProgressView().controlSize(.small) }
                        Button("配置", systemImage: "slider.horizontal.3") {
                            do { configuration = .instance(runtime, try model.schema(runtime)) }
                            catch { schemaError = error.localizedDescription }
                        }.font(.subheadline).disabled(!model.connected || model.busyID != nil)
                    }
                }
                .padding(16).background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 18))
                .contextMenu {
                    Button("重命名", systemImage: "pencil") { proposedName = runtime.name; renaming = runtime }
                        .disabled(!model.connected || model.busyID != nil)
                    Button("删除配置", systemImage: "trash", role: .destructive) { deleting = runtime }
                        .disabled(!model.connected || model.busyID != nil)
                }
            }
            if !model.addableTypes.isEmpty {
                Text("可添加的 Agent").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            }
            ForEach(model.addableTypes) { type in
                let hasInstance = model.inventory.configuredInstances.contains { $0.runtimeType == type.runtimeType }
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(type.displayName).font(.headline)
                        if type.recommended { Text("推荐").font(.caption).foregroundStyle(.secondary) }
                        Spacer()
                    }
                    if let description = type.reason ?? type.description, !description.isEmpty {
                        Text(description).font(.footnote).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 12) {
                        AppGlassButton(hasInstance ? "添加实例" : "添加", systemImage: "plus", style: .prominent,
                            isLoading: model.busyID == type.id, disabled: !model.connected || model.busyID != nil) {
                            if hasInstance { configure(type) }
                            else { Task { try? await model.add(type, name: nil, config: [:]) } }
                        }
                        if !hasInstance {
                            AppGlassButton("配置后添加", disabled: !model.connected || model.busyID != nil) { configure(type) }
                        }
                    }
                }.padding(16).background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 18))
            }
            if !model.isLoading && model.inventory.types.isEmpty && model.inventory.instances.isEmpty {
                Text("尚未发现可用 Agent。在设备上安装并登录 Agent 后，重新发现即可添加。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let error = model.error ?? schemaError {
                Text(error).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .task(id: model.connected) { await model.refresh() }
        .sheet(item: $configuration) { item in
            switch item {
            case let .instance(runtime, schema):
                RuntimeConfigurationSheet(runtime: runtime, schema: schema, startAfterSaving: false) {
                    try await model.save(runtime, config: $0)
                }
            case let .addition(type, schema):
                RuntimeConfigurationSheet(type: type, schema: schema, suggestedName: suggestedName(type)) { name, config in
                    try await model.add(type, name: name, config: config, newInstance: true)
                }
            }
        }
        .alert("删除这个 Agent 的配置？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除配置", role: .destructive) {
                guard let runtime = deleting else { return }; deleting = nil
                Task { try? await model.remove(runtime) }
            }
        }
        .alert("重命名 Agent", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("实例名称", text: $proposedName)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") {
                guard let runtime = renaming else { return }; renaming = nil
                Task { try? await model.rename(runtime, proposedName) }
            }.disabled(proposedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private func configure(_ type: V2RuntimeType) {
        do { configuration = .addition(type, try model.schema(type)) }
        catch { schemaError = error.localizedDescription }
    }
    private func suggestedName(_ type: V2RuntimeType) -> String {
        let names = Set(model.inventory.instances.map { $0.name.lowercased() })
        var name = type.displayName; var suffix = 2
        while names.contains(name.lowercased()) { name = "\(type.displayName) \(suffix)"; suffix += 1 }
        return name
    }
}

struct AgentSetupSheet: View {
    let connector: V2Connector
    let model: DeviceAgentModel
    let onFinish: () -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("添加你要使用的 Agent").font(.title2.bold())
                    Text("设备已连接。选择 Agent 后，就可以在项目中开始任务。")
                        .foregroundStyle(.secondary)
                    DeviceAgentSection(model: model)
                }.padding(22)
            }
            .navigationTitle(connector.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成", action: onFinish).disabled(model.busyID != nil)
                }
            }
        }
        .presentationDetents([.large]).interactiveDismissDisabled()
    }
}
