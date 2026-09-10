import Foundation
import Observation

/// Stable row identity: streamed changes only invalidate the affected row's observable value.
@MainActor @Observable
final class V2TimelineItemModel: Identifiable {
    let id: V2TimelineItemID
    private(set) var value: V2TimelineItem

    init(_ value: V2TimelineItem) { id = value.id; self.value = value }
    func update(_ value: V2TimelineItem) { if self.value != value { self.value = value } }
}

@MainActor @Observable
final class V2SessionRuntimeModel {
    private(set) var state: V2RuntimeState?
    private(set) var capabilities: V2RuntimeCapabilitySnapshot?
    private(set) var notices: [V2RuntimeNotice] = []
    private(set) var isFresh = false

    func allows(_ id: V2CapabilityID) -> Bool {
        guard isFresh, let capability = capabilities?.capability(id: id) else { return false }
        return capability.supported && capability.available && capability.allowed
    }

    func update(_ data: V2SessionData?, connected: Bool) {
        if state != data?.state { state = data?.state }
        if capabilities != data?.capabilities { capabilities = data?.capabilities }
        let notices = data?.notices ?? []
        if self.notices != notices { self.notices = notices }
        let fresh = connected && data?.liveStateIsFresh == true
        if isFresh != fresh { isFresh = fresh }
    }
}

@MainActor @Observable
final class V2PendingMessage: Identifiable {
    enum Delivery: Hashable {
        case sending, accepted, confirmed
        case uncertain(V2ClientFailure)
        case rejected(V2ClientFailure)
    }
    let id: String
    let content: String
    private(set) var attachmentIDs: [V2AttachmentID]
    let localAttachmentIDs: [String]
    private(set) var attachments: [ChatAttachment]
    private(set) var delivery: Delivery = .sending
    var didRestoreDraft = false

    init(id: String, content: String, attachmentIDs: [V2AttachmentID], localAttachmentIDs: [String] = [], attachments: [ChatAttachment] = []) {
        self.id = id; self.content = content; self.attachmentIDs = attachmentIDs
        self.localAttachmentIDs = localAttachmentIDs
        self.attachments = attachments
    }

    func bindUpload(_ file: V2AttachmentReference, localID: String) {
        guard let index = attachments.firstIndex(where: { $0.id == localID }) else { return }
        attachments[index].uploaded = file
        attachmentIDs = attachments.compactMap { $0.uploaded?.fileId }
    }

    func update(_ delivery: Delivery) {
        // An authoritative echo can arrive before the HTTP request completes or fails.
        guard self.delivery != .confirmed else { return }
        self.delivery = delivery
    }
}

/// SwiftUI owns a reference obtained from repository.session(id:). Use connect() in
/// a view .task; cancellation releases that view's subscription. DTOs never own I/O.
@MainActor @Observable
final class V2SessionModel: Identifiable {
    let id: V2SessionID
    let scope: V2ClientScope
    let runtime = V2SessionRuntimeModel()
    let notices = SessionNoticeStore()
    private(set) var metadata: V2SessionMeta?
    private(set) var timeline: [V2TimelineItemModel] = []
    private(set) var connection = V2SessionConnectionState.inactive
    private(set) var network = V2NetworkStatus()
    private(set) var failure: V2ClientFailure?
    private(set) var hasOlderItems = false
    private(set) var hasNewerItems = false
    private(set) var isLoading = false
    private(set) var isLoadingHistory = false
    private(set) var isValid = true
    var isPerformingAction = false
    private(set) var pendingMessages: [V2PendingMessage] = []
    private(set) var awaitingReplyID: String?
    let composer = ComposerDraft()
    let attachmentPreviews = ChatAttachmentStore()
    var draft: String {
        get { composer.text }
        set { composer.text = newValue }
    }
    var draftAttachmentIDs: [V2AttachmentID] = []
    @ObservationIgnored private weak var repository: V2SessionRepository?

    init(id: V2SessionID, scope: V2ClientScope, repository: V2SessionRepository) {
        self.id = id; self.scope = scope; self.repository = repository
    }

    var canSend: Bool { isValid && runtime.allows("session.send_message") && !notices.notices.contains { $0.blocks(id) } }
    var hasLocalWork: Bool { !draft.isEmpty || !composer.attachments.isEmpty || !draftAttachmentIDs.isEmpty || !pendingMessages.isEmpty || notices.hasDraft }

