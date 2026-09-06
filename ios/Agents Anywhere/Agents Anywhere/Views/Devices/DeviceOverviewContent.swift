import SwiftUI
import UIKit

enum DeviceOverviewTab: Hashable { case projects, sessions }

struct DeviceProjectGrid: View {
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
                AppGlassButton(String(localized: "Create project"), systemImage: "folder.badge.plus", disabled: !canManage,
                    maxWidth: nil, action: onCreate)
            }
            if projects.isEmpty {
                ContentUnavailableView(String(localized: "No projects yet"), appSymbol: "folder",
                    description: Text(String(localized: "Create a project to choose where your agents work.")))
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 14)], spacing: 14) {
                    ForEach(projects) { project in
                        VStack(alignment: .leading, spacing: 18) {
                            Button { onOpen(project) } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    AppSymbol("folder.fill", size: 20)
                                    VStack(alignment: .leading, spacing: 7) {
                                        Text(project.name).font(.headline).lineLimit(1).foregroundStyle(.primary)
                                        Text(project.workspacePath).font(.caption.monospaced()).lineLimit(2)
                                            .foregroundStyle(.secondary).truncationMode(.middle)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.contentShape(.rect)
                            }.buttonStyle(.plain).accessibilityHint(String(localized: "Show project sessions"))
                            HStack(spacing: 8) {
                                Text("\(project.activeSessionCount) sessions").font(.caption).foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                                Button { onFiles(project) } label: { AppSymbol("folder").frame(width: 40, height: 40) }
                                    .accessibilityLabel(String(localized: "Files")).disabled(!canReadFiles)
                                Button { onNewSession(project) } label: { AppSymbol("plus").frame(width: 40, height: 40) }
                                    .accessibilityLabel(String(localized: "New session"))
                                Menu {
                                    Button(String(localized: "Rename project"), appSymbol: "pencil") { onEdit(project) }.disabled(!canManage)
                                    Button(project.pinned ? String(localized: "Unpin") : String(localized: "Pin"), appSymbol: "pin") { onPin(project) }.disabled(!canManage)
                                    Button(String(localized: "Copy path"), appSymbol: "doc.on.doc") { UIPasteboard.general.string = project.workspacePath }
                                    Divider()
                                    Button(String(localized: "Archive project sessions"), appSymbol: "archivebox") { onArchive(project) }.disabled(!canManage)
                                    Button(String(localized: "Delete project"), appSymbol: "trash", role: .destructive) { onDelete(project) }
                                        .disabled(!canManage || project.sidebarSessionCounts.active + project.sidebarSessionCounts.archived > 0)
                                } label: { AppSymbol("ellipsis").frame(width: 40, height: 40) }
                                .accessibilityLabel(String(localized: "Project actions"))
                            }.buttonStyle(.plain)
                        }
                        .padding(18).background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 22))
                    }
                }
            }
        }
    }
}

struct DeviceSessionList: View {
    @Bindable var model: DeviceManagementModel
    let projects: [V2Project]
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
                    Picker(String(localized: "Project"), selection: Binding(get: { model.projectID }, set: model.selectProject)) {
                        Text(String(localized: "All projects")).tag(String?.none)
                        ForEach(projects) { Text($0.name).tag(Optional($0.id)) }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(model.projectID.flatMap { id in projects.first { $0.id == id }?.name } ?? String(localized: "All projects"))
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
                                        if let project = projects.first(where: { $0.id == session.projectId }) {
                                            Text("·"); Text(project.name).lineLimit(1)
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
        .padding(.horizontal, 22).padding(.bottom, 12).frame(maxWidth: 1040).frame(maxWidth: .infinity)
    }
}
