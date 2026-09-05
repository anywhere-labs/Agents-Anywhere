import SwiftUI
import QuickLook

struct SessionChatView: View {
    @State private var model: SessionChatModel
    let safeAreaInsets: EdgeInsets
    let onMenu: () -> Void
    let onNewSession: () -> Void
    @State private var showsNotices = false
    @State private var previewURL: URL?
    @State private var previewDirectory: URL?
    @State private var isDownloading = false
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22

    init(session: V2SessionModel, services: V2ClientServices, safeAreaInsets: EdgeInsets,
         onMenu: @escaping () -> Void, onNewSession: @escaping () -> Void) {
        _model = State(initialValue: SessionChatModel(session: session, repository: services.sessionRepository, attachments: services.attachments))
        self.safeAreaInsets = safeAreaInsets; self.onMenu = onMenu; self.onNewSession = onNewSession
    }
    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }
    private var session: V2SessionModel { model.session }
    var body: some View {
        GeometryReader { geometry in
            ChatTimelineView(model: model, onAttachment: openAttachment)
                .overlay {
                    if model.timeline.rows.isEmpty && model.timeline.pendingMessages.isEmpty {
                        VStack(spacing: 12) {
                            if session.connection == .connecting { ProgressView("加载会话…") }
                            else { Text("在这里继续你的任务").foregroundStyle(.secondary) }
                        }.allowsHitTesting(false)
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        ChatPageHeader(title: session.metadata?.title ?? "会话",
                            subtitle: session.metadata?.runtimeName ?? session.metadata?.runtime,
                            controls: controls, onMenu: onMenu, onNewSession: onNewSession)
                        connectionBar
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        SessionInteractionDock(chat: model, maximumHeight: min(360, geometry.size.height * 0.38),
                            onShowAll: { showsNotices = true })
                        ChatComposerDock(draft: session.composer, settings: model.settings,
                            maximumEditorHeight: min(160, max(72, geometry.size.height * 0.30)), controls: controls,
                            canSend: session.canSend, canAttach: model.canAttach,
                            canSelectModel: session.runtime.allows("catalog.model"),
                            canSelectPermission: session.runtime.allows("catalog.permission"),
                            isStreaming: model.isRunning, canStop: session.runtime.allows("session.interrupt"),
                            isBusy: model.isWorking, isLoadingSettings: model.isLoadingSettings,
                            settingsError: model.settingsError,
                            onSend: model.send, onStop: model.interrupt, onLoadSettings: model.loadSettings,
                            onApplySettings: model.applySettings, applyError: { model.settingsError })
                    }
                    .frame(maxWidth: 780).frame(maxWidth: .infinity)
                }
        }
        .modifier(ChatPageSafeArea(insets: safeAreaInsets))
        .task { await model.timeline.run(sessionID: session.id, repository: model.repository) }
        .sheet(isPresented: $showsNotices) { SessionNoticesSheet(model: model) }
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { _, url in if url == nil { cleanPreview() } }
        .onDisappear { if previewURL == nil { cleanPreview() } }
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil && !showsNotices }, set: { if !$0 { model.error = nil } })) {
            Button("好", role: .cancel) { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    @ViewBuilder private var connectionBar: some View {
        if let failure = session.failure {
            status(failure.message, icon: "exclamationmark.circle", retry: true)
        } else if session.network.availability == .offline || session.connection == .offline {
            status("网络已断开，草稿和已加载的消息已保留", icon: "wifi.slash")
        } else if session.metadata?.connectorStatus == .offline {
            status("设备离线，等待重新连接", icon: "desktopcomputer")
        } else if session.connection == .reconnecting || !session.runtime.isFresh {
            status("正在恢复连接…", icon: "arrow.triangle.2.circlepath")
        } else if session.metadata?.takeover == false {
            Button("接管会话以继续交互") {
                Task { await model.perform { try await model.repository.setTakeover(sessionId: session.id, enabled: true) } }
            }.font(.footnote).padding(.bottom, 8).disabled(model.isWorking)
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

    private func openAttachment(_ file: V2AttachmentContent) {
        guard !isDownloading, let fileID = file.fileId else { return }
        isDownloading = true
        Task { @MainActor in
            defer { isDownloading = false }
            do {
                let data = try await model.download(fileID)
                guard session.isValid, !showsNotices else { return }
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
