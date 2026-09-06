import SwiftUI
import UIKit

enum DeviceOverviewTab: Hashable { case projects, sessions }

struct DeviceProjectList: View {
    let projects: [V2Project]
    let canManage: Bool
    let canReadFiles: Bool
    let onCreate: () -> Void
    let onOpen: (V2Project) -> Void
    let onNewSession: (V2Project) -> Void
    let onFiles: (V2Project) -> Void
    let onEdit: (V2Project) -> Void
    let onPin: (V2Project) -> Void
    let onArchive: (V2Project) -> Void
    let onDelete: (V2Project) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("\(projects.count) projects").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                AppGlassButton(systemImage: "plus", disabled: !canManage, action: onCreate)
                    .accessibilityLabel(String(localized: "Create project"))
            }
            if projects.isEmpty {
                ContentUnavailableView(String(localized: "No projects yet"), appSymbol: "folder",
                    description: Text(String(localized: "Create a project to choose where your agents work.")))
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(projects) { project in
                        DeviceDirectoryRow(name: project.name, path: project.workspacePath,
                            sessionCount: project.activeSessionCount, onOpen: { onOpen(project) },
                            openHint: String(localized: "Show project sessions")) {
                            HStack(spacing: 0) {
                                Button { onFiles(project) } label: { AppSymbol("folder").frame(width: 44, height: 44) }
                                    .accessibilityLabel(String(localized: "Files")).disabled(!canReadFiles)
                                Button { onNewSession(project) } label: { AppSymbol("square.and.pencil").frame(width: 44, height: 44) }
                                    .accessibilityLabel(String(localized: "New session"))
                                Menu {
                                    Button(String(localized: "Rename project"), appSymbol: "pencil") { onEdit(project) }.disabled(!canManage)
                                    Button(project.pinned ? String(localized: "Unpin") : String(localized: "Pin"), appSymbol: "pin") { onPin(project) }.disabled(!canManage)
                                    Button(String(localized: "Copy path"), appSymbol: "doc.on.doc") { UIPasteboard.general.string = project.workspacePath }
                                    Divider()
                                    Button(String(localized: "Archive project sessions"), appSymbol: "archivebox") { onArchive(project) }.disabled(!canManage)
                                    Button(String(localized: "Delete project"), appSymbol: "trash", role: .destructive) { onDelete(project) }
                                        .disabled(!canManage || project.sidebarSessionCounts.active + project.sidebarSessionCounts.archived > 0)
                                } label: { AppSymbol("ellipsis").frame(width: 44, height: 44) }
                                .accessibilityLabel(String(localized: "Project actions"))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

struct DeviceWorkspaceList: View {
    let workspaces: [WorkspaceDirectoryChoice]
    let canReadFiles: Bool
    let onBrowse: () -> Void
    let onOpen: (WorkspaceDirectoryChoice) -> Void
    let onNewSession: (WorkspaceDirectoryChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("\(workspaces.count) workspaces").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                AppGlassButton(systemImage: "plus", disabled: !canReadFiles, action: onBrowse)
                    .accessibilityLabel(String(localized: "选择工作目录"))
            }
            if workspaces.isEmpty {
                ContentUnavailableView(String(localized: "No workspaces yet"), appSymbol: "folder",
                    description: Text(String(localized: "Choose a folder to start a new session.")))
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(workspaces) { workspace in
                        DeviceDirectoryRow(name: workspace.name, path: workspace.path,
                            onOpen: { onOpen(workspace) }, openHint: String(localized: "Files"),
                            canOpen: canReadFiles) {
                            HStack(spacing: 0) {
                                Button { onNewSession(workspace) } label: {
                                    AppSymbol("square.and.pencil").frame(width: 44, height: 44)
                                }.accessibilityLabel(String(localized: "New session"))
                                Menu {
                                    Button(String(localized: "Files"), appSymbol: "folder") { onOpen(workspace) }
                                        .disabled(!canReadFiles)
                                    Button(String(localized: "Copy path"), appSymbol: "doc.on.doc") {
                                        UIPasteboard.general.string = workspace.path
                                    }
                                } label: { AppSymbol("ellipsis").frame(width: 44, height: 44) }
                                .accessibilityLabel(String(localized: "Workspace actions"))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

/// Both display modes share the same row geometry. Narrow windows move the
/// actions below the summary so paths and touch targets retain usable space.
private struct DeviceDirectoryRow<Actions: View>: View {
    let name: String
    let path: String
    var sessionCount: Int? = nil
    let onOpen: () -> Void
    let openHint: String
    var canOpen = true
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                summary.frame(minWidth: 220, maxWidth: .infinity, alignment: .leading)
                actions().fixedSize(horizontal: true, vertical: false)
            }
            VStack(alignment: .leading, spacing: 8) {
                summary
                HStack { Spacer(minLength: 0); actions() }
            }
        }
        .padding(16)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 22))
    }

    private var summary: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                AppSymbol("folder", size: 20).padding(.top, 2)
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).font(.headline).lineLimit(2).foregroundStyle(.primary)
                    Text(path).font(.caption.monospaced()).lineLimit(2)
                        .foregroundStyle(.secondary).truncationMode(.middle)
                    if let sessionCount {
                        Text("\(sessionCount) sessions").font(.caption).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
        }
        .buttonStyle(.plain).disabled(!canOpen).accessibilityHint(openHint)
    }
}

struct DeviceSessionList: View {
    @Bindable var model: DeviceManagementModel
    let projects: [V2Project]
    let showsProjectNames: Bool
    let canManage: Bool
    let isWorking: Bool
    let onNewSession: () -> Void
    let onOpen: (String) -> Void
    let onArchive: (V2SessionMeta) -> Void
    let onArchiveAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Menu {
                    Picker(showsProjectNames ? String(localized: "Project") : String(localized: "工作目录"),
                        selection: Binding(get: { model.projectID }, set: model.selectProject)) {
                        Text(allScopesTitle).tag(String?.none)
                        ForEach(projects) {
                            Text(showsProjectNames ? $0.name : $0.workspacePath).tag(Optional($0.id))
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(selectedScopeTitle)
                            .lineLimit(1)
                        AppSymbol("chevron.down", size: 14)
                    }.frame(minHeight: 44)
                }
                Spacer(minLength: 8)
                Menu {
                    Button(model.isSelectingSessions ? String(localized: "Done") : String(localized: "Select sessions"), appSymbol: "checkmark.circle") {
                        if model.isSelectingSessions { model.stopSelectingSessions() } else { model.startSelectingSessions() }
                    }.disabled(!canManage || model.filteredSessions.isEmpty)
                    if model.isSelectingSessions {
                        Button(String(localized: "Select up to 200 sessions"), action: model.toggleSelectAll).disabled(!canManage)
                    }
                    Divider()
                    Button(model.sessionFilter == .archived ? String(localized: "Restore all in scope") : String(localized: "Archive all in scope"),
                        appSymbol: model.sessionFilter == .archived ? "tray.and.arrow.up" : "archivebox", action: onArchiveAll)
                        .disabled(!canManage || model.filteredSessions.isEmpty)
                } label: {
                    AppSymbol("ellipsis").frame(width: 44, height: 44)
                        .overlay { if isWorking { ProgressView().controlSize(.small) } }
                }.accessibilityLabel(String(localized: "Session actions"))
                Button(action: onNewSession) { AppSymbol("square.and.pencil").frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "New session"))
            }.buttonStyle(.plain)
            Picker(String(localized: "Session filter"), selection: Binding(get: { model.sessionFilter }, set: model.setSessionFilter)) {
                ForEach(V2DeviceSessionFilter.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented)
            if model.filteredSessions.isEmpty {
                ContentUnavailableView(String(localized: "No sessions here"), appSymbol: "bubble.left.and.bubble.right",
                    description: Text(String(localized: "Choose another filter or start a new session.")))
            } else {
                LazyVStack(spacing: 6) {
                    ForEach(model.filteredSessions) { session in
                        Button { onOpen(session.id) } label: {
                            HStack(spacing: 12) {
                                if model.isSelectingSessions {
                                    AppSymbol(model.selectedSessionIds.contains(session.id) ? "checkmark.circle.fill" : "circle")
                                        .font(.title3).frame(width: 24)
                                }
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(session.title.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled session"))
                                        .font(.body.weight(session.unread ? .semibold : .regular))
                                        .foregroundStyle(.primary).lineLimit(2)
                                    HStack(spacing: 6) {
                                        Text(session.runtime)
                                        if let subtitle = scopeSubtitle(session) {
                                            Text("·"); Text(subtitle).lineLimit(1)
                                        }
                                    }.font(.caption).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                VStack(alignment: .trailing, spacing: 8) {
                                    ChatSidebarSessionIndicator(indicator: SessionSidebarPresentation(session).indicator)
                                    if let date = activityDate(session) {
                                        Text(date, format: .dateTime.month(.abbreviated).day()).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(model.selectedSessionIds.contains(session.id) ? 0.85 : 0.35),
                                    in: .rect(cornerRadius: 18)).contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(String(localized: "Open"), appSymbol: "arrow.up.right") { onOpen(session.id) }
                            Button(session.archived ? String(localized: "Restore") : String(localized: "Archive"),
                                appSymbol: session.archived ? "tray.and.arrow.up" : "archivebox") { onArchive(session) }
                                .disabled(!canManage || session.id.hasPrefix("local:"))
                            Button(String(localized: "Copy session ID"), appSymbol: "doc.on.doc") { UIPasteboard.general.string = session.id }
                        }
                    }
                }
            }
        }
    }
    private var allScopesTitle: String {
        showsProjectNames ? String(localized: "All projects") : String(localized: "All workspaces")
    }
    private var selectedScopeTitle: String {
        guard let project = projects.first(where: { $0.id == model.projectID }) else { return allScopesTitle }
        return showsProjectNames ? project.name : ProjectWorkspacePath.name(project.workspacePath)
    }
    private func scopeSubtitle(_ session: V2SessionMeta) -> String? {
        let project = projects.first { $0.id == session.projectId }
        if showsProjectNames { return project?.name }
        return (session.cwd ?? project?.workspacePath).map(ProjectWorkspacePath.name)
    }
    private func activityDate(_ session: V2SessionMeta) -> Date? {
        guard let raw = session.sortAt ?? session.lastActivityAt ?? session.lastItemAt else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw)) ??
            (try? Date.ISO8601FormatStyle().parse(raw))
    }
}

struct DeviceSessionSelectionDock: View {
    let count: Int
    let restores: Bool
    let isWorking: Bool
    let disabled: Bool
    let onCancel: () -> Void
    let onSubmit: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            Text("\(count) selected").font(.subheadline).monospacedDigit()
            Spacer(minLength: 0)
            Button(String(localized: "Cancel"), action: onCancel).disabled(isWorking)
            AppGlassButton(restores ? String(localized: "Restore") : String(localized: "Archive"), systemImage: restores ? "tray.and.arrow.up" : "archivebox",
                style: .prominent, isLoading: isWorking, disabled: disabled || count == 0, maxWidth: nil, action: onSubmit)
        }
        .padding(14).glassEffect(.regular, in: .rect(cornerRadius: 24))
        .padding(.horizontal, 24).padding(.bottom, 12).frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
}
