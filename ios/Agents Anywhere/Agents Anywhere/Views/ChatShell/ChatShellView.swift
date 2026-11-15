import SwiftUI
import UIKit

struct ChatShellView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var agentReminderCheckedScope: ObjectIdentifier?
    @State private var showsAgentReminder = false
    @State private var showsReminderPairing = false

    /// 「侧栏状态记忆」（优先级高于启动默认）：开启时启动恢复上次
    /// 分栏侧栏开合状态。
    @AppStorage(ChatSidebarState.rememberStateDefaultsKey) private var rememberSidebarState = false

    // 启动默认：记忆开启且有快照 → 上次状态；否则「启动时展开侧栏」。
    // 仅影响分栏形态的初始态。
    @State private var sidebar = ChatSidebarState(defaultOpen: {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: ChatSidebarState.rememberStateDefaultsKey),
           defaults.object(forKey: ChatSidebarState.lastOpenDefaultsKey) is Bool {
            return defaults.bool(forKey: ChatSidebarState.lastOpenDefaultsKey)
        }
        return defaults.object(forKey: ChatSidebarState.openOnLaunchDefaultsKey) as? Bool ?? true
    }())
    @State private var newSessionPresentationID = UUID()
    /// 会话页/新会话页 composer 玻璃共享的 namespace：detail 切换时同 ID
    /// glass 做 matched 过渡，避免新页 glass 单独"泡泡式"出现（Duo 横屏
    /// 宽 detail 下肉眼可见的大圆闪现）。
    @Namespace private var composerGlass
    @State private var showsRailAccountSettings = false
    private var selection: ChatShellSelection {
        get { appState.chatSelection }
        nonmutating set { appState.chatSelection = newValue }
    }

    var body: some View {
        // NavigationSplitView adapts to a single stack in a compact system size
        // class. Use that same system trait for the drawer fallback, never a
        // device model, screen measurement or custom window-width breakpoint.
        let layout = ChatSidebarState.Layout.resolve(
            hasRegularWidth: horizontalSizeClass == .regular
        )
        // Regular width keeps the native split sidebar; compact width uses the
        // original drawer, including the Duo cover screen. Duo-only entries
        // ride the rail injected below — the system places them in the top bar
        // or the right edge, we never choose the edge ourselves.
        sidebarLayout(layout)
        .onChange(of: layout, initial: true) { _, next in sidebar.setLayout(next) }
        // 侧栏状态记忆：分栏形态下开合变化即时快照（含开关刚打开时
        // 立即落当前值，避免"开启记忆后首启仍用默认"的空窗）。
        .onChange(of: sidebar.isOpen) { _, isOpen in
            if rememberSidebarState, sidebar.layout == .regularSplit {
                UserDefaults.standard.set(isOpen, forKey: ChatSidebarState.lastOpenDefaultsKey)
            }
        }
        .onChange(of: rememberSidebarState) { _, remember in
            if remember, sidebar.layout == .regularSplit {
                UserDefaults.standard.set(sidebar.isOpen, forKey: ChatSidebarState.lastOpenDefaultsKey)
            }
        }
        .task(id: NewSessionLoadKey(target: appState.nativeChatServices?.newSession.refreshKey,
            presentationID: newSessionPresentationID)) {
            // Warm the next draft even when launch restores a session/device.
            // Remounting the welcome view no longer starts its first data load.
            guard let model = appState.nativeChatServices?.newSession else { return }
            await model.refresh(connectors: appState.connectors)
        }
        // Like Web's runtimeChannelKey: a runtime on another channel offers other models.
        .task(id: appState.nativeChatServices?.newSession.runtimeChannel) {
            await appState.nativeChatServices?.newSession.prepareAfterChannelChange()
        }
        .alert(String(localized: "Could not update session"), isPresented: sessionActionErrorBinding) {
            Button(String(localized: "OK"), role: .cancel) {
                appState.dismissSessionActionError()
            }
        } message: {
            Text(appState.sessionActionError ?? "")
        }
        .sheet(item: agentSetupBinding) { connector in
            if let services = appState.nativeChatServices {
                AgentSetupSheet(connector: connector, model: services.agents(on: connector.id)) {
                    services.agentSetup.finish(connector.id)
                    Task { await appState.refreshDashboard() }
                }
            }
        }
        .task(id: agentReminderKey) { await checkAgentReminder() }
        .alert(String(localized: "agentReminder.title"), isPresented: $showsAgentReminder) {
            Button(String(localized: "agentReminder.add")) {
                guard let services = appState.nativeChatServices else { return }
                if let connector = appState.connectors.first(where: { $0.status == .online }) {
                    services.agentSetup.watch(connector)
                    services.agentSetup.configure(connector.id)
                } else if let connector = appState.connectors.first {
                    selection = .device(connector.id)
                } else {
                    services.agentSetup.pairingFormPresented = true
                    showsReminderPairing = true
                }
            }
            Button(String(localized: "agentReminder.later"), role: .cancel) {}
        } message: { Text(String(localized: "agentReminder.description")) }
        .sheet(isPresented: $showsReminderPairing, onDismiss: {
            appState.nativeChatServices?.agentSetup.pairingFormPresented = false
            agentReminderCheckedScope = nil
        }) { PairDeviceSheet() }
        .onChange(of: visibleSessionID, initial: true) { _, id in
            appState.setVisibleSession(id)
        }
        .onDisappear { appState.setVisibleSession(nil) }
    }

    private var agentReminderKey: String {
        let scope = appState.nativeChatServices.map { String(describing: ObjectIdentifier($0)) } ?? ""
        let devices = appState.connectors.map { $0.id }.joined(separator: ",")
        return "\(scope):\(devices):\(appState.hasLoadedConnectors):\(appState.isDashboardLoading):\(appState.nativeChatServices?.dashboardRepository.isFresh == true):\(selection == .newSession):\(appState.nativeChatServices?.agentSetup.pairingFormPresented == true)"
    }

    private func checkAgentReminder() async {
        guard let services = appState.nativeChatServices,
              agentReminderCheckedScope != ObjectIdentifier(services),
              appState.hasLoadedConnectors, !appState.isDashboardLoading, services.dashboardRepository.isFresh,
              selection == .newSession, !services.agentSetup.pairingFormPresented,
              services.agentSetup.presentedConnector == nil else { return }
        do {
            let configured = try await services.deviceManagement.hasConfiguredAgents(connectors: appState.connectors)
            guard !Task.isCancelled, appState.nativeChatServices === services else { return }
            agentReminderCheckedScope = ObjectIdentifier(services)
            showsAgentReminder = !configured
        } catch { /* A failed inventory read is not an empty inventory. */ }
    }

    private var agentSetupBinding: Binding<V2Connector?> {
        Binding(get: { appState.nativeChatServices?.agentSetup.presentedConnector }, set: { value in
            if value == nil, let setup = appState.nativeChatServices?.agentSetup, let connector = setup.presentedConnector {
                setup.finish(connector.id)
            }
        })
    }

    private var sidebarDevices: [ChatSidebarDevice] {
        appState.connectors.map { connector in
            ChatSidebarDevice(connector: connector)
        }
    }

    private var sidebarAccount: ChatSidebarAccount? {
        guard let me = appState.me else { return nil }
        return ChatSidebarAccount(me: me, avatarSource: appState.accountAvatarSource)
    }

    /// 右缘竖排头像的像素层缓存：source 变化时在 onChange（body 求值外）
    /// 重渲染，body 高频重算只读缓存。
    @State private var railAvatarCache: (source: AccountAvatarImageSource, image: UIImage)?

    /// 右缘竖排的真实头像（读缓存）；remote/无图走 symbol。竖排容器只收
    /// 零修饰 label——显示原始尺寸，裁剪/缩放必须在图片像素层完成
    ///（居中裁方 + 圆形蒙版，38pt 对齐侧栏头像视觉）。
    private var railAvatarImage: UIImage? {
        guard let source = appState.accountAvatarSource,
              let cache = railAvatarCache, cache.source == source else { return nil }
        return cache.image
    }

    /// 渲染竖排头像（onChange 驱动，不在 body 求值内写 state）。
    private func updateRailAvatar() {
        guard let source = appState.accountAvatarSource,
              railAvatarCache?.source != source else { return }
        guard case let .data(data) = source,
              let image = AccountAvatarImageCache.image(for: data) else {
            railAvatarCache = nil
            return
        }
        let shortest = min(image.size.width, image.size.height)
        let cropRect = CGRect(x: (image.size.width - shortest) / 2,
                              y: (image.size.height - shortest) / 2, width: shortest, height: shortest)
        guard let cropped = image.cgImage?.cropping(to: cropRect) else { return }
        // scale=3：points 的 3x 像素。scale=1 会把像素数当成 pt 渲染
        //——竖排里巨大（真机实证）。
        let points = 38 as CGFloat
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 3
        railAvatarCache = (source, UIGraphicsImageRenderer(size: CGSize(width: points, height: points), format: format).image { _ in
            let rect = CGRect(x: 0, y: 0, width: points, height: points)
            UIBezierPath(ovalIn: rect).addClip()
            UIImage(cgImage: cropped).draw(in: rect)
        })
    }

    private var sidebarSessions: [ChatSidebarSession] {
        appState.sessions
            .filter { !$0.archived }
            .map { session in
                ChatSidebarSession(session: session)
            }
            .sorted { $0.presentation.precedes($1.presentation, id: $0.id, otherID: $1.id) }
    }

    private var visibleSessionID: V2SessionID? {
        scenePhase == .active && !sidebar.obscuresDetail ? selectedSessionId : nil
    }

    private func sidebarLayout(_ layout: ChatSidebarState.Layout) -> some View {
        // Map and sort the session list once per body, not once per section.
        let sessions = sidebarSessions
        let services = appState.nativeChatServices
        return SidebarDrawer(
            isOpen: sidebarBinding(for: layout),
            presentation: layout == .regularSplit ? .nativeSidebar : .drawer,
            configuration: .chat
        ) { _ in
            // 侧栏头部（新会话/头像）不随键盘避让上移：键盘是 detail 列
            // 输入框的事，侧栏顶上来只会挤走会话列表空间。
            ChatSidebarHeaderView()
                .ignoresSafeArea(.keyboard)
        } sidebar: { safeAreaInsets in
            ChatSidebarView(
                appState: appState,
                agentSetup: services?.agentSetup,
                safeAreaInsets: safeAreaInsets,
                devices: sidebarDevices,
                pinnedSessions: sessions.filter(\.pinned),
                recentSessions: sessions.filter { !$0.pinned },
                repository: services?.dashboardRepository,
                onNewProjectSession: startProjectSession,
                onRestoreSession: { await appState.setSessionArchived(sessionId: $0, archived: false) },
                account: sidebarAccount,
                // 内屏双栏：rail 竖排常驻可见，侧栏底栏清空不重复。
                // 合盖外屏保留底栏——抽屉展开会盖住 detail 顶栏，rail 此时
                // 不可见，没有底栏就失去新会话/账号入口。
                showsBottomControls: !(isDuoFoldableIPhone && layout == .regularSplit),
                selectedDeviceId: selectedDeviceId,
                selectedSessionId: selectedSessionId,
                isLoadingDevices: appState.isDashboardLoading && !appState.hasLoadedConnectors,
                isLoadingSessions: appState.isDashboardLoading && !appState.hasLoadedSessions,
                onNewSession: startNewSession,
                onOpenDevice: openDevice,
                onOpenSpecRune: openSpecRune,
                specRuneDeviceId: specRuneDeviceId,
                onOpenSession: openSession,
                onRenameSession: renameSession,
                onToggleSessionPinned: setSessionPinned,
                onArchiveSession: archiveSession,
                onCopyDeviceId: copyDeviceId,
                onCopySessionId: copySessionId
            )
            // 直板抽屉形态的防御层：弹键盘后展开侧栏的转场中，键盘
            // safe area 变化与 ScrollView 布局可能互相触发循环（真机
            // 曾剧烈抖动）。根因已在 NativeComposerEditor（异步焦点块
            // 改读实时意图），此挂载保留双保险；底栏随键盘上移在抽屉
            // 形态留作遗留（insets 是 GeometryReader 参数污染，修在
            // 内容层无效）。
            .ignoresSafeArea(.keyboard)
        } content: { safeAreaInsets in
            mainContent
                .modifier(ChatDetailNavigation(insets: safeAreaInsets))
                .environment(\.composerGlassNamespace, composerGlass)
                // Duo 内屏两个方向都注入（用户决策 2026-10-28：竖屏
                // 遵循横排同一套逻辑）——横排系统重排成右缘竖排、竖排
                // 落顶部导航栏，placement 恒为 topBarTrailing 由系统
                // 自行分派。注入恒定、结构恒定：键盘期增删/切换会在
                // 键盘收起后丢按钮（真机实证 2026-10-28 两轮）。
                .environment(\.chatRail, isDuoFoldableIPhone ? ChatRailContext(
                    onNewSession: startNewSession,
                    onAccount: { showsRailAccountSettings = true },
                    avatarImage: railAvatarImage) : nil)
                .onChange(of: appState.accountAvatarSource, initial: true) { _, _ in
                    updateRailAvatar()
                }
                .sheet(isPresented: $showsRailAccountSettings) {
                    AccountSettingsSheet(appState: appState)
                }
        }
    }

    private func sidebarBinding(for layout: ChatSidebarState.Layout) -> Binding<Bool> {
        Binding(get: { sidebar.isOpen(in: layout) }, set: { isOpen in
            sidebar.setLayout(layout)
            sidebar.isOpen = isOpen
        })
    }

    private var selectedDeviceId: V2ConnectorID? {
        guard case let .device(id) = selection else { return nil }
        return id
    }

    private var selectedSessionId: V2SessionID? {
        guard case let .session(id) = selection else { return nil }
        return id
    }

    private var selectedContentTitle: String? {
        switch selection {
        case .newSession:
            return nil
        case let .device(id):
            return appState.connectors.first { $0.id == id }?.name
        case let .session(id):
            return appState.sessions.first { $0.id == id }?.title
        case .specRune:
            return "SpecRune"
        }
    }

    private var sessionActionErrorBinding: Binding<Bool> {
        Binding(
            get: { appState.sessionActionError != nil },
            set: { isPresented in
                if !isPresented {
                    appState.dismissSessionActionError()
                }
            }
        )
    }

    @ViewBuilder
    private var mainContent: some View {
        if case let .specRune(connectorId) = selection,
           let workspaceFilesService = appState.workspaceFilesService
        {
            SpecRuneTasksView(
                connectorId: connectorId,
                projects: appState.projects.filter { $0.connectorId == connectorId },
                api: workspaceFilesService.connectorAPI
            )
            .id(connectorId)
        } else if case let .device(connectorId) = selection,
           let connector = appState.connectors.first(where: { $0.id == connectorId }),
           let clients = appState.nativeChatServices,
           let service = appState.deviceManagementService,
           let workspaceFilesService = appState.workspaceFilesService,
           let serverURL = appState.serverURL
        {
            DeviceManagementView(
                connector: connector,
                allSessions: appState.sessions,
                projects: appState.projects,
                agents: clients.agents(on: connectorId),
                dashboard: clients.dashboardRepository,
                service: service,
                workspaceFilesService: workspaceFilesService,
                serverURL: serverURL,
                onMenu: toggleSidebar,
                onOpenSession: openSession,
                onNewSession: { path in
                    if let model = appState.nativeChatServices?.newSession {
                        model.focusDevice(connectorId, workspace: path)
                    }
                    startNewSession()
                },
                onNewProjectSession: startProjectSession,
                onConnectorUpdated: appState.updateConnector,
                onConnectorDeleted: removeConnector,
                onSessionsUpdated: appState.updateSessions,
                onSetSessionsArchived: appState.setSessionsArchived
            )
            .id(connectorId)
        } else if let services = appState.nativeChatServices {
            if case let .session(id) = selection {
                let session = services.sessionRepository.session(id: id)
                let connectorID = session.metadata?.connectorId ?? appState.sessions.first { $0.id == id }?.connectorId
                SessionChatView(session: session, services: services,
                    deviceName: appState.connectors.first { $0.id == connectorID }?.name,
                    onMenu: toggleSidebar)
                    .equatable()
                    .id(id)
            } else {
                NewSessionView(model: services.newSession, connectors: appState.connectors, sessions: appState.sessions, repository: services.dashboardRepository,
                    dashboardLoading: appState.isDashboardLoading,
                    dashboardError: appState.connectorsError,
                    onMenu: toggleSidebar,
                    onOpenDevice: openDevice,
                    onCreated: { session in
                        appState.updateSession(session)
                        if case .newSession = selection { openSession(session.id) }
                    },
                    onRefresh: { await appState.refreshDashboard(); return appState.connectors })
                    .equatable()
                    .id(newSessionPresentationID)
            }
        } else {
            ChatShellPlaceholderPage(
                isConnecting: appState.isRetryingServerConnection,
                title: selectedContentTitle ?? "",
                onOpenSidebar: openSidebar
            )
        }
    }

    private func startProjectSession(_ id: String) {
        guard let services = appState.nativeChatServices else { return }
        services.newSession.updateProjects(services.dashboardRepository.projects)
        guard services.newSession.selectProject(id) else { return }
        startNewSession()
    }

    private func startNewSession() {
        // Reselecting this destination must also remount its local presentation
        // state, including the welcome reveal. The account still owns the draft.
        // 共享 draft 会把上一页的聚焦状态带进新页：异步焦点块随后弹起
        // 键盘又收起，横屏下像底部闪现一个大玻璃圆（真机报告）。
        // 进新会话页不继承焦点，键盘不弹。
        appState.nativeChatServices?.newSession.draft.isFocused = false
        newSessionPresentationID = UUID()
        selection = .newSession
        sidebar.selectDestination()
    }

    private func openDevice(_ id: V2ConnectorID) {
        selection = .device(id)
        sidebar.selectDestination()
    }

    private func openSession(_ id: V2SessionID) {
        selection = .session(id)
        sidebar.selectDestination()
    }

    /// 打开 SpecRune 任务看板（数据来自该设备上的项目）。
    private func openSpecRune(_ id: V2ConnectorID) {
        selection = .specRune(id)
        sidebar.selectDestination()
    }

    /// 当前是否停在看板上；用于侧栏高亮。
    private var specRuneDeviceId: V2ConnectorID? {
        if case let .specRune(id) = selection { return id }
        return nil
    }

    private func removeConnector(_ id: V2ConnectorID) {
        appState.removeConnector(connectorId: id)
        selection = .newSession
    }

    private func renameSession(_ id: V2SessionID, title: String) {
        Task {
            _ = await appState.renameSession(sessionId: id, title: title)
        }
    }

    private func setSessionPinned(_ id: V2SessionID, pinned: Bool) {
        Task {
            _ = await appState.setSessionPinned(sessionId: id, pinned: pinned)
        }
    }

    private func archiveSession(_ id: V2SessionID) {
        Task {
            let shouldArchive = appState.sessions.first { $0.id == id }?.archived != true
            let changed = await appState.setSessionArchived(sessionId: id, archived: shouldArchive)
            if changed && shouldArchive, selectedSessionId == id {
                selection = .newSession
            }
        }
    }

    private func copyDeviceId(_ id: V2ConnectorID) {
        UIPasteboard.general.string = id
    }

    private func copySessionId(_ id: V2SessionID) {
        UIPasteboard.general.string = id
    }

    private func toggleSidebar() {
        sidebar.isOpen.toggle()
    }

    private func openSidebar() {
        sidebar.isOpen = true
    }
}

private struct NewSessionLoadKey: Equatable {
    let target: NewSessionRefreshKey?
    let presentationID: UUID
}

private struct ChatShellPlaceholderPage: View {
    let isConnecting: Bool
    let title: String
    let onOpenSidebar: () -> Void

    var body: some View {
        Color(.systemBackground)
            .overlay {
                if isConnecting {
                    Label(String(localized: "正在连接，首次同步后即可保留本地内容"), appSymbol: "network")
                        .font(.footnote).foregroundStyle(.secondary).padding(24)
                }
            }
            .modifier(ChatPageToolbar(title: title, onMenu: onOpenSidebar))
    }
}

#Preview {
    ChatShellView()
        .environment(AppState())
        .preferredColorScheme(.dark)
}

/// 禁止系统 toolbar 折叠（右缘竖排被键盘折叠成死"…"）。iOS 27+ API，
/// 26 上原样返回（默认行为）。



