import SwiftUI
import UIKit

struct NewSessionView: View, Equatable {
    @Bindable var model: NewSessionModel
    let connectors: [V2Connector]
    let sessions: [V2SessionMeta]
    let repository: V2DashboardRepository
    var dashboardLoading = false
    var dashboardError: String?
    let onMenu: () -> Void
    let onOpenDevice: (V2ConnectorID) -> Void
    let onCreated: (V2SessionMeta) -> Void
    let onRefresh: () async -> [V2Connector]
    @State private var showsTarget = false
    @State private var showsWorkspace = false
    @State private var showsFiles = false
    @EnvironmentObject private var appState: AppState
    @State private var confirmsRetry = false
    @AppStorage(ProjectSidebarPreferences.sessionListKey) private var showsSessionList = false
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22

    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.connectors == rhs.connectors && lhs.sessions == rhs.sessions
            && lhs.dashboardLoading == rhs.dashboardLoading
            && lhs.dashboardError == rhs.dashboardError
    }

    var body: some View {
        GeometryReader { geometry in
            GeometryReader { viewport in
                ScrollView {
                    NewSessionContentLayout(viewportHeight: max(0, viewport.size.height - 48)) {
                        NewSessionWelcomeView(deviceName: model.connector?.name,
                            agentName: model.runtime?.sessionDisplayName,
                            onChooseTarget: chooseTarget)
                        statusContent
                    }
                        .padding(24)
                        .frame(maxWidth: 760)
                        .frame(maxWidth: .infinity)
                        .background { ChatPageScrollEdge() }
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollEdgeEffectStyle(.soft, for: .top)
                .refreshable { await refresh() }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    // Follows the composer's glass edge in both states, a few
                    // points inside it and slightly apart, to sit balanced.
                    workspaceButton
                        .padding(.horizontal, model.draft.isExpanded
                            ? ChatControlMetrics.expandedHorizontalInset : ChatControlMetrics.collapsedHorizontalInset)
                        .padding(.leading, 6)
                        .padding(.bottom, 6)
                ChatComposerDock(draft: model.draft, settings: model.settings,
                    maximumEditorHeight: min(160, max(72, geometry.size.height * 0.30)), controls: controls,
                    canSend: model.canCreate, canAttach: model.canAttach && model.prepared != nil,
                    canSelectModel: model.prepared?.capabilities.allows("catalog.model") == true,
                    canSelectPermission: model.prepared?.capabilities.allows("catalog.permission") == true,
                    isBusy: model.isCreating, isLoadingSettings: model.isPreparing,
                    onSend: { text in if let session = await model.create(text: text) { onCreated(session) } },
                    onApplySettings: { model.saveSelections(); return true },
                    onDraftChange: { model.saveDraft() })
                }
                .frame(maxWidth: ChatControlMetrics.maximumContentWidth).frame(maxWidth: .infinity)
            }
        }
        .modifier(ChatPageToolbar(title: "", onMenu: onMenu))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showsFiles = true } label: { AppSymbol("folder") }
                    .disabled(!canBrowse)
                    .accessibilityLabel(String(localized: "浏览文件"))
                    .accessibilityIdentifier("chat.new.files")
            }
            ToolbarItem(placement: .topBarTrailing) { deviceMenu }
        }
        .sheet(isPresented: $showsTarget) {
            SessionTargetSheet(model: model)
        }
        .sheet(isPresented: $showsWorkspace) {
            ProjectSelectionSheet(model: model, repository: repository)
        }
        .sheet(isPresented: $showsFiles) {
            if let device = model.connector, let service = appState.workspaceFilesService {
                WorkspaceFilesSheet(connectorId: device.id, deviceName: device.name,
                    workspace: .init(path: model.workspace.isEmpty ? "~" : model.workspace,
                                     name: workspaceName, sessionCount: 0, lastActiveAt: nil),
                    service: service)
            }
        }
        .confirmationDialog(String(localized: "创建结果仍未确认，再次创建可能产生重复会话。"), isPresented: $confirmsRetry, titleVisibility: .visible) {
            Button(String(localized: "保留草稿并允许重新创建")) { model.acknowledgeUncertainCreation() }
            Button(String(localized: "取消"), role: .cancel) {}
        }
    }

    private var statusContent: some View {
        VStack(alignment: .leading, spacing: 28) {
            connectionStatus
            if model.isCreating {
                Label(String(localized: "正在创建会话…"), appSymbol: "arrow.up.circle")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let error = model.error {
                VStack(alignment: .leading, spacing: 12) {
                    Text(error).font(.subheadline).foregroundStyle(.secondary)
                    if model.creationUncertain {
                        Button(String(localized: "查看会话列表"), action: onMenu)
                        Button(String(localized: "已检查，重新创建")) { confirmsRetry = true }
                    } else {
                        Button(String(localized: "重新连接")) { Task { await refresh() } }
                    }
                }
            }
        }
        .multilineTextAlignment(.leading)
    }

    private var workspaceButton: some View {
        Button { showsWorkspace = true } label: {
            HStack(spacing: 6) {
                AppSymbol("folder", size: 14).foregroundStyle(.secondary)
                Text(workspaceName).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                    .lineLimit(1).layoutPriority(1)
                if !model.workspace.isEmpty {
                    Text(model.workspace).font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                if model.loadingHomes.contains(model.connectorID), model.workspace.isEmpty {
                    ProgressView().controlSize(.mini)
                } else { AppSymbol("chevron.down", size: 12).foregroundStyle(.secondary) }
            }
            .padding(.top, 8)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(model.connector == nil || model.isCreating)
    }

    private var deviceMenu: some View {
        // Menu rows use SF Symbols like the rest of the system menu.
        Menu {
            Button(String(localized: "选择设备和 Agent"), systemImage: "sparkles") { chooseTarget() }
            Button(String(localized: "选择工作目录"), systemImage: "folder") { showsWorkspace = true }
                .disabled(model.connector == nil)
            if let device = model.connector {
                Divider()
                Button(String(localized: "设备详情"), systemImage: "info.circle") { onOpenDevice(device.id) }
                Button(String(localized: "Copy device ID"), systemImage: "doc.on.doc") { UIPasteboard.general.string = device.id }
            }
        } label: {
            if model.isPreparing { ProgressView().controlSize(.mini) } else { AppSymbol("ellipsis") }
        }
        .disabled(model.isCreating)
        .accessibilityLabel(String(localized: "Device actions"))
        .accessibilityIdentifier("chat.new.target")
    }

    private var canBrowse: Bool {
        model.connector?.status == .online && model.network.availability != .offline && model.isValid && !model.isCreating
            && appState.workspaceFilesService != nil
    }

    private func chooseTarget() {
        model.draft.isFocused = false
        showsTarget = true
    }

    @ViewBuilder private var connectionStatus: some View {
        if model.network.availability == .offline {
            status(String(localized: "手机网络已断开"), detail: String(localized: "草稿和运行目标已保留，网络恢复后会重新检查。"), icon: "wifi.slash")
        } else if dashboardLoading && connectors.isEmpty {
            ProgressView(String(localized: "正在查找设备…"))
        } else if connectors.isEmpty {
            status(String(localized: "还没有可用设备"), detail: dashboardError ?? String(localized: "从侧栏添加设备，连接后即可开始。"), icon: "desktopcomputer")
            Button(String(localized: "打开侧栏"), action: onMenu)
        } else if model.connector?.status != .online {
            status(String(localized: "目标设备离线"), detail: String(localized: "等待它重新连接，或选择其他在线设备。草稿会继续保留。"), icon: "bolt.horizontal.circle")
            Button(String(localized: "选择其他设备")) { showsTarget = true }
        } else if model.workspace.isEmpty, let error = model.homeErrors[model.connectorID] {
            status(String(localized: "无法解析设备家目录"), detail: error, icon: "folder")
            Button(String(localized: "选择工作目录")) { showsWorkspace = true }
        } else if !model.isPreparing && !model.loadingDevices.contains(model.connectorID)
                    && (model.inventories[model.connectorID] != nil || model.inventoryErrors[model.connectorID] != nil)
                    && model.runtime?.isReadyForSession != true {
            status(String(localized: "选择一个已就绪的 Agent"),
                detail: model.inventoryErrors[model.connectorID] ?? String(localized: "可在设备管理中配置或启动实例。"), icon: "sparkle")
            Button(String(localized: "选择 Agent")) { showsTarget = true }
        }
    }

    private var workspaceName: String {
        if !showsSessionList, let project = model.project { return project.name }
        if model.isHome || model.workspace.isEmpty { return String(localized: "Home 目录") }
        return ProjectWorkspacePath.name(model.workspace)
    }

    private func status(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, appSymbol: icon).font(.subheadline.weight(.medium))
            Text(detail).font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func refresh() async {
        let current = await onRefresh()
        await model.refresh(connectors: current)
    }
}

/// Center the welcome and workspace alone. Notices flow below that anchor and
/// extend the scrollable page when needed, rather than recentering the welcome.
private struct NewSessionContentLayout: Layout {
    let viewportHeight: CGFloat
    private let spacing: CGFloat = 28

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.replacingUnspecifiedDimensions().width
        let childProposal = ProposedViewSize(width: width, height: nil)
        let welcome = subviews[0].sizeThatFits(childProposal)
        let status = subviews[1].sizeThatFits(childProposal)
        let top = max(0, (viewportHeight - welcome.height) / 2)
        let statusHeight = status.height > 0 ? spacing + status.height : 0
        return CGSize(width: width, height: max(viewportHeight, top + welcome.height + statusHeight))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let childProposal = ProposedViewSize(width: bounds.width, height: nil)
        let welcome = subviews[0].sizeThatFits(childProposal)
        let top = max(0, (viewportHeight - welcome.height) / 2)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY + top), anchor: .topLeading, proposal: childProposal)
        subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + top + welcome.height + spacing),
            anchor: .topLeading, proposal: childProposal)
    }
}
