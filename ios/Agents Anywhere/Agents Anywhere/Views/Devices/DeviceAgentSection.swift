import SwiftUI

struct DeviceAgentSection: View {
    @Bindable var model: DeviceAgentModel
    var showsConnectionNotice = true
    var onError: ((String?) -> Void)?
    @State private var configuration: Configuration?
    @State private var showsAddAgents = false
    @State private var deleting: V2DeviceRuntime?
    @State private var renaming: V2DeviceRuntime?
    @State private var proposedName = ""
    @State private var schemaError: String?

    private struct Configuration: Identifiable {
        let runtime: V2DeviceRuntime
        let schema: V2RuntimeConfigSchema
        var id: String { runtime.id }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(String(localized: "Agent")).font(.headline)
                Spacer()
                AgentRediscoveryButton(model: model)
            }
            if showsConnectionNotice && !model.connected {
                Label(String(localized: "设备或网络已离线，连接恢复后可继续。"), appSymbol: "wifi.slash")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(model.inventory.configuredInstances) { runtime in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(runtime.sessionDisplayName).font(.headline)
                        Text(String(localized: "\(runtime.typeDisplayName) · \(runtime.sessionUnavailableReason ?? String(localized: "已就绪"))"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 10) {
                        AppGlassButton(systemImage: "slider.horizontal.3", isLoading: model.busyID == runtime.id,
                            disabled: !model.connected || model.busyID != nil, maxWidth: nil) {
                            do { configuration = .init(runtime: runtime, schema: try model.schema(runtime)) }
                            catch { schemaError = error.localizedDescription }
                        }
                        .accessibilityLabel(Text(String(localized: "配置 \(runtime.sessionDisplayName)")))
                        Toggle(String(localized: "启用 \(runtime.sessionDisplayName)"), isOn: Binding(get: { runtime.active }, set: { active in
                            Task { try? await model.setActive(runtime, active) }
                        }))
                        .labelsHidden().toggleStyle(.switch).tint(.green).fixedSize()
                        .disabled(!model.connected || model.busyID != nil)
                    }
                }
                .padding(16).background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 18))
                .contextMenu {
                    Button(String(localized: "重命名"), appSymbol: "pencil") { proposedName = runtime.name; renaming = runtime }
                        .disabled(!model.connected || model.busyID != nil)
                    Button(String(localized: "删除配置"), appSymbol: "trash", role: .destructive) { deleting = runtime }
                        .disabled(!model.connected || model.busyID != nil)
                }
            }
            AppGlassButton(String(localized: "添加更多 Agent"), systemImage: "plus", style: .prominent) {
                showsAddAgents = true
            }
        }
        .task(id: model.connected) { await model.refresh() }
        .sheet(isPresented: $showsAddAgents) { AddDeviceAgentSheet(model: model) }
        .sheet(item: $configuration, onDismiss: model.dismissError) { item in
            RuntimeConfigurationSheet(runtime: item.runtime, schema: item.schema, startAfterSaving: false, canSave: model.connected) {
                try await model.save(item.runtime, config: $0)
            }
        }
        .alert(String(localized: "删除这个 Agent 的配置？"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button(String(localized: "取消"), role: .cancel) { deleting = nil }
            Button(String(localized: "删除配置"), role: .destructive) {
                guard let runtime = deleting else { return }; deleting = nil
                Task { try? await model.remove(runtime) }
            }
        }
        .alert(String(localized: "重命名 Agent"), isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(String(localized: "实例名称"), text: $proposedName)
            Button(String(localized: "取消"), role: .cancel) { renaming = nil }
            Button(String(localized: "保存")) {
                guard let runtime = renaming else { return }; renaming = nil
                Task { try? await model.rename(runtime, proposedName) }
            }.disabled(proposedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .alert(String(localized: "Agent 操作未完成"), isPresented: Binding(
            get: { onError == nil && currentError != nil },
            set: { if !$0 { schemaError = nil; model.dismissError() } }
        )) {
            Button(String(localized: "好"), role: .cancel) { schemaError = nil; model.dismissError() }
        } message: { Text(schemaError ?? model.error ?? "") }
        .onChange(of: currentError, initial: true) { _, error in onError?(error) }
    }
    private var currentError: String? {
        !showsAddAgents && configuration == nil ? schemaError ?? model.error : nil
    }
}

struct AgentRediscoveryButton: View {
    let model: DeviceAgentModel

    var body: some View {
        Button { Task { await model.refresh(discover: true) } } label: {
            AppSymbol("arrow.clockwise")
                .opacity(model.isLoading ? 0 : 1)
                .overlay {
                    if model.isLoading { ProgressView().controlSize(.small).tint(.primary) }
                }
                .frame(width: 44, height: 44).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!model.connected || model.isLoading || model.busyID != nil)
        .accessibilityLabel(model.isLoading ? String(localized: "正在刷新 Agent") : String(localized: "重新发现 Agent"))
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
                    Text(String(localized: "添加你要使用的 Agent")).font(.title2.bold())
                    Text(String(localized: "设备已连接。选择 Agent 后，就可以在项目中开始任务。"))
                        .foregroundStyle(.secondary)
                    DeviceAgentSection(model: model)
                }.padding(22)
            }
            .navigationTitle(connector.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetCloseToolbar(disabled: model.busyID != nil, action: onFinish)
            }
        }
        .presentationDetents([.large]).interactiveDismissDisabled()
    }
}
