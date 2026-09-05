import SwiftUI

struct NewSessionView: View, Equatable {
    @Bindable var model: NewSessionModel
    let connectors: [V2Connector]
    let sessions: [V2SessionMeta]
    let safeAreaInsets: EdgeInsets
    var dashboardLoading = false
    var dashboardError: String?
    let onMenu: () -> Void
    let onManageDevice: (String) -> Void
    let onCreated: (V2SessionMeta) -> Void
    let onRefresh: () async -> [V2Connector]
    @State private var showsTarget = false
    @State private var showsWorkspace = false
    @State private var confirmsRetry = false
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22

    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.connectors == rhs.connectors && lhs.sessions == rhs.sessions
            && lhs.safeAreaInsets == rhs.safeAreaInsets && lhs.dashboardLoading == rhs.dashboardLoading
            && lhs.dashboardError == rhs.dashboardError
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "sparkles").font(.system(size: 28)).foregroundStyle(.primary)
                        Text("从这里开始").font(.largeTitle.bold())
                        Text("选择运行任务的设备和 Agent，\n把想做的事交给它。")
                            .font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 26)

                    VStack(alignment: .leading, spacing: 12) {
                        Text("运行目标").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        targetCard
                        Button { showsWorkspace = true } label: {
                            HStack(spacing: 14) {
                                Image(systemName: "folder").font(.title3).foregroundStyle(.primary).frame(width: 24)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("工作目录").font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                                    Text(model.workspace.isEmpty ? "使用 Agent 的默认目录" : model.workspace)
                                        .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            }
                            .padding(18).background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 22))
                        }
                        .buttonStyle(.plain)
                        .disabled(model.connector == nil || model.isCreating)
                    }

                    connectionStatus
                    if model.isCreating { Label("正在创建会话…", systemImage: "arrow.up.circle").font(.subheadline).foregroundStyle(.secondary) }
                    if let error = model.error {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(error).font(.subheadline).foregroundStyle(.secondary)
                            if model.creationUncertain {
                                Button("查看会话列表", action: onMenu)
                                Button("已检查，重新创建") { confirmsRetry = true }
                            } else {
                                Button("重新连接") { Task { await refresh() } }
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
            .refreshable { await refresh() }
            .safeAreaInset(edge: .top, spacing: 0) {
                ChatPageHeader(title: "Agents Anywhere", controls: controls, onMenu: onMenu) {
                    Button { model.draft.isFocused = true } label: {
                        ChatHeaderActionLabel(symbol: "square.and.pencil", controls: controls)
                            .glassEffect(.regular.interactive(), in: .circle)
                    }.accessibilityLabel("开始新会话")
                }
            }
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
        .modifier(ChatPageSafeArea(insets: safeAreaInsets))
        .task(id: TargetRefreshKey(connectors: connectors, network: model.network)) { await model.refresh(connectors: connectors) }
        .sheet(isPresented: $showsTarget) {
            SessionTargetSheet(model: model, onManageDevice: { id in showsTarget = false; onManageDevice(id) })
        }
        .sheet(isPresented: $showsWorkspace) {
            SessionWorkspaceSheet(model: model, recent: V2DeviceProjection.workspaces(
                sessions: sessions.filter { $0.connectorId == model.connectorID }))
        }
        .confirmationDialog("创建结果仍未确认，再次创建可能产生重复会话。", isPresented: $confirmsRetry, titleVisibility: .visible) {
            Button("保留草稿并允许重新创建") { model.acknowledgeUncertainCreation() }
            Button("取消", role: .cancel) {}
        }
    }

    private var targetCard: some View {
        Button { showsTarget = true } label: {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Image(systemName: "desktopcomputer").font(.system(size: 24)).foregroundStyle(.primary).frame(width: 32)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.connector?.name ?? "选择设备").font(.headline).foregroundStyle(.primary)
                        Text(model.connector?.status == .online ? "在线" : model.connector == nil ? "你的任务将在所选设备上运行" : "设备离线")
                            .font(.footnote).foregroundStyle(model.connector?.status == .online ? .green : .secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                Divider()
                HStack(spacing: 14) {
                    Image(systemName: "sparkle").font(.system(size: 23)).foregroundStyle(.primary).frame(width: 32)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.runtime?.sessionDisplayName ?? "选择 Agent").font(.headline).foregroundStyle(.primary)
                        Text(model.runtime?.typeDisplayName ?? "从这台设备已配置的实例中选择")
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
        .accessibilityLabel("选择设备和 Agent")
        .accessibilityIdentifier("chat.new.target")
    }

    @ViewBuilder private var connectionStatus: some View {
        if model.network.availability == .offline {
            status("手机网络已断开", detail: "草稿和运行目标已保留，网络恢复后会重新检查。", icon: "wifi.slash")
        } else if dashboardLoading && connectors.isEmpty {
            ProgressView("正在查找设备…")
        } else if connectors.isEmpty {
            status("还没有可用设备", detail: dashboardError ?? "从侧栏添加设备，连接后即可开始。", icon: "desktopcomputer")
            Button("打开侧栏", action: onMenu)
        } else if model.connector?.status != .online {
            status("目标设备离线", detail: "等待它重新连接，或选择其他在线设备。草稿会继续保留。", icon: "bolt.horizontal.circle")
            Button("选择其他设备") { showsTarget = true }
        } else if !model.isPreparing && model.runtime?.isReadyForSession != true {
            status("选择一个已就绪的 Agent", detail: "可在设备管理中配置或启动实例。", icon: "sparkle")
            Button("选择 Agent") { showsTarget = true }
        }
    }

    private func status(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon).font(.subheadline.weight(.medium))
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
}
