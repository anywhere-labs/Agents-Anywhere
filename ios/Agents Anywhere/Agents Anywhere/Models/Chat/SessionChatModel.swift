import Foundation
import Observation

@MainActor @Observable
final class SessionChatModel {
    let session: V2SessionModel
    let timeline = SessionTimelinePresentation()
    let settings = ConversationSettings()
    private(set) var isWorking: Bool {
        get { session.isPerformingAction }
        set { session.isPerformingAction = newValue }
    }
    private(set) var isLoadingSettings = false
    var error: String?
    var settingsError: String?
    @ObservationIgnored let repository: V2SessionRepository
    @ObservationIgnored private let attachments: V2AttachmentService

    init(session: V2SessionModel, repository: V2SessionRepository, attachments: V2AttachmentService) {
        self.session = session; self.repository = repository; self.attachments = attachments
    }

    var isRunning: Bool {
        guard let status = session.runtime.state?.status else { return false }
        return [.running, .pending, .waiting, .stopping, .blocked].contains(status)
    }
    var canAttach: Bool { session.runtime.allows("runtime.attachment") }

    func loadSettings() async {
        guard !isLoadingSettings, session.isValid else { return }
        guard session.runtime.isFresh else { settingsError = "连接恢复后可更改对话选项。"; return }
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
                    throw V2ClientFailure(kind: .unavailable, message: "This selection is currently unavailable.")
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
        defer { isWorking = false }
        do {
            // Retain successful uploads on the draft; retrying a definite send
            // rejection need not upload the same selected bytes again.
            for attachment in selected where attachment.uploaded == nil {
                let uploaded = try await attachments.upload(sessionId: session.id, attachments: [attachment.local])
                guard session.isValid, !Task.isCancelled else { return }
                if let index = draft.attachments.firstIndex(where: { $0.id == attachment.id }), let file = uploaded.first {
                    draft.attachments[index].uploaded = file
                }
            }
            guard session.isValid, draft.text == text, draft.attachments.map(\.id) == selected.map(\.id),
                  !draft.isComposing else { return }
            let ids = draft.attachments.compactMap { $0.uploaded?.fileId }
            guard ids.count == selected.count else { return }
            session.draftAttachmentIDs = ids
            _ = await session.sendDraft()
        } catch { if session.isValid { self.error = error.localizedDescription } }
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
        } catch { notice.fail(error) }
    }

    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        defer { isWorking = false }
        do { try await operation(); return session.isValid }
        catch { if session.isValid { self.error = error.localizedDescription }; return false }
    }

    func download(_ fileID: String) async throws -> Data {
        try await attachments.download(sessionId: session.id, fileId: fileID)
    }
}
