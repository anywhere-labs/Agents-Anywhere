import Foundation
import Observation

@MainActor @Observable
final class SessionChatModel {
    let session: V2SessionModel
    let timeline = SessionTimelinePresentation()
    let settings = ConversationSettings()
    let disclosures = TimelineDisclosureState()
    var takeoverError: String?
    private(set) var takeoverUncertain = false
    private(set) var isWorking: Bool {
        get { session.isPerformingAction }
        set { session.isPerformingAction = newValue }
    }
    private(set) var isLoadingSettings = false
    var error: String?
    var settingsError: String?
    private(set) var isOpeningPrepared = false
    var isOpeningReady: Bool { isOpeningPrepared && timeline.hasPresentedSnapshot }
    private(set) var openingError: String?
    private(set) var responseRevision = 0
    @ObservationIgnored var onEditCreation: ((V2PendingMessage) -> Void)?
    @ObservationIgnored var onDiscardCreation: (() -> Void)?
    @ObservationIgnored let repository: V2SessionRepository
    @ObservationIgnored private let attachments: V2AttachmentService
    @ObservationIgnored private let files: V2WorkspaceFilesService?

    init(session: V2SessionModel, repository: V2SessionRepository, attachments: V2AttachmentService, files: V2WorkspaceFilesService? = nil) {
        self.session = session; self.repository = repository; self.attachments = attachments
        self.files = files
        // Cached history can still be expensive to project. prepareOpening()
        // performs that work after the page's navigation transition settles.
    }

    var isRunning: Bool {
        guard let status = session.runtime.state?.status else { return false }
        return [.running, .pending, .waiting, .waitingApproval, .stopping, .blocked].contains(status)
    }
    var sendingPlaceholder: String? {
        let submitting = session.pendingMessages.contains { $0.delivery == .sending || $0.delivery == .accepted }
        if submitting || session.awaitingReplyID != nil { return session.isLocalCreation ? String(localized: "正在创建会话…") : String(localized: "等待 Agent 回应…") }
        guard session.runtime.isFresh, let status = session.runtime.state?.status else { return nil }
        switch status {
        case .waiting, .pending: return String(localized: "等待 Agent 回应…")
        case .running: return String(localized: "Agent 正在处理任务…")
        default: return nil
        }
    }
    var responseUnavailableReason: String? {
        if !session.isValid { return String(localized: "会话已关闭。") }
        if session.network.availability == .offline || session.connection == .offline { return String(localized: "网络已断开，已填写的内容会保留。") }
        if session.metadata?.connectorStatus == .offline { return String(localized: "设备已离线，已填写的内容会保留。") }
        if session.runtime.isFresh { return nil }
        if session.failure?.kind == .invalidResponse { return String(localized: "会话数据暂时无法解析，请刷新状态后回应。已填写的内容会保留。") }
        if session.failure?.kind == .authentication { return String(localized: "登录状态需要重新验证，已填写的内容会保留。") }
        return String(localized: "正在确认 Agent 的最新状态，已填写的内容会保留。")
    }
    var canAttach: Bool { session.runtime.allows("runtime.attachment") }
    var canChangeTakeover: Bool {
        session.isValid && session.connection == .connected && session.metadata?.connectorStatus == .online
            && session.network.availability != .offline && !isWorking && !takeoverUncertain
    }
    var canBrowseFiles: Bool {
        session.isValid && session.metadata?.connectorStatus == .online && session.network.availability != .offline
            && session.metadata?.cwd?.isEmpty == false
    }

    func prepareOpening() async {
        if !timeline.hasPresentedSnapshot { isOpeningPrepared = false }
        openingError = nil
        do {
            // Both cold and cached visits begin with one latest page. Older
            // records are added only by the user's explicit history requests.
            _ = try await repository.open(sessionId: session.id)
        } catch {
            guard !Task.isCancelled else { return }
            openingError = error.localizedDescription
        }
        guard session.isValid, !Task.isCancelled else { return }
        if let data = repository.cached(sessionId: session.id) {
            timeline.presentOpening(data.items, pendingMessages: session.pendingMessages)
        }
        isOpeningPrepared = true
    }

    func setTakeover(_ enabled: Bool) async -> Bool {
        guard canChangeTakeover, session.metadata?.takeover != enabled else { return false }
        isWorking = true; takeoverError = nil
        defer { isWorking = false }
        do { try await repository.setTakeover(sessionId: session.id, enabled: enabled); return session.isValid }
        catch {
            guard session.isValid else { return false }
            takeoverUncertain = !V2ClientFailure.isDefiniteWriteRejection(error)
            takeoverError = takeoverUncertain ? String(localized: "接管状态尚未确认，请先刷新状态，避免重复操作。") : error.localizedDescription
            return false
        }
    }

    func refreshTakeover() async {
        await session.refresh()
        if session.runtime.isFresh { takeoverUncertain = false; takeoverError = nil }
    }

