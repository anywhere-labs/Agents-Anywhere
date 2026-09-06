import SwiftUI

struct ChatSidebarProjects: View {
    @Bindable var repository: V2DashboardRepository
    let selectedSessionID: String?
    let onNewSession: (String) -> Void
    let onOpenSession: (String) -> Void
    let onRenameSession: (String, String) -> Void
    let onPinSession: (String, Bool) -> Void
    let onArchiveSession: (String) -> Void
    let onCopySession: (String) -> Void
    @State private var filter = V2DeviceSessionFilter.active
    @State private var expanded: Set<String> = []
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
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("项目").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Menu {
                    Picker("会话", selection: $filter) {
                        ForEach(V2DeviceSessionFilter.allCases) { Text($0.title).tag($0) }
                    }
                } label: { Image(systemName: "line.3.horizontal.decrease").frame(width: 32, height: 32) }
                Button("创建项目", systemImage: "folder.badge.plus") { createsProject = true }
                    .labelStyle(.iconOnly).frame(width: 32, height: 32).disabled(!repository.canWrite)
            }.padding(.horizontal, 10).padding(.top, 16)
            ForEach(ProjectSidebarPresentation.projects(repository.projects, filter: filter)) { project in
                projectRow(project)
                if expanded.contains(project.id) {
                    projectSessions(project)
                }
            }
            if repository.isLoading && repository.projects.isEmpty { ProgressView().padding(12) }
            if repository.hasLoaded && repository.projects.isEmpty {
                Text("创建一个项目，开始新的任务。")
                    .font(.footnote).foregroundStyle(.secondary).padding(10)
            }
        }
        .sheet(isPresented: $createsProject) {
            ProjectEditorSheet(repository: repository) { expanded.insert($0.id) }
        }
        .sheet(item: $editing) { ProjectEditorSheet(repository: repository, project: $0) }
        .alert(action?.deletes == true ? "删除项目？" : "归档这个项目的会话？", isPresented: Binding(
            get: { action != nil }, set: { if !$0 { action = nil } })) {
            Button("取消", role: .cancel) { action = nil }
            Button(action?.deletes == true ? "删除" : "归档", role: .destructive) {
                guard let pending = action else { return }
                action = nil
                perform(pending.project.id) {
                    if pending.deletes { try await repository.deleteProject(pending.project.id) }
                    else { try await repository.archiveProject(pending.project.id, archived: true) }
                }
            }
        } message: {
            Text(action?.deletes == true ? "只有没有会话的项目可以删除，设备上的文件会保留。" : "当前活动会话将移到归档列表，可从归档中恢复。")
        }
        .alert("操作未完成", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func projectRow(_ project: V2Project) -> some View {
        Button {
            if expanded.contains(project.id) { expanded.remove(project.id) }
            else { expanded.insert(project.id) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: expanded.contains(project.id) ? "folder.fill" : "folder")
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.name).lineLimit(1)
                    Text(repository.connectors.first { $0.id == project.connectorId }?.name ?? "设备不可用")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                if busy.contains(project.id) { ProgressView().controlSize(.mini) }
                else if project.pinned { Image(systemName: "pin.fill").font(.caption2) }
                Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(expanded.contains(project.id) ? 90 : 0))
            }.frame(minHeight: 48).padding(.horizontal, 10).contentShape(.rect)
        }.buttonStyle(.plain)
        .contextMenu {
            Button("新建会话", systemImage: "square.and.pencil") { onNewSession(project.id) }
            Button(project.pinned ? "取消置顶" : "置顶", systemImage: "pin") {
                perform(project.id) { try await repository.updateProject(project.id, pinned: !project.pinned) }
            }.disabled(!repository.canWrite || busy.contains(project.id))
            Button("编辑项目", systemImage: "pencil") { editing = project }
                .disabled(!repository.canWrite || busy.contains(project.id))
            Button("归档项目会话", systemImage: "archivebox") { action = .init(project: project, deletes: false) }
                .disabled(!repository.canWrite || busy.contains(project.id))
            Button("删除项目", systemImage: "trash", role: .destructive) { action = .init(project: project, deletes: true) }
                .disabled(!repository.canWrite || busy.contains(project.id))
        }
    }

    private func projectSessions(_ project: V2Project) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button("新建会话", systemImage: "plus") { onNewSession(project.id) }
                .font(.subheadline).padding(.horizontal, 10).frame(minHeight: 40)
            ForEach(ProjectSidebarPresentation.sessions(repository.sessions, projectID: project.id, filter: filter)) { session in
                ChatSidebarSessionRow(session: .init(session: session), isSelected: selectedSessionID == session.id,
                    onOpen: { onOpenSession(session.id) }, onRename: { onRenameSession(session.id, $0) },
                    onTogglePinned: { onPinSession(session.id, !session.pinned) }, onArchive: { onArchiveSession(session.id) },
                    onCopyId: { onCopySession(session.id) })
            }
            ForEach(scopes(project.id), id: \.self) { scope in DashboardPageButton(repository: repository, scope: scope) }
        }
        .task(id: "\(filter.rawValue):\(repository.canWrite)") {
            for scope in scopes(project.id) where repository.pages[scope] == nil { await repository.loadPage(scope) }
        }
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
            ProgressView("加载会话…").font(.footnote).padding(10)
        } else if let error = repository.pageErrors[scope] {
            VStack(alignment: .leading, spacing: 6) {
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("重试") { Task { await repository.loadPage(scope) } }.disabled(!repository.canWrite)
            }.padding(10)
        } else if repository.pages[scope]?.hasMore == true {
            Button(scope.archived ? "加载更多归档会话" : "加载更多会话") { Task { await repository.loadPage(scope) } }
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
                                Text(session.title ?? "未命名会话").foregroundStyle(.primary).lineLimit(2)
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
                            else { Image(systemName: "tray.and.arrow.up") }
                        }.buttonStyle(.borderless).disabled(busy.contains(session.id) || !repository.canWrite)
                            .accessibilityLabel("恢复会话")
                    }
                }
                DashboardPageButton(repository: repository, scope: .init(archived: true))
            }
            .navigationTitle("归档会话").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } } }
            .refreshable { await repository.loadPage(.init(archived: true), refresh: true) }
            .task { if repository.pages[.init(archived: true)] == nil { await repository.loadPage(.init(archived: true)) } }
        }
        .presentationDetents([.large])
        .alert("无法恢复会话，请稍后重试。", isPresented: $restoreError) { Button("好", role: .cancel) {} }
    }
}
