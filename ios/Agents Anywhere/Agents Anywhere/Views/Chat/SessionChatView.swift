import SwiftUI
import QuickLook

struct SessionChatView: View, Equatable {
    @State private var model: SessionChatModel
    private let sessionIdentity: V2SessionModel
    let deviceName: String?
    let safeAreaInsets: EdgeInsets
    let onMenu: () -> Void
    let onNewSession: () -> Void
    @State private var sheet: SessionSheet?
    @State private var expandedNoticeID: String?
    private let fileService: V2WorkspaceFilesService
    private let detailService: V2SessionDetailService
    private enum SessionSheet: Identifiable {
        case notices, details, files, preview(String, root: String? = nil)
        var id: String { switch self { case .notices: "notices"; case .details: "details"; case .files: "files"; case .preview(let path, let root): "file:\(root ?? ""):\(path)" } }
    }
    @State private var previewURL: URL?
    @State private var previewDirectory: URL?
    @State private var isDownloading = false
    @State private var toasts = ChatToastStore()
    @State private var headerHeight: CGFloat = 66
    @State private var pendingTakeover: Bool?
    @State private var hasStartedLoading = false
    @State private var isInitialPositioned = false
    @State private var openingAttempt = 0
    @State private var openingPositionFailed = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.sidebarDrawerIsTransitioning) private var sidebarIsTransitioning
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22
    @ScaledMetric(relativeTo: .footnote) private var takeoverPillHeight: CGFloat = 32

    init(session: V2SessionModel, services: V2ClientServices, deviceName: String?, safeAreaInsets: EdgeInsets,
         onMenu: @escaping () -> Void, onNewSession: @escaping () -> Void) {
        _model = State(initialValue: SessionChatModel(session: session, repository: services.sessionRepository, attachments: services.attachments,
            files: services.workspaceFiles))
        sessionIdentity = session
        self.deviceName = deviceName
        fileService = services.workspaceFiles; detailService = services.sessionDetail
        self.safeAreaInsets = safeAreaInsets; self.onMenu = onMenu; self.onNewSession = onNewSession
    }
    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }
    private var session: V2SessionModel { model.session }
    private var requiresTakeover: Bool { session.metadata?.takeover == false }
    // Sidebar motion changes the containing card, not the session. Observable
    // model changes and real size/environment changes still update this subtree.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.sessionIdentity === rhs.sessionIdentity && lhs.safeAreaInsets == rhs.safeAreaInsets && lhs.deviceName == rhs.deviceName
    }
    var body: some View {
        GeometryReader { geometry in
            Group {
                if hasStartedLoading {
                    ChatTimelineView(model: model, isInitialPositioned: $isInitialPositioned,
                        openingPositionFailed: $openingPositionFailed, openingAttempt: openingAttempt,
                        onAttachment: openAttachment, onFile: openFile)
                } else {
                    Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
                .overlay {
                    if isInitialPositioned && model.timeline.rows.isEmpty && model.timeline.pendingMessages.isEmpty {
                        VStack(spacing: 12) {
                            Text("在这里继续你的任务").foregroundStyle(.secondary)
                        }.allowsHitTesting(false)
                    }
                }
                .overlay { if !isInitialPositioned { openingMask } }
                .safeAreaBar(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        ChatPageHeader(title: session.metadata?.title ?? "会话",
                            subtitle: [session.metadata?.runtimeName ?? session.metadata?.runtime,
                                deviceName ?? session.metadata?.connectorId].compactMap { $0 }.joined(separator: " · "),
                            controls: controls, onMenu: onMenu) {
                            HStack(spacing: 0) {
                                Button(action: onNewSession) { ChatHeaderActionLabel(symbol: "square.and.pencil", controls: controls) }
                                    .accessibilityLabel("新建会话")
                                Menu {
                                    Button("会话详情与导出", systemImage: "info.circle") { sheet = .details }
                                    Button("文件管理", systemImage: "folder") { sheet = .files }
                                        .disabled(session.metadata?.cwd?.isEmpty != false)
                                    Button("复制会话 ID", systemImage: "number") { UIPasteboard.general.string = session.id }
                                } label: { ChatHeaderActionLabel(symbol: "ellipsis", controls: controls) }
                                .accessibilityLabel("会话菜单")
                            }.glassEffect(.regular.interactive(), in: .capsule)
                        }
                        connectionBar
                        if requiresTakeover { takeoverPill }
                    }
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        SessionInteractionDock(chat: model,
                            onShowAll: { expandedNoticeID = $0; sheet = .notices })
                        ChatComposerDock(draft: session.composer, settings: model.settings,
                            maximumEditorHeight: min(160, max(72, geometry.size.height * 0.30)), controls: controls,
                            canSend: session.canSend, canAttach: model.canAttach,
                            canSelectModel: session.runtime.allows("catalog.model"),
                            canSelectPermission: session.runtime.allows("catalog.permission"),
                            isStreaming: model.isRunning, canStop: session.runtime.allows("session.interrupt"),
                            isBusy: model.isWorking || !isInitialPositioned, placeholder: requiresTakeover ? "请先接管" : "询问 Agents",
                            isLoadingSettings: model.isLoadingSettings,
                            settingsError: model.settingsError, sessionChat: model,
                            onSend: model.send, onStop: model.interrupt, onLoadSettings: model.loadSettings,
                            onApplySettings: model.applySettings, applyError: { model.settingsError })
                    }
                    .frame(maxWidth: ChatControlMetrics.maximumContentWidth).frame(maxWidth: .infinity)
                }
                .overlay(alignment: .top) {
                    ChatErrorToasts(store: toasts, isRetrying: session.isLoading, onRetry: { _ in await session.refresh() })
                        .padding(.top, headerHeight)
                }
        }
        .modifier(ChatPageSafeArea(insets: safeAreaInsets))
        .modifier(SessionTakeoverConfirmation(pending: $pendingTakeover) { enabled in
            model.error = nil
            if !(await model.setTakeover(enabled)), let error = model.takeoverError { model.error = error }
        })
        .task(id: sidebarIsTransitioning) {
            guard !hasStartedLoading, !sidebarIsTransitioning else { return }
            // Show feedback immediately, but let the drawer's completed
            // animation and the selection's final layout leave the main thread.
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            guard !Task.isCancelled, !sidebarIsTransitioning else { return }
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { hasStartedLoading = true }
        }
        .task(id: hasStartedLoading) {
            guard hasStartedLoading else { return }
            // Reattaching an already revealed detail only resumes observation;
            // it must not put its presentation clock back behind an opening hold.
            if !isInitialPositioned { await model.prepareOpening() }
            guard !Task.isCancelled else { return }
            await model.timeline.run(sessionID: session.id, repository: model.repository)
        }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .notices: SessionNoticesSheet(model: model, initialNoticeID: expandedNoticeID)
            case .details: SessionDetailsSheet(chat: model, service: detailService)
            case .files:
                if let meta = session.metadata, let cwd = meta.cwd {
                    WorkspaceFilesSheet(connectorId: meta.connectorId,
                        workspace: V2DeviceWorkspace(path: cwd, name: "会话文件", sessionCount: 1, lastActiveAt: nil),
                        service: fileService, session: session)
                }
            case .preview(let path, let root):
                if let meta = session.metadata {
                    WorkspaceFilePreviewSheet(connectorId: meta.connectorId, root: root ?? meta.cwd ?? ".", path: path,
                        service: fileService, session: session)
                }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let path = SessionFileReference.path(from: url) { openFile(path); return .handled }
            return ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
        })
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { _, url in if url == nil { cleanPreview() } }
        .onDisappear { if previewURL == nil { cleanPreview() } }
        .onChange(of: session.failure, initial: true) { _, failure in
            toasts.update(source: "session", failure: failure, canRetry: failure?.kind != .authentication)
        }
        .onChange(of: model.error, initial: true) { _, message in
            toasts.update(source: "operation", failure: message.map { V2ClientFailure(kind: .rejected, message: $0) })
        }
        .onChange(of: model.openingError, initial: true) { _, message in
            toasts.update(source: "opening", failure: message.map { V2ClientFailure(kind: .unavailable, message: $0) })
        }
    }

    private var openingMask: some View {
        ZStack {
            Color(uiColor: .systemBackground)
            VStack(spacing: 12) {
                if let error = model.openingError, !model.timeline.hasPresentedSnapshot {
                    Text(error).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("重试") { Task { await model.prepareOpening() } }
                } else if openingPositionFailed {
                    Text("会话已加载，暂时无法完成底部布局。")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("重新定位") { openingPositionFailed = false; openingAttempt += 1 }
                } else {
                    ProgressView().progressViewStyle(.circular).accessibilityLabel("正在加载会话")
                }
            }
            .padding(24).frame(maxWidth: 320)
        }
        .transition(.identity)
    }

    @ViewBuilder private var connectionBar: some View {
        if session.network.availability == .offline || session.connection == .offline {
            status("网络已断开，草稿和已加载的消息已保留", icon: "wifi.slash")
        } else if session.metadata?.connectorStatus == .offline {
            status("设备离线，等待重新连接", icon: "desktopcomputer")
        } else if session.failure == nil && (session.connection == .reconnecting || !session.runtime.isFresh) {
            status("正在同步会话状态…", icon: "arrow.triangle.2.circlepath")
        } else if let reason = session.runtime.state?.statusReason, !reason.isEmpty {
            status(reason, icon: "info.circle")
        }
    }

    private var takeoverPill: some View {
        Button { pendingTakeover = true } label: {
            Label("接管会话以继续交互", systemImage: "hand.raised")
                .font(.footnote.weight(.medium))
                .foregroundStyle(AppTheme.primaryText(colorScheme))
                .padding(.horizontal, 14).frame(minHeight: takeoverPillHeight)
                .glassEffect(.regular.interactive(), in: .capsule)
                .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.canChangeTakeover)
        .accessibilityIdentifier("chat.session.takeover")
        .padding(.horizontal, 20).padding(.bottom, 4)
    }

    private func status(_ text: String, icon: String, retry: Bool = false) -> some View {
        HStack(spacing: 10) {
            Label(text, systemImage: icon).lineLimit(3)
            if retry { Button("重试") { Task { await session.refresh() } }.disabled(session.isLoading) }
        }
        .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.bottom, 8)
    }

    private func openFile(_ path: String) {
        guard session.isValid, !path.isEmpty else { return }
        sheet = .preview(SessionFileReference.stripLocation(path))
    }

    private func openAttachment(_ file: V2AttachmentContent) {
        if file.readsFromDevice, let path = file.devicePath { sheet = .preview(path, root: file.root); return }
        guard !isDownloading, let fileID = file.fileId else { return }
        isDownloading = true
        model.error = nil
        Task { @MainActor in
            defer { isDownloading = false }
            do {
                let data = try await model.download(fileID)
                guard session.isValid, sheet == nil else { return }
                cleanPreview()
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aa-preview-\(UUID().uuidString)", isDirectory: true)
                let name = (file.name ?? "Attachment") as NSString
                let safeName = name.lastPathComponent.isEmpty ? "Attachment" : name.lastPathComponent
                let url = directory.appendingPathComponent(safeName)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: url, options: [.atomic, .completeFileProtection])
                previewDirectory = directory; previewURL = url
            } catch { model.error = error.localizedDescription }
        }
    }
    private func cleanPreview() {
        if let directory = previewDirectory { try? FileManager.default.removeItem(at: directory) }
        previewDirectory = nil
    }
}
