import SwiftUI

struct ProjectSelectionSheet: View {
    @Bindable var model: NewSessionModel
    @Bindable var repository: V2DashboardRepository
    @State private var createsProject = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(model.connector?.name ?? "选择设备", systemImage: "desktopcomputer")
                    if model.network.availability == .offline {
                        Label("网络已断开，保留上次加载的项目。", systemImage: "wifi.slash").foregroundStyle(.secondary)
                    }
                }
                Section("这台设备上的项目") {
                    ForEach(model.availableProjects) { project in
                        Button {
                            if model.selectProject(project.id) { dismiss() }
                        } label: {
                            HStack {
                                ProjectSummaryLabel(project: project)
                                Spacer(minLength: 8)
                                if model.projectID == project.id { Image(systemName: "checkmark") }
                            }.padding(.vertical, 6).contentShape(.rect)
                        }.buttonStyle(.plain)
                    }
                    if model.availableProjects.isEmpty {
                        Text(repository.hasLoaded ? "还没有项目，可以创建一个项目并选择工作目录。" : "正在加载项目…")
                            .foregroundStyle(.secondary)
                    }
                    Button("创建项目", systemImage: "folder.badge.plus") { createsProject = true }
                        .disabled(!repository.canWrite || model.connector == nil)
                }
                if let error = repository.error {
                    Section { Text(error).foregroundStyle(.secondary) }
                }
            }
            .refreshable { await repository.refresh() }
            .navigationTitle("选择项目").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
        .presentationDetents([.large])
        .sheet(isPresented: $createsProject) {
            ProjectEditorSheet(repository: repository, connectorID: model.connectorID) { project in
                model.updateProjects(repository.projects)
                _ = model.selectProject(project.id)
            }
        }
    }
}

struct ProjectSummaryLabel: View {
    let project: V2Project
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(project.name).font(.headline).foregroundStyle(.primary)
            Text(project.workspacePath).font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary).lineLimit(2)
        }
    }
}

struct ProjectEditorSheet: View {
    @Bindable var repository: V2DashboardRepository
    var project: V2Project? = nil
    var connectorID: String = ""
    var onSaved: (V2Project) -> Void = { _ in }
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var deviceID = ""
    @State private var path = ""
    @State private var saving = false
    @State private var error: String?
    @State private var reuse: V2Project?
    @State private var showsFiles = false

    private var device: V2Connector? { repository.connectors.first { $0.id == deviceID } }
    private var valid: Bool {
        repository.canWrite && device != nil && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (project != nil || ProjectWorkspacePath.key(path, deviceOS: device?.deviceOs) != nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("项目名称") {
                    TextField("例如 Agents Anywhere", text: $name)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("运行设备") {
                    Picker("设备", selection: $deviceID) {
                        Text("选择设备").tag("")
                        ForEach(repository.connectors) { device in Text(device.name).tag(device.id) }
                    }.disabled(project != nil)
                    if device?.status != .online {
                        Text("设备离线时可填写路径保存项目，连接恢复后才能运行会话。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextField("设备上的完整路径", text: $path, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(project != nil)
                    if project == nil {
                        Button("浏览目录", systemImage: "folder") { showsFiles = true }
                            .disabled(device?.status != .online || !repository.canWrite)
                    }
                } header: { Text("工作目录") } footer: {
                    Text("项目固定在这台设备的这个目录中。会话会使用项目的目录。")
                }
                if let error { Section { Text(error).foregroundStyle(.secondary) } }
                Section {
                    AppGlassButton(project == nil ? "创建项目" : "保存", systemImage: "checkmark", style: .prominent,
                        isLoading: saving, disabled: !valid) { Task { await save() } }
                        .listRowBackground(Color.clear)
                }
            }
            .disabled(saving)
            .navigationTitle(project == nil ? "创建项目" : "编辑项目").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) } }
            .onAppear {
                name = project?.name ?? ""
                deviceID = project?.connectorId ?? connectorID
                path = project?.workspacePath ?? ""
            }
            .onChange(of: deviceID) { old, new in if old != new && project == nil { path = "" } }
        }
        .presentationDetents([.large]).interactiveDismissDisabled(saving)
        .alert("这个目录已有项目", isPresented: Binding(get: { reuse != nil }, set: { if !$0 { reuse = nil } })) {
            Button("取消", role: .cancel) { reuse = nil }
            Button("使用此项目并保存名称") {
                let id = reuse?.id; reuse = nil
                Task { await save(reusing: id) }
            }
        } message: { Text("将使用「\(reuse?.name ?? "")」，并将名称更新为「\(name)」。已有会话会保留。") }
        .sheet(isPresented: $showsFiles) {
            if let device, let service = appState.workspaceFilesService {
                WorkspaceFilesSheet(connectorId: device.id, deviceName: device.name,
                    workspace: .init(path: path.isEmpty ? (device.deviceOs == "windows" ? "C:\\" : "/") : path,
                        name: "", sessionCount: 0, lastActiveAt: nil), service: service,
                    permitsReading: device.status == .online && repository.canWrite,
                    onSelectDirectory: { path = $0; showsFiles = false })
            }
        }
    }
    private func save(reusing id: String? = nil) async {
        guard valid, !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let value: V2Project
            if let project {
                try await repository.updateProject(project.id, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
                value = repository.projects.first { $0.id == project.id } ?? project
            } else {
                value = try await repository.createProject(name: name, connectorID: deviceID, path: path, reusing: id)
            }
            onSaved(value); dismiss()
        } catch let needsReuse as ProjectReuseRequired { reuse = needsReuse.project }
        catch { self.error = error.localizedDescription }
    }
}
