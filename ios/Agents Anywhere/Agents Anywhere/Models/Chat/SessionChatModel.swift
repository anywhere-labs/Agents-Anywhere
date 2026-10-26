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
    private(set) var commands: [V2RuntimeCommand] = []
    private(set) var isLoadingCommands = false
    private(set) var commandsError: String?
    private(set) var isRunningCommand = false
    /// Success is transient; failures stay until the user dismisses them.
    var commandSuccess: CommandFeedback?
    var commandFailure: CommandFeedback?
    /// Selector commands (model, permission, …) open the existing options sheet.
    private(set) var optionsRequest = 0
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
    /// The configured instance name, like Web, then its runtime type. Status
    /// copy names the Agent the user chose instead of a generic "Agent".
    var agentName: String {
        let meta = session.metadata
        for name in [meta?.runtimeName, meta?.runtimeTypeDisplayName] {
            if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        }
        return String(localized: "Agent")
    }
    var isDsh: Bool {
        guard let meta = session.metadata else { return false }
        return (meta.runtimeType ?? meta.runtime) == "dsh"
    }
    var sendingPlaceholder: String? {
        let submitting = session.pendingMessages.contains { $0.delivery == .sending || $0.delivery == .accepted }
        if submitting || session.awaitingReplyID != nil { return session.isLocalCreation ? String(localized: "正在创建会话…") : String(localized: "等待 \(agentName) 回应…") }
        guard session.runtime.isFresh, let status = session.runtime.state?.status else { return nil }
        switch status {
        case .waiting, .pending: return String(localized: "等待 \(agentName) 回应…")
        case .running: return String(localized: "\(agentName) 正在处理任务…")
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

    // MARK: Commands

    private var connectorOnline: Bool {
        session.metadata?.connectorStatus == .online && session.network.availability != .offline
    }
    /// The runtime advertises commands at all, even when they cannot run now.
    var offersCommands: Bool { session.isValid && session.runtime.capabilities?.capability(id: "session.commands") != nil }
    var canUseCommands: Bool { session.runtime.allows("session.commands") && connectorOnline }
    var commandsUnavailableReason: String? {
        guard let capability = session.runtime.capabilities?.capability(id: "session.commands"), !canUseCommands else { return nil }
        if !connectorOnline { return String(localized: "设备离线") }
        if !capability.supported { return String(localized: "当前 Runtime 版本还不支持指令，升级后可用") }
        if let reason = capability.unavailableReason, !reason.isEmpty { return reason }
        return String(localized: "此会话暂时无法使用指令")
    }

    func loadCommands(force: Bool = false) async {
        guard canUseCommands, !isLoadingCommands else { return }
        isLoadingCommands = true
        commandsError = nil
        defer { isLoadingCommands = false }
        do {
            let loaded = try await repository.commands(sessionId: session.id, force: force)
            guard session.isValid else { return }
            commands = loaded
        } catch {
            if session.isValid, !Task.isCancelled { commandsError = error.localizedDescription }
        }
    }

    func commandBlock(_ command: V2RuntimeCommand) -> RuntimeCommandBlock? {
        if isRunningCommand || isWorking { return .busy }
        return command.block(status: session.runtime.state?.status, capability: canUseCommands,
            writable: session.metadata?.takeover == true, online: connectorOnline)
    }

    func commandBlockMessage(_ command: V2RuntimeCommand, _ block: RuntimeCommandBlock) -> String {
        switch block {
        case .busy: return String(localized: "Agent 忙碌中，暂时不能执行")
        case .readOnly: return String(localized: "开启接管后才能执行指令")
        case .offline: return String(localized: "设备离线")
        case .unavailable: return String(localized: "此会话暂时无法使用指令")
        case .disabled:
            switch command.disabledReason {
            case "session_unloaded": return String(localized: "请先打开此会话，再运行指令。")
            case "native_commands_unavailable": return String(localized: "此 Codex 版本尚不支持所需的指令操作。")
            case "codex_unavailable": return String(localized: "Codex 当前不可用。")
            case let reason?: return reason
            case nil: return String(localized: "此会话暂时无法使用指令")
            }
        }
    }

    /// Catalog commands matching the draft's slash token, or nil when the draft
    /// is not a command-like slash (e.g. a path or prose).
    func commandSuggestions(for text: String) -> [V2RuntimeCommand]? {
        guard let intent = SlashIntent(text), intent.isCommandLike, intent.suffix.isEmpty, !intent.multiline else { return nil }
        return commands.filter { $0.matches(intent.command) }
    }

    /// Only drafts naming a catalog command run as commands; the catalog is read
    /// first when needed so an intended command is never sent to the model.
    private func catalogCommand(for text: String) async -> V2RuntimeCommand? {
        guard let intent = SlashIntent(text), !intent.command.isEmpty, intent.isCommandLike, canUseCommands else { return nil }
        if commands.isEmpty { await loadCommands() }
        return commands.exact(intent)
    }

    /// Menu choice: commands with arguments are completed into the draft.
    func choose(_ command: V2RuntimeCommand) async {
        if let block = commandBlock(command) { fail(commandBlockMessage(command, block)); return }
        let draft = session.composer
        let current = SlashIntent(draft.text).flatMap { [command].exact($0) } != nil ? draft.text : "/\(command.id)"
        // Prose typed before opening the ⌘ menu is kept; a partial "/comp" is replaced.
        let prose = SlashIntent(draft.text) == nil ? draft.text : ""
        if command.takesArguments {
            draft.text = current == "/\(command.id)" ? current + " " + prose : current
            draft.isFocused = true
            repository.draftDidChange(sessionID: session.id)
            return
        }
        await runCommand(command, raw: current, clearing: prose.isEmpty ? draft.text : nil)
    }

    /// `source` is the draft to clear on success (defaults to `raw`).
    func runCommand(_ command: V2RuntimeCommand, raw: String, clearing source: String? = nil) async {
        guard !isRunningCommand, session.isValid else { return }
        if let block = commandBlock(command) { fail(commandBlockMessage(command, block)); return }
        guard session.composer.attachments.isEmpty else { fail(String(localized: "运行指令前请移除附件；草稿会保留。")); return }
        guard let intent = SlashIntent(raw), let request = command.request(for: intent) else {
            fail(SlashIntent(raw)?.multiline == true ? String(localized: "此指令不支持多行输入。") : String(localized: "此指令不接受这些参数。"))
            return
        }
        if case .selector? = command.ui { optionsRequest += 1; return }
        isRunningCommand = true
        commandFailure = nil
        defer { isRunningCommand = false }
        let outcome: RuntimeCommandOutcome
        do { outcome = RuntimeCommandOutcome(try await repository.executeCommand(sessionId: session.id, request: request)) }
        catch { outcome = RuntimeCommandOutcome(transportFailure: error) }
        guard session.isValid else { return }
        if outcome.ok {
            let message = outcome.message.map { $0.count > 200 ? String($0.prefix(200)) + "…" : $0 }
            commandSuccess = CommandFeedback(title: outcome.state == .completed ? String(localized: "指令已完成。") : String(localized: "指令已接受，后台任务可能仍在进行。"), message: message)
            if let source = source ?? raw as String?, !source.isEmpty, session.composer.text == source { session.composer.text = ""; repository.draftDidChange(sessionID: session.id) }
        } else if outcome.state == .unknown {
            commandFailure = CommandFeedback(title: String(localized: "指令结果尚不确定"),
                message: [String(localized: "结果尚不确定，请先检查会话状态再决定是否重试。"), outcome.message].compactMap { $0 }.joined(separator: "\n"))
        } else {
            fail(outcome.message ?? String(localized: "无法执行指令。"))
        }
    }

    private func fail(_ message: String) {
        commandFailure = CommandFeedback(title: String(localized: "无法执行指令"), message: message)
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
            settings.replaceRuntime(ChatSettingsCatalog(catalogs), selections: currentSelections)
        } catch { if session.isValid { self.settingsError = error.localizedDescription } }
    }

    private var currentSelections: [V2RuntimeSelectionScope: V2SelectionID?] {
        session.runtime.state?.selections ?? [:]
    }

    var pendingSelectionScopes: Set<V2RuntimeSelectionScope> {
        guard let state = session.runtime.state,
              case let .object(metadata) = state.metadata,
              let pending = metadata["pendingSelectionScopes"],
              case let .array(values) = pending else { return [] }
        return Set(values.compactMap { value in
            value.stringValue.map(V2RuntimeSelectionScope.init(rawValue:))
        })
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
            settings.replaceRuntime(settings.catalog, selections: currentSelections)
            return false
        }
    }

    func send(_ text: String) async {
        if let command = await catalogCommand(for: text) {
            session.composer.text = text
            await runCommand(command, raw: text)
            return
        }
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
                    self.repository.draftDidChange(sessionID: self.session.id)
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

struct CommandFeedback: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String?
}
