import Foundation
import Observation

@MainActor @Observable
final class SessionNoticeModel: Identifiable {
    enum Submission: Equatable { case idle, sending(String), accepted, uncertain, unavailable }
    let id: String
    private(set) var notice: V2RuntimeNotice
    private(set) var form: NoticeInputForm?
    private(set) var submission = Submission.idle
    private(set) var error: String?
    var choices: [String: Set<String>] = [:]
    var custom: [String: String] = [:]
    private(set) var customQuestions: Set<String> = []
    var fields: [String: [String: JSONValue]] = [:]
    var composingFields: Set<String> = []
    @ObservationIgnored private var submittedRevision = 0

    init(_ notice: V2RuntimeNotice) {
        id = notice.id; self.notice = notice; form = NoticeInputForm(notice)
    }
    var hasDraft: Bool { !choices.isEmpty || !custom.isEmpty || !fields.isEmpty }
    var isVisible: Bool {
        guard submission != .unavailable else { return false }
        if notice.type == "notification" { return notice.status == .open }
        return notice.type == "interaction" && [.open, .failed, .responding, .responseAccepted, .resolving].contains(notice.status)
    }
    var timelineTargetID: String? {
        notice.source["timelineItemId"]?.stringValue ?? notice.context["timelineItemId"]?.stringValue
    }
    func blocks(_ sessionID: String) -> Bool {
        isVisible && notice.type == "interaction"
            && notice.blocking?.scope == "session" && notice.blocking?.targetId == sessionID
    }
    func isExpired(at now: Date) -> Bool {
        guard let raw = notice.expiresAt else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        return date.map { $0 <= now } ?? false
    }
    func canRespond(fresh: Bool, at now: Date = Date()) -> Bool {
        fresh && notice.type == "interaction" && [.open, .failed].contains(notice.status)
            && submission == .idle && composingFields.isEmpty && !isExpired(at: now)
    }

    func update(_ next: V2RuntimeNotice) {
        guard next.revision >= notice.revision else { return }
        let nextForm = NoticeInputForm(next)
        // Status revisions keep draft answers; changing the action/schema cannot
        // accidentally submit values collected for an obsolete question set.
        if form != nextForm || notice.actions != next.actions {
            choices = [:]; custom = [:]; customQuestions = []; fields = [:]; composingFields = []; submission = .idle; error = nil
        }
        if next.revision > submittedRevision && next.status == .failed {
            submission = .idle
            error = next.context["error"]?["message"]?.stringValue ?? next.context["error"]?.stringValue
        }
        if submission == .unavailable && next.revision > submittedRevision { submission = .idle }
        notice = next; form = nextForm
    }

    func select(_ optionID: String, question: NoticeInputQuestion) {
        var selected = choices[question.id] ?? []
        if question.multiple {
            if !selected.insert(optionID).inserted { selected.remove(optionID) }
        } else { selected = [optionID] }
        choices[question.id] = selected
        if !question.multiple { custom[question.id] = nil; customQuestions.remove(question.id) }
    }
    func setCustom(_ text: String, question: NoticeInputQuestion) {
        guard question.allowCustom else { return }
        setCustomSelected(true, question: question)
        custom[question.id] = text
    }
    func setCustomSelected(_ selected: Bool, question: NoticeInputQuestion) {
        guard question.allowCustom else { return }
        if selected {
            customQuestions.insert(question.id)
            if !question.multiple { choices[question.id] = [] }
        } else {
            customQuestions.remove(question.id); custom[question.id] = nil
        }
    }
    func isSending(_ action: V2RuntimeNoticeAction) -> Bool { submission == .sending(action.id) }
    var responseError: String? {
        error ?? (notice.status == .failed
            ? notice.context["error"]?["message"]?.stringValue ?? notice.context["error"]?.stringValue : nil)
    }
    func payload(for action: V2RuntimeNoticeAction) -> JSONValue? {
        if form?.actionID == action.id {
            return form?.payload(choices: choices, custom: custom.filter { customQuestions.contains($0.key) })
        }
        if let schema = action.input.schema {
            return NoticeActionForm(schema: schema, uiSchema: action.input.uiSchema)?.payload(fields[action.id] ?? [:])
        }
        return nil
    }
    func hasValidInput(for action: V2RuntimeNoticeAction) -> Bool {
        if form?.actionID == action.id { return payload(for: action) != nil }
        if action.input.schema != nil { return payload(for: action) != nil || (!action.input.required && fields[action.id, default: [:]].isEmpty) }
        return !action.input.required
    }
    func begin(actionID: String) {
        submittedRevision = notice.revision
        submission = .sending(actionID); error = nil
    }
    func accepted() {
        // A terminal/failed authoritative push can win the race with HTTP.
        if notice.revision > submittedRevision && notice.status == .failed { submission = .idle }
        else { submission = .accepted }
    }
    func fail(_ failure: Error) {
        if [.resolved, .closed, .expired, .cancelled].contains(notice.status) { return }
        if [.responding, .responseAccepted, .resolving].contains(notice.status) { submission = .accepted; return }
        let value = V2ClientFailure(failure)
        error = value.message
        let missing = ["not_found", "notice_not_found", "interaction_not_found", "request_not_found", "approval_not_found"]
        if let code = value.code, missing.contains(code) { submission = .unavailable }
        else if V2ClientFailure.isDefiniteWriteRejection(failure) || (notice.revision > submittedRevision && notice.status == .failed) {
            submission = .idle
        } else { submission = .uncertain }
    }
    func acknowledgeUncertain() { if submission == .uncertain { submission = .idle; error = nil } }
}

@MainActor @Observable
final class SessionNoticeStore {
    private(set) var notices: [SessionNoticeModel] = []
    var hasDraft: Bool { notices.contains { $0.hasDraft } }
    func update(_ values: [V2RuntimeNotice], sessionID: String) {
        let existing = Dictionary(uniqueKeysWithValues: notices.map { ($0.id, $0) })
        let updated = values.filter { $0.sessionId == sessionID }.map { value in
            let model = existing[value.id] ?? SessionNoticeModel(value)
            model.update(value)
            return model
        }
        if notices.map(\.id) != updated.map(\.id) { notices = updated }
    }
    func clear() { notices = [] }
}
