import SwiftUI

struct ChatSidebarProjects: View {
    @Bindable var repository: V2DashboardRepository
    @Binding var showsSessionList: Bool
    let selectedSessionID: String?
    let onShowArchives: () -> Void
    let onNewSession: (String) -> Void
    let onOpenSession: (String) -> Void
    let onRenameSession: (String, String) -> Void
    let onPinSession: (String, Bool) -> Void
    let onArchiveSession: (String) -> Void
    let onCopySession: (String) -> Void
    @State private var filter = V2DeviceSessionFilter.active
    @State private var createsProject = false
    @State private var editing: V2Project?
    @State private var action: ProjectAction?
    @State private var busy: Set<String> = []
    @State private var error: String?

    private struct ProjectAction: Identifiable {
        let project: V2Project
        let deletes: Bool
        var id: String { project.id }
    }
    var body: some View {
        let projects = ProjectSidebarPresentation.projects(repository.projects, filter: filter, sessions: repository.sessions)
        VStack(alignment: .leading, spacing: 4) {
            if projects.contains(where: \.pinned) {
                Text(String(localized: "置顶项目")).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 6)
                projectList(projects.filter(\.pinned))
            }
            HStack {
                Button { repository.sidebarPreferences.projectsExpanded.toggle() } label: {
                    HStack(spacing: 6) {
                        Text(String(localized: "项目"))
                        AppSymbol("chevron.right", size: 12)
                            .rotationEffect(.degrees(repository.sidebarPreferences.projectsExpanded ? 90 : 0))
                    }.font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        .frame(minHeight: 44).contentShape(.rect)
                }.buttonStyle(.plain)
                Spacer()
                ChatSidebarListMenu(showsSessionList: $showsSessionList, onShowArchives: onShowArchives) {
                    Picker(String(localized: "会话"), selection: $filter) {
                        ForEach(V2DeviceSessionFilter.allCases) { Text($0.title).tag($0) }
                    }
                }
                Button(String(localized: "创建项目"), appSymbol: "plus") { createsProject = true }
                    .labelStyle(.iconOnly).frame(width: 44, height: 44).disabled(!repository.canWrite)
            }.padding(.horizontal, 10).padding(.top, 16)
            if repository.sidebarPreferences.projectsExpanded {
                projectList(projects.filter { !$0.pinned })
                if repository.isLoading && repository.projects.isEmpty { ProgressView().padding(12) }
                if repository.hasLoaded && repository.projects.isEmpty {
                    Text(String(localized: "创建一个项目，开始新的任务。"))
                        .font(.footnote).foregroundStyle(.secondary).padding(10)
                }
            }
        }
        .sheet(isPresented: $createsProject) {
            ProjectEditorSheet(repository: repository) {
                repository.sidebarPreferences.expandedProjects.insert($0.id)
                repository.sidebarPreferences.projectsExpanded = true
            }
        }
        .sheet(item: $editing) { ProjectEditorSheet(repository: repository, project: $0) }
        .alert(action?.deletes == true ? String(localized: "删除项目？") : String(localized: "归档这个项目的会话？"), isPresented: Binding(
            get: { action != nil }, set: { if !$0 { action = nil } })) {
            Button(String(localized: "取消"), role: .cancel) { action = nil }
            Button(action?.deletes == true ? String(localized: "删除") : String(localized: "归档"), role: .destructive) {
                guard let pending = action else { return }
                action = nil
                perform(pending.project.id) {
                    if pending.deletes { try await repository.deleteProject(pending.project.id) }
                    else { try await repository.archiveProject(pending.project.id, archived: true) }
                }
            }
        } message: {
            Text(action?.deletes == true ? String(localized: "只有没有会话的项目可以删除，设备上的文件会保留。") : String(localized: "Archive all sessions in \(action?.project.name ?? "")? The project will remain available for future sessions."))
        }
        .alert(String(localized: "操作未完成"), isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button(String(localized: "好")) { error = nil }
        } message: { Text(error ?? "") }
    }

    private var expanded: Set<String> { repository.sidebarPreferences.expandedProjects }

    private func projectList(_ values: [V2Project]) -> some View {
        ForEach(values) { project in
            projectRow(project)
            if expanded.contains(project.id) { projectSessions(project) }
        }
    }

    private func projectRow(_ project: V2Project) -> some View {
        HStack(spacing: 0) {
            Button { toggleProject(project.id) } label: {
                HStack(spacing: 8) {
                    AppSymbol(expanded.contains(project.id) ? "folder.fill" : "folder", size: 18)
                    Text(project.name).font(.body).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if busy.contains(project.id) { ProgressView().controlSize(.mini) }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
            }
            .accessibilityHint(expanded.contains(project.id) ? String(localized: "收起项目") : String(localized: "展开项目"))
            Button { onNewSession(project.id) } label: {
                AppSymbol("square.and.pencil", size: 18).frame(width: 44, height: 44).contentShape(.rect)
            }
            .accessibilityLabel(Text(String(localized: "在 \(project.name) 中新建会话")))
        }
        .foregroundStyle(.primary)
        .padding(.leading, 10).buttonStyle(.plain)
        .contentShape(.rect)
        .contextMenu { projectMenu(project) }
    }

    @ViewBuilder
    private func projectMenu(_ project: V2Project) -> some View {
        let deviceName = repository.connectors.first { $0.id == project.connectorId }?.name ?? String(localized: "设备不可用")
        Section(deviceName) {
            Button(String(localized: "新建会话"), systemImage: "square.and.pencil") { onNewSession(project.id) }
            Button(String(localized: "编辑项目"), systemImage: "pencil") { editing = project }
                .disabled(!repository.canWrite || busy.contains(project.id))
            Button(project.pinned ? String(localized: "取消置顶") : String(localized: "置顶"), systemImage: "pin") {
                perform(project.id) { try await repository.updateProject(project.id, pinned: !project.pinned) }
            }.disabled(!repository.canWrite || busy.contains(project.id))
        }
        Section {
            Button(String(localized: "归档项目会话"), systemImage: "archivebox", role: .destructive) { action = .init(project: project, deletes: false) }
                .disabled(!repository.canWrite || busy.contains(project.id))
            Button(String(localized: "删除项目"), systemImage: "trash", role: .destructive) { action = .init(project: project, deletes: true) }
                .disabled(!repository.canWrite || busy.contains(project.id))
        }
    }

    private func projectSessions(_ project: V2Project) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(ProjectSidebarPresentation.sessions(repository.sessions, projectID: project.id, filter: filter)) { session in
                ChatSidebarSessionRow(session: .init(session: session), isSelected: selectedSessionID == session.id,
                    inset: true,
                    onOpen: { onOpenSession(session.id) }, onRename: { onRenameSession(session.id, $0) },
                    onTogglePinned: { onPinSession(session.id, !session.pinned) }, onArchive: { onArchiveSession(session.id) },
                    onCopyId: { onCopySession(session.id) })
            }
            ForEach(scopes(project.id), id: \.self) { scope in
                DashboardPageButton(repository: repository, scope: scope).padding(.leading, 26)
            }
        }
        .task(id: "\(filter.rawValue):\(repository.canWrite)") {
            for scope in scopes(project.id) { await repository.ensureProjectPage(scope) }
        }
    }
    private func toggleProject(_ id: String) {
        if expanded.contains(id) { repository.sidebarPreferences.expandedProjects.remove(id) }
        else { repository.sidebarPreferences.expandedProjects.insert(id) }
    }
    private func scopes(_ id: String) -> [V2SessionListScope] {
        switch filter {
        case .active: [.init(projectID: id)]
        case .archived: [.init(projectID: id, archived: true)]
        case .all: [.init(projectID: id), .init(projectID: id, archived: true)]
        }
    }
    private func perform(_ id: String, operation: @escaping () async throws -> Void) {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        Task {
            defer { busy.remove(id) }
            do { try await operation() } catch { self.error = error.localizedDescription }
        }
    }
}

