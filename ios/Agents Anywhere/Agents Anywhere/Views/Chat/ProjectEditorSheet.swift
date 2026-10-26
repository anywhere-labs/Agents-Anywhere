import SwiftUI

struct ProjectEditorSheet: View {
    @Bindable var repository: V2DashboardRepository
    var onSaved: (V2Project) -> Void
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var connectorID: String
    @State private var path = ""
    @State private var name = ""
    @State private var nameEdited = false
    @State private var saving = false
    @State private var error: String?
    @State private var runtimes: [V2DeviceRuntime] = []
    @State private var runtimeID = ""
    @State private var requestID = UUID().uuidString
    @State private var showsFiles = false
    @State private var pendingOperations: [V2PendingProjectOperation] = []
    @State private var recoveryError: String?

    init(repository: V2DashboardRepository, connectorID: String = "", onSaved: @escaping (V2Project) -> Void = { _ in }) {
        self.repository = repository
        self.onSaved = onSaved
        let online = repository.connectors.filter { $0.status == .online }
        _connectorID = State(initialValue: online.first { $0.id == connectorID }?.id ?? online.first?.id ?? "")
    }
    private var device: V2Connector? { repository.connectors.first { $0.id == connectorID } }
    private var runtime: V2DeviceRuntime? { runtimes.first { $0.id == runtimeID } }
    private var valid: Bool {
        repository.canWrite && device?.status == .online && runtime?.capabilities["projectCreate"] == true
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (path.hasPrefix("~") || ProjectWorkspacePath.key(path, deviceOS: device?.deviceOs) != nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                if !pendingOperations.isEmpty {
                    Section(String(localized: "待核对的项目操作")) {
                        Text(String(localized: "可继续核对旧操作；再次新建会单独创建一个项目。"))
                        ForEach(pendingOperations) { entry in
                            VStack(alignment: .leading) {
                                Text(entry.request.name)
                                Text(entry.operation.status == "succeeded" ? String(localized: "已创建，等待同步") : entry.operation.status == "pending" ? String(localized: "处理中") : String(localized: "结果待确认"))
                                Text(entry.request.workspacePath).font(.caption)
                                HStack {
                                    Button(String(localized: "继续核对")) { Task { await resume(entry) } }.buttonStyle(.bordered)
                                    Button(String(localized: "再次新建")) { Task { await resume(entry, again: true) } }.buttonStyle(.borderless)
                                }
                            }
                        }
                    }
                }
                if let recoveryError { Text(recoveryError).foregroundStyle(.secondary) }
                Section(String(localized: "运行设备")) {
                    Picker(String(localized: "设备"), selection: $connectorID) {
                        Text(String(localized: "选择设备")).tag("")
                        ForEach(repository.connectors.filter { $0.status == .online }) { Text($0.name).tag($0.id) }
                    }
                    Picker(String(localized: "Runtime 实例"), selection: $runtimeID) {
                        Text(String(localized: "选择 Runtime")).tag("")
                        ForEach(runtimes) { Text($0.name + " · " + $0.id).tag($0.id) }
                    }
                    if runtime?.capabilities["directoryProjects"] == true {
                        Text(String(localized: "请在新建对话中选择目录并发送首条消息，以建立此来源的项目。"))
                    }
                }
                Section {
                    HStack {
                        TextField(String(localized: "设备上的完整路径"), text: $path)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(String(localized: "浏览目录"), appSymbol: "folder") { showsFiles = true }
                            .labelStyle(.iconOnly).disabled(device?.status != .online)
                    }
                    TextField(String(localized: "项目名称"), text: Binding(get: { name }, set: { name = $0; nameEdited = true }))
                } footer: { Text(String(localized: "登记已存在的目录，不创建物理文件夹。项目允许同名、同目录。")) }
                if let error { Text(error).foregroundStyle(.secondary) }
            }
            .disabled(saving)
            .navigationTitle(String(localized: "创建项目"))
            .toolbar {
                SheetEditorToolbar(saveTitle: String(localized: "Create"), isWorking: saving, saveDisabled: !valid,
                    onCancel: { dismiss() }, onSave: { Task { await save() } })
            }
            .task {
                do { pendingOperations = try await repository.pendingProjectOperations() }
                catch { recoveryError = String(localized: "未能加载待核对操作；提交相同参数仍会恢复已有操作。") }
            }
            .task(id: connectorID) {
                do { runtimes = try await repository.projectRuntimes(connectorID); runtimeID = runtimes.first?.id ?? "" }
                catch { self.error = error.localizedDescription }
            }
            .onChange(of: path) { _, value in if !nameEdited { name = ProjectWorkspacePath.name(value) }; requestID = UUID().uuidString }
            .onChange(of: name) { _, _ in requestID = UUID().uuidString }
            .onChange(of: runtimeID) { _, _ in requestID = UUID().uuidString }
        }
        .appSheetPresentation(.compact).interactiveDismissDisabled(saving)
        .sheet(isPresented: $showsFiles) {
            if let device, let service = appState.workspaceFilesService {
                WorkspaceFilesSheet(connectorId: device.id, deviceName: device.name,
                    workspace: .init(path: "~", name: "", sessionCount: 0, lastActiveAt: nil), service: service,
                    permitsReading: device.status == .online && repository.canWrite,
                    onSelectDirectory: { path = $0; showsFiles = false }, initialPath: path.isEmpty ? "." : path)
            }
        }
    }
    private func resume(_ entry: V2PendingProjectOperation, again: Bool = false) async {
        guard !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let project = try await repository.resumeProjectOperation(entry, again: again)
            onSaved(project); dismiss()
        } catch {
            self.error = error.localizedDescription
            if let values = try? await repository.pendingProjectOperations() { pendingOperations = values }
        }
    }
    private func save() async {
        guard valid, !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            var resolved = path
            if path.hasPrefix("~") {
                guard let service = appState.workspaceFilesService else { throw HTTPError.invalidResponse }
                let result = try await service.directory(connectorId: connectorID, root: "~", path: path)
                guard result.targetType == nil || result.targetType == "directory" else { throw HTTPError.invalidResponse }
                resolved = result.path
            }
            let value = try await repository.createProject(name: name, connectorID: connectorID, path: resolved,
                runtime: runtime, requestID: requestID)
            onSaved(value); dismiss()
        } catch {
            self.error = error.localizedDescription
            if let values = try? await repository.pendingProjectOperations() { pendingOperations = values }
        }
    }
}