    func connect() async {
        guard let repository, isValid else { return }
        for await _ in repository.observe(sessionId: id) {
            if Task.isCancelled { break }
        }
    }

    func load() async {
        guard let repository, isValid, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do { _ = try await repository.load(sessionId: id); if isValid { failure = nil } }
        catch { if isValid { failure = V2ClientFailure(error) } }
    }

    func refresh() async {
        guard let repository, isValid, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do { _ = try await repository.refresh(sessionId: id); if isValid { failure = nil } }
        catch { if isValid { failure = V2ClientFailure(error) } }
    }

    func loadOlder() async {
        guard let repository, isValid, !isLoadingHistory else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do { _ = try await repository.loadOlder(sessionId: id) }
        catch { if isValid { failure = V2ClientFailure(error) } }
    }

    func loadLatest() async {
        guard let repository, isValid, !isLoadingHistory else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do { _ = try await repository.loadLatest(sessionId: id) }
        catch { if isValid { failure = V2ClientFailure(error) } }
    }

    /// Explicit user action only. No outbox replay: clientMessageId correlates an echo
    /// but is not a promise of backend idempotency.
    @discardableResult func sendDraft(upload: ((V2PendingMessage) async throws -> Void)? = nil) async -> V2PendingMessage? {
        guard let repository, canSend else {
            failure = V2ClientFailure(kind: .unavailable, message: String(localized: "Wait for the session to reconnect before sending."))
            return nil
        }
        let content = draft
        let attachments = draftAttachmentIDs
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty || !composer.attachments.isEmpty else {
            failure = V2ClientFailure(V2BusinessError.emptyMessage)
            return nil
        }
        // Avoid a repeated tap while this exact draft's outcome remains unresolved.
        guard !pendingMessages.contains(where: {
            guard $0.content == content && $0.attachmentIDs == attachments else { return false }
            if case .rejected = $0.delivery { return false }
            return true
        }) else { return nil }
        let pending = V2PendingMessage(id: UUID().uuidString, content: content, attachmentIDs: attachments,
                                      localAttachmentIDs: composer.attachments.map(\.id), attachments: composer.attachments)
        attachmentPreviews.remember(pending.attachments, clientID: pending.id)
        pendingMessages.append(pending); awaitingReplyID = pending.id
        // Commit the local bubble and release the editor immediately. A failed
        // write restores this snapshot only if the user has not started a new draft.
        composer.clear(); draftAttachmentIDs = []
        repository.localWorkDidChange(sessionID: id)
        var didSubmit = false
        do {
            try await upload?(pending)
            guard isValid, !Task.isCancelled else { throw CancellationError() }
            attachmentPreviews.remember(pending.attachments, clientID: pending.id)
            await repository.flushCache()
            guard isValid, !Task.isCancelled else { throw CancellationError() }
            didSubmit = true
            _ = try await repository.send(sessionId: id, content: content, attachmentIDs: pending.attachmentIDs, clientMessageID: pending.id)
            guard isValid else { return pending }
            pending.update(.accepted)
            clearDraft(ifMatching: pending)
        } catch {
            guard isValid else { return pending }
            if awaitingReplyID == pending.id { awaitingReplyID = nil }
            let failure = V2ClientFailure(error)
            pending.update(!didSubmit || V2ClientFailure.isDefiniteWriteRejection(error) ? .rejected(failure) : .uncertain(failure))
            if pending.delivery == .confirmed { clearDraft(ifMatching: pending) }
            else {
                self.failure = failure
                if draft.isEmpty && composer.attachments.isEmpty && !composer.isComposing {
                    draft = pending.content; composer.attachments = pending.attachments; draftAttachmentIDs = pending.attachmentIDs
                    pending.didRestoreDraft = true
                }
            }
        }
        repository.localWorkDidChange(sessionID: id)
        return pending
    }

    /// An explicit UI action may dismiss a reviewed outcome; it never resends it.
    func dismissPendingMessage(id: String) {
        pendingMessages.removeAll { $0.id == id && $0.delivery != .sending }
        repository?.localWorkDidChange(sessionID: self.id)
    }

