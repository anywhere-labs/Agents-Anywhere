import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct SessionInteractionTests {
    private func notice(type: String = "interaction", interaction: String = "approval", status: String = "open",
                        revision: Int = 1, blocking: String? = "session", input: Bool = false) throws -> V2RuntimeNotice {
        var value = (try fixtureObject("notices")["notices"] as! [[String: Any]])[0]
        value["type"] = type; value["interactionType"] = interaction; value["status"] = status; value["revision"] = revision
        if let blocking { value["blocking"] = ["scope": "session", "targetId": blocking] }
        else { value["blocking"] = NSNull() }
        if input {
            value["actions"] = [["actionId": "submit", "label": "Submit", "style": "primary", "input": [
                "required": true,
                "uiSchema": ["component": "inputRequest", "version": 1, "questions": [
                    ["id": "one", "prompt": "Single", "multiple": false, "options": [["id": "a", "label": "A"]]],
                    ["id": "many", "prompt": "Multiple", "multiple": true, "options": [["id": "a", "label": "A"], ["id": "b", "label": "B"]]],
                ]],
            ]]]
        }
        return try decode(value)
    }

    @Test func allInteractionTypesUseBlockingScopeAndNotificationNeverBlocks() throws {
        for type in ["approval", "confirmation", "execution_error", "input_request", "unknown", "future_extension"] {
            let item = SessionNoticeModel(try notice(interaction: type))
            #expect(item.blocks("session"))
            #expect(!item.blocks("another-session"))
            #expect(item.canRespond(fresh: true))
            #expect(!item.canRespond(fresh: false))
        }
        let notification = SessionNoticeModel(try notice(type: "notification"))
        #expect(notification.isVisible)
        #expect(!notification.blocks("session"))
        #expect(!notification.canRespond(fresh: true))
    }

    @Test func protocolLifecycleAndExpiryControlActions() throws {
        for status in ["open", "failed"] {
            #expect(SessionNoticeModel(try notice(status: status)).canRespond(fresh: true))
        }
        for status in ["responding", "response_accepted", "resolving"] {
            let item = SessionNoticeModel(try notice(status: status))
            #expect(item.isVisible && !item.canRespond(fresh: true))
        }
        for status in ["resolved", "closed", "expired", "cancelled", "future_status"] {
            let item = SessionNoticeModel(try notice(status: status))
            #expect(!item.isVisible && !item.canRespond(fresh: true))
        }
        var value = (try fixtureObject("notices")["notices"] as! [[String: Any]])[0]
        value["expiresAt"] = "2026-09-05T00:00:00.000Z"
        let item = SessionNoticeModel(try decode(value))
        #expect(item.isExpired(at: Date(timeIntervalSince1970: 2_000_000_000)))
    }

    @Test func inputRequestEnforcesExclusiveSingleChoiceAndAllowsMultipleWithCustomText() throws {
        let item = SessionNoticeModel(try notice(interaction: "input_request", input: true))
        let form = try #require(item.form)
        let action = item.notice.actions[0]
        #expect(!item.hasValidInput(for: action))
        item.select("a", question: form.questions[0])
        item.setCustom("custom", question: form.questions[0])
        #expect(item.choices["one"] == [])
        item.select("a", question: form.questions[1]); item.select("b", question: form.questions[1])
        item.setCustom(" extra ", question: form.questions[1])
        let input = try #require(item.payload(for: action))
        #expect(input["answers"]?["one"]?["optionIds"] == .array([]))
        #expect(input["answers"]?["one"]?["customText"] == .string("custom"))
        #expect(input["answers"]?["many"]?["optionIds"] == .array([.string("a"), .string("b")]))
        #expect(input["answers"]?["many"]?["customText"] == .string("extra"))
        #expect(item.hasValidInput(for: action))
        item.composingFields.insert("one")
        #expect(!item.canRespond(fresh: true))
        item.select("a", question: form.questions[0])
        #expect(item.custom["one"] == nil)
    }

    @Test func draftsSurviveStatusRevisionsButNotChangedDefinitions() throws {
        let store = SessionNoticeStore()
        store.update([try notice(interaction: "input_request", input: true)], sessionID: "session")
        let item = try #require(store.notices.first)
        item.custom["one"] = "unfinished"
        store.update([try notice(interaction: "input_request", status: "responding", revision: 2, input: true)], sessionID: "session")
        #expect(store.notices.first === item)
        #expect(item.custom["one"] == "unfinished")
        store.update([try notice(interaction: "confirmation", revision: 3)], sessionID: "session")
        #expect(item.custom.isEmpty)
        store.update([], sessionID: "session")
        #expect(store.notices.isEmpty)
    }

    @Test func acceptedAndUncertainResponsesCannotBeRepeatedAutomatically() throws {
        let item = SessionNoticeModel(try notice())
        item.begin(actionID: "approve"); item.accepted()
        #expect(!item.canRespond(fresh: true))
        item.update(try notice(revision: 2))
        #expect(!item.canRespond(fresh: true))
        item.update(try notice(status: "failed", revision: 3))
        #expect(item.canRespond(fresh: true))
        item.begin(actionID: "approve"); item.fail(URLError(.timedOut))
        #expect(item.submission == .uncertain)
        #expect(!item.canRespond(fresh: true))
        item.acknowledgeUncertain()
        #expect(item.canRespond(fresh: true))
        item.begin(actionID: "approve")
        item.update(try notice(status: "response_accepted", revision: 4))
        item.fail(URLError(.timedOut))
        #expect(item.submission == .accepted)
    }

    @Test func missingNoticeIsRemovedUntilNewAuthoritativeRevision() throws {
        let item = SessionNoticeModel(try notice())
        item.begin(actionID: "approve")
        item.fail(V2RuntimeError(code: "notice_not_found", message: "Gone"))
        #expect(!item.isVisible)
        item.update(try notice())
        #expect(!item.isVisible)
        item.update(try notice(revision: 2))
        #expect(item.isVisible)
    }

    @Test func successfulResponseRemainsAcceptedWhenSubsequentLiveReadFails() async throws {
        let http = TestHTTPTransport(); let repo = repository(transport: http)
        defer { repo.reset() }
        let session = repo.session(id: "session")
        let observation = Task { await session.connect() }; defer { observation.cancel() }
        try await eventually { session.runtime.isFresh }
        let item = try #require(session.notices.notices.first)
        let chat = SessionChatModel(session: session, repository: repo, attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)))
        var accepted = false
        http.respond = { call in
            if call.path.hasSuffix("/respond") { accepted = true; return try fixtureData("rpc") }
            if accepted && call.path.hasSuffix("/state") { throw URLError(.timedOut) }
            return try http.defaultResponse(call)
        }
        await chat.respond(notice: item, action: item.notice.actions[0])
        #expect(item.submission == .accepted)
        #expect(!session.runtime.isFresh)
        await chat.respond(notice: item, action: item.notice.actions[0])
        #expect(http.count("respond") == 1)
    }

    @Test func genericActionSchemaBuildsTypedNestedInputsAndRejectsUnknownConstraints() throws {
        let schema: JSONValue = .object([
            "type": .string("object"), "required": .array([.string("reason"), .string("options")]),
            "properties": .object([
                "reason": .object(["type": .string("string"), "minLength": .number(2)]),
                "options": .object(["type": .string("object"), "required": .array([.string("limit")]), "properties": .object([
                    "limit": .object(["type": .string("integer"), "minimum": .number(1), "maximum": .number(3)])
                ])])
            ]), "additionalProperties": .bool(false)
        ])
        let form = try #require(NoticeActionForm(schema: schema, uiSchema: nil))
        #expect(form.payload([:]) == nil)
        var values: [String: JSONValue] = [:]
        for field in form.fields { values[field.id] = field.path.last == "limit" ? .string("2") : .string("ok") }
        let payload = try #require(form.payload(values))
        #expect(payload["options"]?["limit"] == .number(2))
        for field in form.fields where field.path.last == "limit" { values[field.id] = .string("4") }
        #expect(form.payload(values) == nil)
        #expect(NoticeActionForm(schema: .object(["type": .string("object"), "properties": .object([:]), "oneOf": .array([])]), uiSchema: nil) == nil)
    }
}
