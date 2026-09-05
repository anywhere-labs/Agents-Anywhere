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
    let attachmentIDs: [V2AttachmentID]
    private(set) var delivery: Delivery = .sending

    init(id: String, content: String, attachmentIDs: [V2AttachmentID]) {
        self.id = id; self.content = content; self.attachmentIDs = attachmentIDs
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
    private(set) var pendingMessages: [V2PendingMessage] = []
    var draft = ""
    var draftAttachmentIDs: [V2AttachmentID] = []
    @ObservationIgnored private weak var repository: V2SessionRepository?

    init(id: V2SessionID, scope: V2ClientScope, repository: V2SessionRepository) {
        self.id = id; self.scope = scope; self.repository = repository
    }

    var canSend: Bool { isValid && runtime.allows("session.send_message") }
    var hasLocalWork: Bool { !draft.isEmpty || !draftAttachmentIDs.isEmpty || !pendingMessages.isEmpty }

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
    @discardableResult func sendDraft() async -> V2PendingMessage? {
        guard let repository, canSend else {
            failure = V2ClientFailure(kind: .unavailable, message: "Wait for the session to reconnect before sending.")
            return nil
        }
        let content = draft
        let attachments = draftAttachmentIDs
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else {
            failure = V2ClientFailure(V2BusinessError.emptyMessage)
            return nil
        }
        // Avoid a repeated tap while this exact draft's outcome remains unresolved.
        guard !pendingMessages.contains(where: {
            guard $0.content == content && $0.attachmentIDs == attachments else { return false }
            if case .rejected = $0.delivery { return false }
            return true
        }) else { return nil }
        let pending = V2PendingMessage(id: UUID().uuidString, content: content, attachmentIDs: attachments)
        pendingMessages.append(pending)
        do {
            _ = try await repository.send(sessionId: id, content: content, attachmentIDs: attachments, clientMessageID: pending.id)
            guard isValid else { return pending }
            pending.update(.accepted)
            clearDraft(ifMatching: pending)
        } catch {
            guard isValid else { return pending }
            let failure = V2ClientFailure(error)
            pending.update(V2ClientFailure.isDefiniteWriteRejection(error) ? .rejected(failure) : .uncertain(failure))
            if pending.delivery == .confirmed { clearDraft(ifMatching: pending) }
            else { self.failure = failure }
        }
        return pending
    }

    /// An explicit UI action may dismiss a reviewed outcome; it never resends it.
    func dismissPendingMessage(id: String) {
        pendingMessages.removeAll { $0.id == id && $0.delivery != .sending }
    }

    func update(_ observation: V2SessionObservation, network: V2NetworkStatus) {
        guard isValid else { return }
        let data = observation.data
        if metadata != data?.session { metadata = data?.session }
        if connection != observation.connection { connection = observation.connection }
        if self.network != network { self.network = network }
        if failure != observation.error { failure = observation.error }
        runtime.update(data, connected: connection == .connected)
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
    }

    func confirmEcho(_ item: V2TimelineItem) {
        guard item.sessionId == id, item.type == .message, item.role == .user,
              let clientID = item.source["clientMessageId"]?.stringValue,
              let pending = pendingMessages.first(where: { $0.id == clientID }) else { return }
        pending.update(.confirmed)
        clearDraft(ifMatching: pending)
        pendingMessages.removeAll { $0.id == clientID }
    }

    func invalidate() {
        runtime.update(nil, connected: false)
        metadata = nil; timeline = []; pendingMessages = []; draft = ""; draftAttachmentIDs = []
        connection = .inactive; isValid = false; repository = nil
    }

    private func clearDraft(ifMatching pending: V2PendingMessage) {
        if draft == pending.content && draftAttachmentIDs == pending.attachmentIDs {
            draft = ""; draftAttachmentIDs = []
        }
    }
}
