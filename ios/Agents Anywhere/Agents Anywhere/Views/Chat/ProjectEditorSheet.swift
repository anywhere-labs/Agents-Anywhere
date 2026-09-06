import SwiftUI

struct ProjectEditorSheet: View {
    @Bindable var repository: V2DashboardRepository
    var onSaved: (V2Project) -> Void
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ProjectEditorDraft
    @State private var saving = false
    @State private var error: String?
    @State private var reuse: V2Project?
    @State private var showsFiles = false
    @State private var confirmsDiscard = false

    init(repository: V2DashboardRepository, project: V2Project? = nil, connectorID: String = "", onSaved: @escaping (V2Project) -> Void = { _ in }) {
        self.repository = repository; self.onSaved = onSaved
        let online = repository.connectors.filter { $0.status == .online }
        let initialDevice = online.first { $0.id == connectorID }?.id ?? online.first?.id ?? ""
        _draft = State(initialValue: ProjectEditorDraft(project: project, connectorID: initialDevice))
    }
    private var device: V2Connector? { repository.connectors.first { $0.id == draft.connectorID } }
    private var valid: Bool {
        repository.canWrite && device != nil && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (draft.original != nil || (device?.status == .online && validPath))
    }
    private var validPath: Bool {
        let path = draft.path.trimmingCharacters(in: .whitespacesAndNewlines)
        return path == "~" || path.hasPrefix("~/") || path.hasPrefix("~\\") || ProjectWorkspacePath.key(path, deviceOS: device?.deviceOs) != nil
    }
    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "运行设备")) {
                    if draft.original != nil {
                        LabeledContent(String(localized: "设备"), value: device?.name ?? draft.connectorID)
                    } else {
                        Picker(String(localized: "设备"), selection: Binding(get: { draft.connectorID }, set: { draft.selectDevice($0) })) {
                            Text(String(localized: "选择设备")).tag("")
                            ForEach(repository.connectors.filter { $0.status == .online || $0.id == draft.connectorID }) { device in
                                Text(device.name).tag(device.id).disabled(device.status != .online)
                            }
                        }.pickerStyle(.navigationLink)
                        if device?.status != .online {
                            Text(String(localized: "请选择在线设备后创建项目。"))
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    HStack(spacing: 12) {
                        TextField(String(localized: "设备上的完整路径"), text: Binding(get: { draft.path }, set: updatePath), axis: .vertical)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(draft.original != nil || device == nil)
                        if draft.original == nil {
                            Button(String(localized: "浏览目录"), appSymbol: "folder") { showsFiles = true }
                                .labelStyle(.iconOnly).buttonStyle(.borderless).frame(width: 44, height: 44)
                                .disabled(device?.status != .online || !repository.canWrite)
                        }
                    }
                } header: { Text(String(localized: "工作目录")) } footer: {
                    Text(draft.original == nil ? String(localized: "项目关联这个目录，不会在设备上新建文件夹。") : String(localized: "编辑项目时，设备和工作目录保持不变。"))
                }
                Section {
                    TextField(String(localized: "例如 Agents Anywhere"), text: Binding(get: { draft.name }, set: draft.editName))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text(String(localized: "项目名称")) } footer: {
                    Text(String(localized: "按目录自动填写名称，重名时添加数字后缀。也可以自行修改。"))
                }
                if let error { Section { Text(error).foregroundStyle(.secondary) } }
            }
            .textFieldStyle(.roundedBorder)
            .disabled(saving)
            .navigationTitle(draft.original == nil ? String(localized: "创建项目") : String(localized: "编辑项目"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetEditorToolbar(saveTitle: draft.original == nil ? String(localized: "Create") : String(localized: "Save"),
                    isWorking: saving, saveDisabled: !valid,
                    onCancel: { if draft.hasChanges { confirmsDiscard = true } else { dismiss() } },
                    onSave: {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        Task { await Task.yield(); await save() }
                    })
            }
            .onChange(of: repository.projects) { _, projects in draft.suggestName(projects: projects, deviceOS: device?.deviceOs) }
        }
        .appSheetPresentation(.compact).interactiveDismissDisabled(saving || draft.hasChanges)
        .confirmDiscardChanges($confirmsDiscard) { dismiss() }
        .alert(String(localized: "这个目录已有项目"), isPresented: Binding(get: { reuse != nil }, set: { if !$0 { reuse = nil } })) {
            Button(String(localized: "取消"), role: .cancel) { reuse = nil }
            Button(String(localized: "使用此项目并保存名称")) {
                let id = reuse?.id; reuse = nil
                Task { await save(reusing: id) }
            }
        } message: { Text(String(localized: "将使用「\(reuse?.name ?? "")」，并将名称更新为「\(draft.name)」。已有会话会保留。")) }
        .sheet(isPresented: $showsFiles) {
            if let device, let service = appState.workspaceFilesService {
                WorkspaceFilesSheet(connectorId: device.id, deviceName: device.name,
                    workspace: .init(path: "~", name: "", sessionCount: 0, lastActiveAt: nil), service: service,
                    permitsReading: device.status == .online && repository.canWrite,
                    onSelectDirectory: { updatePath($0); showsFiles = false }, initialPath: draft.path.isEmpty ? "." : draft.path)
            }
        }
    }

    private func updatePath(_ value: String) { draft.editPath(value, projects: repository.projects, deviceOS: device?.deviceOs) }

    private func save(reusing id: String? = nil) async {
        guard valid, !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            if draft.original == nil, draft.path.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("~") {
                guard let service = appState.workspaceFilesService else { throw HTTPError.invalidResponse }
                let result = try await service.directory(connectorId: draft.connectorID, root: "~", path: draft.path)
                guard result.targetType == nil || result.targetType == "directory" else {
                    throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "请选择一个已成功加载的目录。"))
                }
                updatePath(result.path)
            }
            guard valid, !Task.isCancelled else { return }
            draft.normalizeName(projects: repository.projects, deviceOS: device?.deviceOs)
            let value: V2Project
            if let project = draft.original {
                try await repository.updateProject(project.id, name: draft.name)
                value = repository.projects.first { $0.id == project.id } ?? project
            } else {
                value = try await repository.createProject(name: draft.name, connectorID: draft.connectorID, path: draft.path, reusing: id)
            }
            onSaved(value); dismiss()
        } catch let needsReuse as ProjectReuseRequired { reuse = needsReuse.project }
        catch { self.error = error.localizedDescription }
    }
}
