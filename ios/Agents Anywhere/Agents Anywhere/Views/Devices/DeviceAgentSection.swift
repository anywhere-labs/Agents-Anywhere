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
        DeviceSection(String(localized: "dashboard.device.agentRuntimes")) {
            AgentRediscoveryButton(model: model)
        } content: {
            if showsConnectionNotice && !model.connected {
                Label(String(localized: "设备或网络已离线，连接恢复后可继续。"), appSymbol: "wifi.slash")
                    .font(.footnote).foregroundStyle(.secondary).padding(.bottom, 6)
            }
            DeviceRows {
                ForEach(model.inventory.configuredInstances) { runtime in row(runtime) }
                Button { showsAddAgents = true } label: {
                    HStack(spacing: 12) {
                        AppSymbol("plus", size: 14).frame(width: 14)
                        Text(String(localized: "添加更多 Agent")).font(.body.weight(.medium))
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 52).contentShape(.rect)
                }
                .buttonStyle(.plain)
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
        } message: {
            Text(String(localized: "\(deleting?.sessionDisplayName ?? "") will be stopped and removed from the configured list. All associated sessions, message history, and attachments will be permanently deleted. You can configure the runtime again later; the local installation is kept."))
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
    private var canChange: Bool { model.connected && model.busyID == nil }

    private func row(_ runtime: V2DeviceRuntime) -> some View {
        HStack(spacing: 12) {
            Button { configure(runtime) } label: {
                HStack(spacing: 12) {
                    DeviceStatusDot(tone: tone(runtime), isLoading: model.busyID == runtime.id)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(runtime.sessionDisplayName).font(.body.weight(.semibold)).lineLimit(1)
                        Text(verbatim: "\(runtime.typeDisplayName) · \(statusLabel(runtime))")
                            .font(.footnote).lineLimit(1)
                            .foregroundStyle(tone(runtime) == .error ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain).disabled(!canChange)
            .accessibilityLabel(Text(String(localized: "配置 \(runtime.sessionDisplayName)")))
            Menu {
                actions(runtime)
            } label: {
                AppSymbol("ellipsis", size: 18).foregroundStyle(.secondary)
                    .frame(width: 36, height: 44).contentShape(.rect)
            }
            .buttonStyle(.plain).disabled(!canChange)
            .accessibilityLabel(Text(runtime.sessionDisplayName))
            Toggle(String(localized: "启用 \(runtime.sessionDisplayName)"), isOn: Binding(get: { runtime.active }, set: { active in
                Task { try? await model.setActive(runtime, active) }
            }))
            .labelsHidden().toggleStyle(.switch).tint(.green).fixedSize()
            .disabled(!canChange)
        }
        .frame(minHeight: 60)
        .contextMenu { actions(runtime) }
    }

    @ViewBuilder
    private func actions(_ runtime: V2DeviceRuntime) -> some View {
        Button(String(localized: "dashboard.device.configure"), systemImage: "slider.horizontal.3") { configure(runtime) }
            .disabled(!canChange)
        Button(String(localized: "重命名"), systemImage: "pencil") { proposedName = runtime.name; renaming = runtime }
            .disabled(!canChange)
        Divider()
        Button(String(localized: "删除配置"), systemImage: "trash", role: .destructive) { deleting = runtime }
            .disabled(!canChange)
    }

    private func configure(_ runtime: V2DeviceRuntime) {
        do { configuration = .init(runtime: runtime, schema: try model.schema(runtime)) }
        catch { schemaError = error.localizedDescription }
    }

    private func statusLabel(_ runtime: V2DeviceRuntime) -> String {
        runtime.configured && !runtime.active ? String(localized: "dashboard.device.runtimeNotStarted") : runtime.status.displayName
    }

    /// Same tones as Web's runtime-status-presentation: the lifecycle status
    /// decides first, so a starting runtime (e.g. DSH syncing its sessions,
    /// reported as `phase`) is progress even when an error payload is present;
    /// a runtime that simply is not running yet is a warning, other failures
    /// are errors.
    private func tone(_ runtime: V2DeviceRuntime) -> DeviceStatusTone {
        switch runtime.status {
        case .running: return .ok
        case .starting, .stopping: return .progress
        default: break
        }
        if let error = runtime.error, error != .null {
            let code = error["code"]?.stringValue ?? ""
            let notRunning = ["runtime_unavailable", "runtime_not_started", "runtime_not_configured", "connector_offline"]
            return notRunning.contains(code) ? .warning : .error
        }
        return runtime.status == .error ? .error : .neutral
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
                    VStack(alignment: .leading, spacing: 12) {
                        Text(String(localized: "添加你要使用的 Agent")).font(.title2.bold())
                        Text(String(localized: "设备已连接。选择 Agent 后，就可以在项目中开始任务。"))
                            .foregroundStyle(.secondary)
                    }
                    DeviceAgentSection(model: model)
                }
                .padding(22).frame(maxWidth: 560).frame(maxWidth: .infinity)
            }
            .navigationTitle(connector.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetCloseToolbar(disabled: model.busyID != nil, action: onFinish)
            }
        }
        .appSheetPresentation(.compact).interactiveDismissDisabled(model.busyID != nil)
    }
}
