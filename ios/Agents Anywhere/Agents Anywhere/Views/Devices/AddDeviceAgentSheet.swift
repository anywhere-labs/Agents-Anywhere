import SwiftUI

struct AddDeviceAgentSheet: View {
    @Bindable var model: DeviceAgentModel
    @Environment(\.dismiss) private var dismiss
    @State private var configuration: Configuration?
    @State private var schemaError: String?

    private struct Configuration: Identifiable {
        let type: V2RuntimeType
        let schema: V2RuntimeConfigSchema
        var id: String { type.id }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !model.connected {
                        Label(String(localized: "设备或网络已离线，连接恢复后可继续。"), appSymbol: "wifi.slash")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(model.addableTypes) { type in
                        agentCard(type)
                    }
                    if model.addableTypes.isEmpty && !model.isLoading {
                        Text(model.inventory.types.isEmpty
                             ? String(localized: "尚未发现可用 Agent。在设备上安装并登录 Agent 后，重新发现即可添加。")
                             : String(localized: "当前可用的 Agent 都已添加。安装其他 Agent 后，可以重新发现。"))
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }.padding(20)
            }
            .navigationTitle(String(localized: "添加 Agent")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { AgentRediscoveryButton(model: model) }
                SheetCloseToolbar(disabled: model.busyID != nil) { dismiss() }
            }
        }
        .appSheetPresentation(.compact)
        .interactiveDismissDisabled(model.busyID != nil)
        .sheet(item: $configuration, onDismiss: model.dismissError) { item in
            RuntimeConfigurationSheet(type: item.type, schema: item.schema, suggestedName: suggestedName(item.type), canSave: model.connected) { name, config in
                try await model.add(item.type, name: name, config: config, newInstance: true)
            }
        }
        .alert(String(localized: "无法添加 Agent"), isPresented: Binding(
            get: { configuration == nil && (schemaError != nil || model.error != nil) },
            set: { if !$0 { schemaError = nil; model.dismissError() } }
        )) {
            Button(String(localized: "好"), role: .cancel) { schemaError = nil; model.dismissError() }
        } message: { Text(schemaError ?? model.error ?? "") }
    }

    private func agentCard(_ type: V2RuntimeType) -> some View {
        let hasInstance = model.inventory.configuredInstances.contains { $0.runtimeType == type.runtimeType }
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(type.displayName).font(.headline)
                if type.recommended { Text(String(localized: "推荐")).font(.caption).foregroundStyle(.secondary) }
                Spacer()
            }
            if let description = type.reason ?? type.description, !description.isEmpty {
                Text(description).font(.footnote).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                AppGlassButton(hasInstance ? String(localized: "添加实例") : String(localized: "添加"), systemImage: "plus", style: .prominent,
                    isLoading: model.busyID == type.id, disabled: !model.connected || model.busyID != nil) {
                    if hasInstance { configure(type) }
                    else { Task { try? await model.add(type, name: nil, config: [:]) } }
                }
                if !hasInstance {
                    AppGlassButton(String(localized: "配置后添加"), disabled: !model.connected || model.busyID != nil) { configure(type) }
                }
            }
        }.padding(16).background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 18))
    }

    private func configure(_ type: V2RuntimeType) {
        do { configuration = .init(type: type, schema: try model.schema(type).forNamedInstance()) }
        catch { schemaError = error.localizedDescription }
    }

    private func suggestedName(_ type: V2RuntimeType) -> String {
        let names = Set(model.inventory.instances.map { $0.name.lowercased() })
        var name = type.displayName
        var suffix = 2
        while names.contains(name.lowercased()) { name = "\(type.displayName) \(suffix)"; suffix += 1 }
        return name
    }
}