    func loadSettings() async {
        guard !isLoadingSettings, session.isValid else { return }
        guard session.runtime.isFresh else { settingsError = String(localized: "连接恢复后可更改对话选项。"); return }
        isLoadingSettings = true
        settingsError = nil
        defer { isLoadingSettings = false }
        do {
            let catalogs = try await repository.catalogs(sessionId: session.id, capabilities: session.runtime.capabilities)
            guard session.isValid, !Task.isCancelled else { return }
            settings.replace(ChatSettingsCatalog(catalogs), selections: currentSelections, defaults: false)
        } catch { if session.isValid { self.settingsError = error.localizedDescription } }
    }

    private var currentSelections: [V2RuntimeSelectionScope: V2SelectionID] {
        (session.runtime.state?.selections ?? [:]).compactMapValues { $0 }
    }

    func applySettings() async -> Bool {
        guard !isWorking, session.runtime.isFresh else { return false }
        isWorking = true
        defer { isWorking = false }
        do {
            for (scope, value) in settings.selections where currentSelections[scope] != value {
                guard session.runtime.allows(scope == .model ? "catalog.model" : "catalog.permission") else {
                    throw V2ClientFailure(kind: .unavailable, message: String(localized: "This selection is currently unavailable."))
                }
                try await repository.setSelection(sessionId: session.id, scope: scope, selectionId: value)
            }
            return session.isValid
        } catch {
            self.settingsError = error.localizedDescription
            settings.replace(settings.catalog, selections: currentSelections, defaults: false)
            return false
        }
    }

    func send(_ text: String) async {
        guard !isWorking, session.canSend, !session.composer.isComposing else { return }
        let draft = session.composer
        draft.text = text
        let selected = draft.attachments
        guard selected.isEmpty || canAttach else { return }
        isWorking = true
        error = nil
        defer { isWorking = false }
        _ = await session.sendDraft { pending in
                for attachment in pending.attachments where attachment.uploaded == nil {
                    let uploaded = try await self.attachments.upload(sessionId: self.session.id, attachments: [attachment.local])
                    guard self.session.isValid, !Task.isCancelled else { throw CancellationError() }
                    guard let file = uploaded.first else { throw HTTPError.invalidResponse }
                    pending.bindUpload(file, localID: attachment.id)
                    self.session.attachmentPreviews.remember(pending.attachments, clientID: pending.id)
                    self.repository.draftDidChange()
                }
        }
    }

    func interrupt() async {
        guard !isWorking, session.runtime.allows("session.interrupt") else { return }
        await perform { try await self.repository.interrupt(sessionId: self.session.id) }
    }

    func respond(notice: SessionNoticeModel, action: V2RuntimeNoticeAction) async {
        guard !isWorking, notice.canRespond(fresh: session.runtime.isFresh),
              notice.notice.actions.contains(action), notice.hasValidInput(for: action) else { return }
        let input = notice.payload(for: action)
        notice.begin(actionID: action.id)
        isWorking = true
        defer { isWorking = false }
        do {
            try await repository.respond(sessionId: session.id, noticeId: notice.id, actionId: action.id, input: input)
            notice.accepted()
            if notice.submission == .accepted { responseRevision += 1 }
        } catch { notice.fail(error) }
    }

    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        error = nil
        defer { isWorking = false }
        do { try await operation(); return session.isValid }
        catch { if session.isValid { self.error = error.localizedDescription }; return false }
    }

    func download(_ fileID: String) async throws -> Data {
        try await attachments.download(sessionId: session.id, fileId: fileID)
    }

    func thumbnail(for file: V2AttachmentContent) async throws -> Data? {
        if let cached = session.attachmentPreviews.preview(for: file) { return cached }
        guard session.isValid, file.isImage, (file.size ?? 0) <= 25 * 1024 * 1024 else { return nil }
        let preview: Data?
        if file.readsFromDevice, let path = file.devicePath, let files, let meta = session.metadata {
            guard meta.connectorStatus == .online, session.network.availability != .offline else {
                throw V2ClientFailure(kind: .offline, message: String(localized: "设备或网络已离线"))
            }
            let downloaded = try await files.download(connectorId: meta.connectorId, root: file.root ?? meta.cwd ?? ".",
                entry: V2WorkspaceEntry(name: file.name ?? (path as NSString).lastPathComponent, path: path, type: "file", size: file.size, modifiedAt: nil))
            preview = await Task.detached(priority: .utility) { ChatImageThumbnail.make(url: downloaded.url) }.value
        } else if let id = file.fileId, !id.hasPrefix("local:") {
            let data = try await download(id)
            preview = await Task.detached(priority: .utility) { ChatImageThumbnail.make(data: data) }.value
        } else { return nil }
        try Task.checkCancellation()
        guard session.isValid else { return nil }
        if let preview { session.attachmentPreviews.cache(preview, for: file) }
        return preview
    }
}
