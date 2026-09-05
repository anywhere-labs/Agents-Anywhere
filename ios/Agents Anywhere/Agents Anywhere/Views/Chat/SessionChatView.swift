import SwiftUI
import QuickLook

struct SessionChatView: View {
    @State private var model: SessionChatModel
    let safeAreaInsets: EdgeInsets
    let onMenu: () -> Void
    let onNewSession: () -> Void
    @State private var sheet: SessionSheet?
    private let fileService: V2WorkspaceFilesService
    private let detailService: V2SessionDetailService
    private enum SessionSheet: Identifiable {
        case notices, details, files, preview(String)
        var id: String { switch self { case .notices: "notices"; case .details: "details"; case .files: "files"; case .preview(let path): "file:" + path } }
    }
    @State private var previewURL: URL?
    @State private var previewDirectory: URL?
    @State private var isDownloading = false
    @State private var toasts = ChatToastStore()
    @State private var headerHeight: CGFloat = 66
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22

    init(session: V2SessionModel, services: V2ClientServices, safeAreaInsets: EdgeInsets,
         onMenu: @escaping () -> Void, onNewSession: @escaping () -> Void) {
        _model = State(initialValue: SessionChatModel(session: session, repository: services.sessionRepository, attachments: services.attachments))
        fileService = services.workspaceFiles; detailService = services.sessionDetail
        self.safeAreaInsets = safeAreaInsets; self.onMenu = onMenu; self.onNewSession = onNewSession
    }
    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }
    private var session: V2SessionModel { model.session }
    var body: some View {
        GeometryReader { geometry in
            ChatTimelineView(model: model, onAttachment: openAttachment, onFile: openFile)
                .overlay {
                    if model.timeline.rows.isEmpty && model.timeline.pendingMessages.isEmpty {
                        VStack(spacing: 12) {
                            if session.connection == .connecting { ProgressView("加载会话…") }
                            else { Text("在这里继续你的任务").foregroundStyle(.secondary) }
                        }.allowsHitTesting(false)
                    }
                }
                .safeAreaBar(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        ChatPageHeader(title: session.metadata?.title ?? "会话",
                            subtitle: session.metadata?.runtimeName ?? session.metadata?.runtime,
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
                    }
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        SessionInteractionDock(chat: model, maximumHeight: min(360, geometry.size.height * 0.38),
                            onShowAll: { sheet = .notices })
                        ChatComposerDock(draft: session.composer, settings: model.settings,
                            maximumEditorHeight: min(160, max(72, geometry.size.height * 0.30)), controls: controls,
                            canSend: session.canSend, canAttach: model.canAttach,
                            canSelectModel: session.runtime.allows("catalog.model"),
                            canSelectPermission: session.runtime.allows("catalog.permission"),
                            isStreaming: model.isRunning, canStop: session.runtime.allows("session.interrupt"),
                            isBusy: model.isWorking, isLoadingSettings: model.isLoadingSettings,
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
        .task { await model.timeline.run(sessionID: session.id, repository: model.repository) }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .notices: SessionNoticesSheet(model: model)
            case .details: SessionDetailsSheet(chat: model, service: detailService)
            case .files:
                if let meta = session.metadata, let cwd = meta.cwd {
                    WorkspaceFilesSheet(connectorId: meta.connectorId,
                        workspace: V2DeviceWorkspace(path: cwd, name: "会话文件", sessionCount: 1, lastActiveAt: nil),
                        service: fileService, session: session)
                        .presentationDetents([.large])
                }
            case .preview(let path):
                if let meta = session.metadata {
                    WorkspaceFilePreviewSheet(connectorId: meta.connectorId, root: meta.cwd ?? ".", path: path,
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
    }

    @ViewBuilder private var connectionBar: some View {
        if session.network.availability == .offline || session.connection == .offline {
            status("网络已断开，草稿和已加载的消息已保留", icon: "wifi.slash")
        } else if session.metadata?.connectorStatus == .offline {
            status("设备离线，等待重新连接", icon: "desktopcomputer")
        } else if session.failure == nil && (session.connection == .reconnecting || !session.runtime.isFresh) {
            status("正在同步会话状态…", icon: "arrow.triangle.2.circlepath")
        } else if session.metadata?.takeover == false {
            status("只读会话 · 在加号菜单中开启接管", icon: "eye")
        } else if let reason = session.runtime.state?.statusReason, !reason.isEmpty {
            status(reason, icon: "info.circle")
        }
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
