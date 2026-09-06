import SwiftUI

struct ProjectSelectionSheet: View {
    @Bindable var model: NewSessionModel
    @Bindable var repository: V2DashboardRepository
    @AppStorage(ProjectSidebarPreferences.sessionListKey) private var showsSessionList = false
    @State private var createsProject = false
    @State private var showsFiles = false
    @State private var selectionCompleted = false
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    private var canBrowse: Bool {
        model.connector?.status == .online && model.network.availability != .offline && model.isValid && !model.isCreating
    }
    private var homeProject: V2Project? {
        model.homePath.flatMap { ProjectWorkspacePath.project(in: model.projects, connectorID: model.connectorID,
            path: $0, deviceOS: model.connector?.deviceOs) }
    }
    private var directories: [WorkspaceDirectoryChoice] {
        WorkspaceDirectoryChoice.recent(connectorID: model.connectorID, deviceOS: model.connector?.deviceOs,
            home: model.homePath, projects: repository.projects, sessions: repository.sessions)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(model.connector?.name ?? String(localized: "选择设备"), appSymbol: "desktopcomputer")
                    if !canBrowse {
                        Label(String(localized: "设备或网络已离线，已保存的目录仍可选择。"), appSymbol: "wifi.slash")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section(showsSessionList ? String(localized: "工作目录") : String(localized: "这台设备上的项目")) {
                    if showsSessionList || homeProject == nil { homeRow }
                    if showsSessionList {
                        ForEach(directories) { directory in
                            directoryRow(name: directory.name, path: directory.path)
                        }
                        Button(String(localized: "浏览文件系统"), appSymbol: "folder") { showsFiles = true }
                            .disabled(!canBrowse)
                    } else {
                        ForEach(model.availableProjects) { project in
                            Button {
                                if model.selectProject(project.id) { dismiss() }
                            } label: {
                                HStack {
                                    ProjectSummaryLabel(project: project)
                                    Spacer(minLength: 8)
                                    if model.projectID == project.id { AppSymbol("checkmark") }
                                }.padding(.vertical, 6).contentShape(.rect)
                            }.buttonStyle(.plain)
                        }
                        if model.project == nil, !model.isHome, !model.workspace.isEmpty {
                            directoryRow(name: ProjectWorkspacePath.name(model.workspace), path: model.workspace)
                        }
                        Button(String(localized: "创建项目"), appSymbol: "folder.badge.plus") { createsProject = true }
                            .disabled(!repository.canWrite || !canBrowse)
                    }
                }
                if let error = model.homeErrors[model.connectorID], model.homePath == nil {
                    Section {
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                        Button(String(localized: "重新解析家目录")) { Task { await model.resolveHome() } }
                            .disabled(!canBrowse || model.loadingHomes.contains(model.connectorID))
                    }
                }
                if let error = repository.error { Section { Text(error).foregroundStyle(.secondary) } }
            }
            .refreshable { await repository.refresh(); await model.resolveHome() }
            .navigationTitle(showsSessionList ? String(localized: "选择工作目录") : String(localized: "选择项目"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
            .task(id: model.connectorID) { await model.resolveHome() }
        }
        .appSheetPresentation(.compact)
        .sheet(isPresented: $createsProject, onDismiss: finishSelection) {
            ProjectEditorSheet(repository: repository, connectorID: model.connectorID) { project in
                model.updateProjects(repository.projects)
                selectionCompleted = model.selectProject(project.id)
            }
        }
        .sheet(isPresented: $showsFiles, onDismiss: finishSelection) {
            if let device = model.connector, let service = appState.workspaceFilesService {
                WorkspaceFilesSheet(connectorId: device.id, deviceName: device.name,
                    workspace: .init(path: "~", name: "", sessionCount: 0, lastActiveAt: nil), service: service,
                    permitsReading: canBrowse,
                    onSelectDirectory: {
                        selectionCompleted = model.selectWorkspace($0)
                        showsFiles = false
                    }, initialPath: model.workspace.isEmpty ? "." : model.workspace)
            }
        }
    }

    private var homeRow: some View {
        Button {
            if let path = model.homePath, model.selectWorkspace(path) { dismiss() }
        } label: {
            HStack(spacing: 12) {
                AppSymbol("house")
                VStack(alignment: .leading, spacing: 5) {
                    Text(String(localized: "Home 目录")).foregroundStyle(.primary)
                    Text(model.homePath ?? String(localized: "正在解析设备家目录…"))
                        .font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 8)
                if model.loadingHomes.contains(model.connectorID) { ProgressView().controlSize(.small) }
                else if model.isHome { AppSymbol("checkmark") }
            }.padding(.vertical, 6)
        }.buttonStyle(.plain).disabled(model.homePath == nil)
    }
    private func directoryRow(name: String, path: String) -> some View {
        Button { if model.selectWorkspace(path) { dismiss() } } label: {
            HStack(spacing: 12) {
                AppSymbol("folder")
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).foregroundStyle(.primary)
                    Text(path).font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 8)
                if ProjectWorkspacePath.key(path, deviceOS: model.connector?.deviceOs) == ProjectWorkspacePath.key(model.workspace, deviceOS: model.connector?.deviceOs) {
                    AppSymbol("checkmark")
                }
            }.padding(.vertical, 6).contentShape(.rect)
        }.buttonStyle(.plain)
    }
    private func finishSelection() { if selectionCompleted { dismiss() } }
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
