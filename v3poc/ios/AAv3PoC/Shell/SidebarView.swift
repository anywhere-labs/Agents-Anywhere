import SwiftUI

/// The real app's `ChatSidebarView` and `ChatSidebarProjects`, fed by workspace.json instead of repositories.
struct SidebarView: View {
    let controller: SessionController
    let safeAreaInsets: EdgeInsets
    let onOpenSession: (String) -> Void

    @State private var showsPairing = false
    @State private var showsAccount = false
    @AppStorage("poc.sidebar.sessionList") private var showsSessionList = false
    @State private var collapsedProjects: Set<String> = []

    private static let contentInset: CGFloat = 14

    private var workspace: Workspace { controller.workspace }
    private var sessions: [Workspace.Session] {
        workspace.sessions.sorted { lhs, rhs in
            let l = controller.activity(of: lhs.id) == .running, r = controller.activity(of: rhs.id) == .running
            return l != r ? l : lhs.updated_at > rhs.updated_at
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                SidebarSectionLabel(title: "设备")
                ForEach(workspace.devices) { device in
                    SidebarDeviceRow(device: device)
                }
                Button { showsPairing = true } label: {
                    Label("配对设备", appSymbol: "plus")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 46)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                let pinned = sessions.filter(\.pinned)
                if !pinned.isEmpty {
                    SidebarSectionLabel(title: "已置顶")
                    rows(pinned, inset: false, context: showsSessionList)
                }

                if showsSessionList {
                    HStack {
                        Text("最近").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        listMenu
                    }
                    .padding(.horizontal, 10).padding(.top, 16)
                    rows(sessions.filter { !$0.pinned }, inset: false, context: true)
                } else {
                    projects
                }
            }
            .padding(.leading, safeAreaInsets.leading + Self.contentInset)
            .padding(.trailing, safeAreaInsets.trailing + Self.contentInset)
            .environment(\.chatSidebarRowBleed, EdgeInsets(top: 0, leading: safeAreaInsets.leading + Self.contentInset,
                                                           bottom: 0, trailing: safeAreaInsets.trailing + Self.contentInset))
            .padding(.top, 10)
            .padding(.bottom, safeAreaInsets.bottom + 82)
        }
        .scrollIndicators(.hidden)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .overlay(alignment: .bottom) {
            HStack(spacing: 10) {
                AppGlassButton("新会话", systemImage: "square.and.pencil", style: .prominent, maxWidth: nil) {
                    controller.showToast("演示：新会话")
                }
                Spacer(minLength: 12)
                Button { showsAccount = true } label: {
                    AccountAvatarView(displayName: workspace.account.name, source: nil, size: 38)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("账号")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, safeAreaInsets.leading + 18)
            .padding(.trailing, safeAreaInsets.trailing + 18)
            .padding(.bottom, max(safeAreaInsets.bottom, 12))
        }
        .sheet(isPresented: $showsPairing) { DemoSheet(title: "配对设备", message: "演示环境：在电脑上运行 Connector，扫描这里的二维码即可配对。") }
        .sheet(isPresented: $showsAccount) { DemoSheet(title: workspace.account.name, message: workspace.account.email) }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .tint(.primary)
    }

    // MARK: Projects (by working folder, as in Effi Cloud)