struct DashboardPageButton: View {
    let repository: V2DashboardRepository
    let scope: V2SessionListScope
    var body: some View {
        if repository.loadingPages.contains(scope) {
            ProgressView(String(localized: "加载会话…")).font(.footnote).padding(10)
        } else if let error = repository.pageErrors[scope] {
            VStack(alignment: .leading, spacing: 6) {
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button(String(localized: "重试")) { Task { await repository.loadPage(scope) } }.disabled(!repository.canWrite)
            }.padding(10)
        } else if repository.pages[scope]?.hasMore == true {
            Button(scope.archived ? String(localized: "加载更多归档会话") : String(localized: "加载更多会话")) { Task { await repository.loadPage(scope) } }
                .font(.footnote).padding(10).disabled(!repository.canWrite)
        }
    }
}

struct ArchivedSessionsSheet: View {
    let repository: V2DashboardRepository
    let onOpen: (String) -> Void
    let onRestore: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var busy: Set<String> = []
    @State private var restoreError = false
    var body: some View {
        NavigationStack {
            List {
                ForEach(ProjectSidebarPresentation.sessions(repository.sessions, projectID: nil, filter: .archived)) { session in
                    HStack {
                        Button { dismiss(); onOpen(session.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(session.title ?? String(localized: "未命名会话")).foregroundStyle(.primary).lineLimit(2)
                                Text(repository.projects.first { $0.id == session.projectId }?.name ?? session.cwd ?? "")
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }.buttonStyle(.plain)
                        Spacer()
                        Button {
                            busy.insert(session.id)
                            Task { let restored = await onRestore(session.id); busy.remove(session.id); restoreError = !restored }
                        } label: {
                            if busy.contains(session.id) { ProgressView() }
                            else { AppSymbol("tray.and.arrow.up") }
                        }.buttonStyle(.borderless).disabled(busy.contains(session.id) || !repository.canWrite)
                            .accessibilityLabel(String(localized: "恢复会话"))
                    }
                }
                DashboardPageButton(repository: repository, scope: .init(archived: true))
            }
            .navigationTitle(String(localized: "归档会话")).navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
            .refreshable { await repository.loadPage(.init(archived: true), refresh: true) }
            .task { if repository.pages[.init(archived: true)] == nil { await repository.loadPage(.init(archived: true)) } }
        }
        .appSheetPresentation(.compact)
        .alert(String(localized: "无法恢复会话，请稍后重试。"), isPresented: $restoreError) { Button(String(localized: "好"), role: .cancel) {} }
    }
}