    func update(_ observation: V2SessionObservation, network: V2NetworkStatus) {
        guard isValid else { return }
        let data = observation.data
        if metadata != data?.session { metadata = data?.session }
        if connection != observation.connection { connection = observation.connection }
        if self.network != network { self.network = network }
        if failure != observation.error { failure = observation.error }
        runtime.update(data, connected: connection == .connected)
        notices.update(runtime.notices, sessionID: id)
        if hasOlderItems != (data?.hasOlderItems ?? false) { hasOlderItems = data?.hasOlderItems ?? false }
        if hasNewerItems != (data?.hasNewerItems ?? false) { hasNewerItems = data?.hasNewerItems ?? false }
        let existing = Dictionary(uniqueKeysWithValues: timeline.map { ($0.id, $0) })
        let rows = (data?.items ?? []).map { item in
            let row = existing[item.id] ?? V2TimelineItemModel(item)
            row.update(item)
            return row
        }
        if timeline.map(\.id) != rows.map(\.id) { timeline = rows }
        for item in data?.items ?? [] { confirmEcho(item) }
        if let id = awaitingReplyID, let data {
            let agentStarted = data.liveStateIsFresh && [.running, .waiting, .pending, .error].contains(data.state?.status ?? .unknown)
            let user = data.items.first { $0.role == .user && $0.source["clientMessageId"]?.stringValue == id }
            let hasReply = user.map { user in data.items.contains { $0.orderSeq > user.orderSeq && $0.role != .user && $0.type != .turnStart } } ?? false
            if agentStarted || hasReply { awaitingReplyID = nil }
        }
    }

    func confirmEcho(_ item: V2TimelineItem) {
        guard item.sessionId == id, item.type == .message, item.role == .user,
              let clientID = item.source["clientMessageId"]?.stringValue,
              let pending = pendingMessages.first(where: { $0.id == clientID }) else { return }
        pending.update(.confirmed)
        clearDraft(ifMatching: pending)
        pendingMessages.removeAll { $0.id == clientID }
    }

    var isLocalCreation: Bool { id.hasPrefix("local:") }
    func stage(_ pending: V2PendingMessage) {
        guard isValid, !pendingMessages.contains(where: { $0.id == pending.id }) else { return }
        pendingMessages.append(pending)
        attachmentPreviews.remember(pending.attachments, clientID: pending.id)
        repository?.localWorkDidChange(sessionID: id)
    }
    func restoreDraft(from pending: V2PendingMessage) -> Bool {
        guard isValid, composer.text.isEmpty, composer.attachments.isEmpty else { return false }
        draft = pending.content; composer.attachments = pending.attachments; draftAttachmentIDs = pending.attachmentIDs
        pending.didRestoreDraft = true
        composer.isFocused = true
        repository?.draftDidChange()
        return true
    }

    func restoreLocal(_ archive: V2SessionArchive) {
        guard isValid, !hasLocalWork else { return }
        if let previews = archive.previews { attachmentPreviews.restore(previews) }
        draft = archive.draft; composer.attachments = archive.draftAttachments
        draftAttachmentIDs = archive.draftAttachments.compactMap { $0.uploaded?.fileId }
        pendingMessages = archive.pending.map { value in
            let pending = V2PendingMessage(id: value.id, content: value.content, attachmentIDs: value.attachmentIDs,
                localAttachmentIDs: value.attachments.map(\.id), attachments: value.attachments)
            let failure = V2ClientFailure(kind: .unavailable, message: value.error ?? String(localized: "上次发送的结果尚未确认，正在同步记录。请确认后再重试。"))
            pending.update(value.rejected ? .rejected(failure) : .uncertain(failure))
            attachmentPreviews.remember(value.attachments, clientID: value.id)
            return pending
        }
    }

    func invalidate() {
        runtime.update(nil, connected: false)
        metadata = nil; timeline = []; pendingMessages = []; awaitingReplyID = nil; draft = ""; draftAttachmentIDs = []
        composer.invalidate()
        attachmentPreviews.clear()
        notices.clear()
        connection = .inactive; isValid = false; repository = nil
    }

    private func clearDraft(ifMatching pending: V2PendingMessage) {
        if pending.didRestoreDraft, draft == pending.content && draftAttachmentIDs == pending.attachmentIDs,
           composer.attachments.map(\.id) == pending.localAttachmentIDs {
            composer.clear(); draftAttachmentIDs = []
        }
    }
}
