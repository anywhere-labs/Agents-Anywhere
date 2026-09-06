import SwiftUI

struct NewSessionView: View, Equatable {
    @Bindable var model: NewSessionModel
    let connectors: [V2Connector]
    let sessions: [V2SessionMeta]
    let repository: V2DashboardRepository
    var dashboardLoading = false
    var dashboardError: String?
    let onMenu: () -> Void
    let onManageDevice: (String) -> Void
    let onCreated: (V2SessionMeta) -> Void
    let onRefresh: () async -> [V2Connector]
    @State private var showsTarget = false
    @State private var showsWorkspace = false
    @State private var confirmsRetry = false
    @AppStorage(ProjectSidebarPreferences.sessionListKey) private var showsSessionList = false
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22

    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.connectors == rhs.connectors && lhs.sessions == rhs.sessions
            && lhs.dashboardLoading == rhs.dashboardLoading
            && lhs.dashboardError == rhs.dashboardError
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 12) {
                        AppSymbol("sparkles", size: 28).foregroundStyle(.primary)
                        Text(String(localized: "从这里开始")).font(.largeTitle.bold())
                        Text(String(localized: "选择运行任务的设备和 Agent，\n把想做的事交给它。"))
                            .font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 26)

                    VStack(alignment: .leading, spacing: 12) {
                        Text(String(localized: "运行目标")).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        targetCard
                        Button { showsWorkspace = true } label: {
                            HStack(spacing: 6) {
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
                            .padding(.vertical, 12)
                            .overlay(alignment: .bottom) { Rectangle().fill(.secondary.opacity(0.35)).frame(height: 1) }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.connector == nil || model.isCreating)
                    }

                    connectionStatus
                    if model.isCreating { Label(String(localized: "正在创建会话…"), appSymbol: "arrow.up.circle").font(.subheadline).foregroundStyle(.secondary) }
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
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
                .frame(maxWidth: 650)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .refreshable { await refresh() }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ChatComposerDock(draft: model.draft, settings: model.settings,
                    maximumEditorHeight: min(160, max(72, geometry.size.height * 0.30)), controls: controls,
                    canSend: model.canCreate, canAttach: model.canAttach && model.prepared != nil,
                    canSelectModel: model.prepared?.capabilities.allows("catalog.model") == true,
                    canSelectPermission: model.prepared?.capabilities.allows("catalog.permission") == true,
                    isBusy: model.isCreating, isLoadingSettings: model.isPreparing,
                    onSend: { text in if let session = await model.create(text: text) { onCreated(session) } },
                    onApplySettings: { model.saveSelections(); return true })
            }
        }
        .modifier(ChatPageToolbar(title: String(localized: "Agents Anywhere"), onMenu: onMenu))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { model.draft.isFocused = true } label: { AppSymbol("square.and.pencil") }
                    .accessibilityLabel(String(localized: "开始新会话"))
            }
        }
        .onChange(of: model.draft.text) { _, _ in model.saveDraft() }
        .task(id: TargetRefreshKey(connectors: connectors, network: model.network, connectorID: model.connectorID)) { await model.refresh(connectors: connectors) }
        .sheet(isPresented: $showsTarget) {
            SessionTargetSheet(model: model, onManageDevice: { id in showsTarget = false; onManageDevice(id) })
        }
        .sheet(isPresented: $showsWorkspace) {
            ProjectSelectionSheet(model: model, repository: repository)
        }
        .confirmationDialog(String(localized: "创建结果仍未确认，再次创建可能产生重复会话。"), isPresented: $confirmsRetry, titleVisibility: .visible) {
            Button(String(localized: "保留草稿并允许重新创建")) { model.acknowledgeUncertainCreation() }
            Button(String(localized: "取消"), role: .cancel) {}
        }
    }

    private var targetCard: some View {
        Button { showsTarget = true } label: {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    AppSymbol("desktopcomputer", size: 24).foregroundStyle(.primary).frame(width: 32)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.connector?.name ?? String(localized: "选择设备")).font(.headline).foregroundStyle(.primary)
                        Text(model.connector?.status == .online ? String(localized: "在线") : model.connector == nil ? String(localized: "你的任务将在所选设备上运行") : String(localized: "设备离线"))
                            .font(.footnote).foregroundStyle(model.connector?.status == .online ? .green : .secondary)
                    }
                    Spacer()
                    AppSymbol("chevron.right", size: 14).foregroundStyle(.secondary)
                }
                Divider()
                HStack(spacing: 14) {
                    AppSymbol("sparkle", size: 23).foregroundStyle(.primary).frame(width: 32)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.runtime?.sessionDisplayName ?? String(localized: "选择 Agent")).font(.headline).foregroundStyle(.primary)
                        Text(model.runtime?.typeDisplayName ?? String(localized: "从这台设备已配置的实例中选择"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.isPreparing { ProgressView().controlSize(.small) }
                }
            }
            .padding(20)
            .background(AppTheme.groupedFill(colorScheme), in: .rect(cornerRadius: 26))
        }
        .buttonStyle(.plain)
        .disabled(model.isCreating)
        .accessibilityLabel(String(localized: "选择设备和 Agent"))
        .accessibilityIdentifier("chat.new.target")
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
        } else if !model.isPreparing && model.runtime?.isReadyForSession != true {
            status(String(localized: "选择一个已就绪的 Agent"), detail: String(localized: "可在设备管理中配置或启动实例。"), icon: "sparkle")
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

private struct TargetRefreshKey: Equatable {
    let connectors: [V2Connector]
    let network: V2NetworkStatus
    let connectorID: String
}