    @ViewBuilder private var projects: some View {
        HStack {
            Text("项目").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                .frame(minHeight: 44)
            Spacer()
            listMenu
            Button("创建项目", appSymbol: "plus") { controller.showToast("演示：创建项目") }
                .modifier(ChatSidebarIconControlStyle())
        }
        .padding(.horizontal, 10).padding(.top, 16)
        ForEach(workspace.projects) { project in
            let expanded = !collapsedProjects.contains(project.id)
            HStack(spacing: 0) {
                Button {
                    if expanded { collapsedProjects.insert(project.id) } else { collapsedProjects.remove(project.id) }
                } label: {
                    HStack(spacing: 8) {
                        AppSymbol(expanded ? "folder.fill" : "folder", size: 18)
                        Text(project.name).font(.body).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
                }
                Button { controller.showToast("演示：在 \(project.name) 中新建会话") } label: {
                    AppSymbol("square.and.pencil", size: 18).frame(width: 44, height: 44).contentShape(.rect)
                }
            }
            .foregroundStyle(.primary)
            .padding(.leading, 10).buttonStyle(.plain)
            if expanded {
                rows(sessions.filter { $0.device_id == project.device_id && $0.cwd == project.cwd }, inset: true, context: false)
            }
        }
        let unassigned = sessions.filter { session in
            !workspace.projects.contains { $0.device_id == session.device_id && $0.cwd == session.cwd }
        }
        if !unassigned.isEmpty {
            SidebarSectionLabel(title: "未分组会话")
            rows(unassigned, inset: false, context: false)
        }
    }

    private var listMenu: some View {
        Menu {
            Picker("侧栏显示", selection: $showsSessionList) {
                Text("按项目").tag(false)
                Text("全部会话").tag(true)
            }
        } label: {
            Label("列表选项", appSymbol: "ellipsis")
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .modifier(ChatSidebarIconControlStyle())
    }

    private func rows(_ list: [Workspace.Session], inset: Bool, context: Bool) -> some View {
        LazyVStack(alignment: .leading, spacing: 2) {
            ForEach(Array(list.enumerated()), id: \.element.id) { index, session in
                SidebarSessionRow(
                    session: session,
                    activity: controller.activity(of: session.id),
                    isSelected: controller.selectedID == session.id,
                    context: context ? contextLine(session, after: index > 0 ? list[index - 1] : nil) : nil,
                    showsDivider: context && index < list.count - 1,
                    inset: inset,
                    onOpen: { onOpenSession(session.id) },
                    onTogglePinned: { togglePinned(session.id) }
                )
            }
        }
    }

    /// Web's flat-list second line: project, then the device (`^` when it repeats the row above).
    private func contextLine(_ session: Workspace.Session, after previous: Workspace.Session?) -> String {
        let project = workspace.projects.first { $0.device_id == session.device_id && $0.cwd == session.cwd }?.name
            ?? session.cwd.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
        let device = previous?.device_id == session.device_id ? "^"
            : workspace.devices.first { $0.id == session.device_id }?.name ?? session.device_id
        return [project, device].compactMap { $0 }.joined(separator: " · ")
    }

    private func togglePinned(_ id: String) {
        guard let index = controller.workspace.sessions.firstIndex(where: { $0.id == id }) else { return }
        controller.workspace.sessions[index].pinned.toggle()
    }
}

extension EnvironmentValues {
    /// Distance from a sidebar row to the sidebar edges; selection bars bleed through it.
    @Entry var chatSidebarRowBleed = EdgeInsets()
}

/// Give menu triggers and buttons the same native sizing.
struct ChatSidebarIconControlStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .buttonBorderShape(.circle)
            .controlSize(.large)
            .frame(width: 44, height: 44)
    }
}

struct ChatSidebarHeaderView: View {
    var body: some View {
        AAWordmark(fontSize: 24)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 18)
            .containerCornerOffset(.horizontal, sizeToFit: true)
    }
}

private struct SidebarSectionLabel: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, 20)
            .padding(.bottom, 6)
    }
}

private struct SidebarDeviceRow: View {
    let device: Workspace.Device
    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(device.isOnline ? .green : .secondary.opacity(0.45))
                .frame(width: 7, height: 7)
            Text(device.name)
                .font(.system(.subheadline, design: .monospaced))
                .foregroundStyle(device.isOnline ? .primary : .secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .frame(minHeight: 42)
        .contentShape(Rectangle())
    }
}

private struct SidebarSessionRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.chatSidebarRowBleed) private var bleed

    let session: Workspace.Session
    let activity: SessionActivity
    let isSelected: Bool
    let context: String?
    let showsDivider: Bool
    let inset: Bool
    let onOpen: () -> Void
    let onTogglePinned: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    SessionAgentIcon(runtime: session.agent, runtimeType: nil)
                        .foregroundStyle(.primary)
                    Text(session.title)
                        .font(.body).foregroundStyle(.primary)
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    SessionIndicator(activity: activity, unread: session.unread)
                }
                if let context {
                    Text(verbatim: context).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, inset ? 19 : 10)
            .padding(.trailing, 10)
            .padding(.vertical, context == nil ? 0 : 8)
            .frame(minHeight: 42)
            .background {
                if isSelected {
                    Rectangle().fill(AppTheme.sidebarSelectionFill(colorScheme))
                        .padding(.leading, -bleed.leading).padding(.trailing, -bleed.trailing)
                }
            }
            .overlay(alignment: .bottom) {
                if showsDivider { Divider().padding(.horizontal, 10).offset(y: 2) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: onOpen) { Label("打开", systemImage: "folder.fill") }
            Button(action: onTogglePinned) { Label(session.pinned ? "取消置顶" : "置顶", systemImage: "pin") }
            Divider()
            Button { UIPasteboard.general.string = session.id } label: { Label("复制会话 ID", systemImage: "doc.on.doc") }
        }
    }
}

/// The real app's `ChatSidebarSessionIndicator`, plus an error mark for `control.state == error`.
struct SessionIndicator: View {
    let activity: SessionActivity
    let unread: Bool
    var body: some View {
        switch activity {
        case .waiting:
            Text("等待批准").font(.system(size: 11, weight: .medium))
                .foregroundStyle(.mint).padding(.horizontal, 8).padding(.vertical, 3)
                .background(.mint.opacity(0.16), in: .capsule)
                .fixedSize()
        case .running:
            ProgressView().controlSize(.mini).tint(.primary).frame(width: 14, height: 14)
        case .error, .disconnected:
            AppSymbol("exclamationmark.circle", size: 14).foregroundStyle(.red)
        case .idle:
            if unread { Circle().fill(.green).frame(width: 8, height: 8) }
        }
    }
}

/// Placeholder for flows the PoC does not implement (pairing, account).
struct DemoSheet: View {
    let title: String
    let message: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .presentationDetents([.medium])
    }
}
