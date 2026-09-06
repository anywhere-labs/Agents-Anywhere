import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct NativeChatTests {
    private func item(_ text: String, status: String = "running", id: String = "reply", revision: Int = 1) throws -> V2TimelineItem {
        var object = try itemObject(id: id, revision: revision, text: text)
        object["type"] = "message"; object["role"] = "assistant"; object["status"] = status
        return try decode(object)
    }

    @Test func receptionPublishesOnlyAtFlushAndKeepsRowIdentity() throws {
        let timeline = SessionTimelinePresentation()
        timeline.stage([try item("Hello", status: "done")], animate: false)
        #expect(timeline.rows.isEmpty)
        timeline.flush(now: 0)
        let row = try #require(timeline.rows.first)
        timeline.stage([try item("Hello world", revision: 2)], animate: true)
        timeline.stage([try item("Hello world!", revision: 3)], animate: true)
        #expect(row.text == "Hello")
        timeline.flush(now: 1)
        #expect(timeline.rows.first === row)
        #expect(row.text == "Hello world")
        #expect(row.isRevealing)
        timeline.stage([try item("Hello world!", status: "done", revision: 4)], animate: true)
        timeline.flush(now: 1.1)
        #expect(row.text == "Hello world!")
        #expect(row.isRevealing)
        timeline.flush(now: 2)
        #expect(!row.isRevealing)
    }

    @Test func completedShortReplyStillRevealsAndRecoveryNeverReplaysHistory() throws {
        let timeline = SessionTimelinePresentation()
        timeline.stage([], animate: false); timeline.flush(now: 0)
        timeline.stage([try item("短回复", status: "done")], animate: true)
        timeline.flush(now: 1)
        #expect(timeline.rows.first?.isRevealing == true)
        timeline.stage([try item("恢复后的完整回复", status: "done", revision: 2)], animate: false)
        timeline.stage([try item("恢复后的完整回复。", status: "done", revision: 3)], animate: true)
        timeline.flush(now: 2)
        #expect(timeline.rows.first?.text == "恢复后的完整回复。")
        #expect(timeline.rows.first?.isRevealing == false)
        #expect(timeline.rows.first?.layoutGeneration == 1)
    }

    @Test func streamingSnapshotDoesNotShrinkAndUnicodeTailIsSafe() throws {
        let timeline = SessionTimelinePresentation()
        timeline.stage([try item("已经收到")], animate: false); timeline.flush(now: 0)
        timeline.stage([try item("已经收到")], animate: true); timeline.flush(now: 1)
        #expect(timeline.rows.first?.text == "已经收到")
        timeline.stage([try item("已经收到👩")], animate: true); timeline.flush(now: 2)
        #expect(timeline.rows.first?.text == "已经收到")
        timeline.stage([try item("已经收到👩🏽‍💻好")], animate: true); timeline.flush(now: 3)
        #expect(timeline.rows.first?.text == "已经收到👩🏽‍💻")
        timeline.stage([try item("已经收到👩🏽‍💻好", status: "done")], animate: true); timeline.flush(now: 4)
        #expect(timeline.rows.first?.text == "已经收到👩🏽‍💻好")
    }

    @Test func echoAndOptimisticMembershipChangeInOneTick() throws {
        let timeline = SessionTimelinePresentation()
        let pending = V2PendingMessage(id: "local", content: "Hi", attachmentIDs: [])
        timeline.synchronizePending([pending])
        let echo: V2TimelineItem = try decode(itemObject(text: "Hi", clientID: "local"))
        timeline.stage([echo], animate: true)
        #expect(timeline.pendingMessages.count == 1)
        #expect(timeline.rows.isEmpty)
        timeline.flush(now: 1)
        timeline.synchronizePending([])
        #expect(timeline.pendingMessages.isEmpty)
        #expect(timeline.rows.count == 1)
    }

    @Test func thirtyHzDeadlinesAndGlyphBirthsRemainIndependent() throws {
        let start = ContinuousClock.now
        var schedule = ReplyFlushSchedule(start: start)
        #expect(schedule.interval == .seconds(1.0 / 30))
        let first = schedule.deadline
        schedule.advance(after: first.advanced(by: .milliseconds(4)))
        #expect(schedule.deadline == first.advanced(by: .seconds(1.0 / 30)))
        let late = start.advanced(by: .seconds(2))
        schedule.advance(after: late)
        #expect(schedule.deadline > late)
        let ledger = GlyphRevealLedger()
        _ = ledger.progress(count: 2, now: 0, enabled: true)
        let firstProgress = try #require(ledger.progress(count: 2, now: 0.1, enabled: true))
        _ = ledger.progress(count: 0, now: 0.1, enabled: true)
        let appended = try #require(ledger.progress(count: 4, now: 0.1, enabled: true))
        #expect(Array(appended.prefix(2)) == firstProgress)
        #expect(Array(appended.suffix(2)) == [0, 0])
    }

    @Test func composerWhitespaceExpandsButMarkedTextNeverSends() {
        let draft = ComposerDraft()
        #expect(!draft.isExpanded)
        draft.text = "\n  "
        #expect(draft.isExpanded)
        #expect(!draft.canAttemptSend)
        draft.text = "中文\n下一行"
        draft.isComposing = true
        #expect(!draft.canAttemptSend)
        draft.isComposing = false
        #expect(draft.canAttemptSend)
        draft.invalidate()
        #expect(!draft.isValid && draft.text.isEmpty)
    }

    @Test func catalogRespectsTopLevelAvailabilityAndOpaqueModelReasoningIDs() throws {
        var modelCatalog = try fixtureObject("modelCatalog")
        var catalog = modelCatalog["catalog"] as! [String: Any]
        var models = catalog["models"] as! [[String: Any]]
        models[0]["enabled"] = false
        models[0]["metadata"] = ["enabled": true]
        catalog["models"] = models; modelCatalog["catalog"] = catalog
        let disabled: V2ModelCatalogResponse = try decode(modelCatalog)
        let permission: V2PermissionCatalogResponse = try fixture("permissionCatalog")
        let settings = ConversationSettings()
        settings.replace(ChatSettingsCatalog(V2SessionCatalogs(model: disabled.catalog, permission: permission.catalog)))
        #expect(!settings.selectModel("model", reasoning: "high"))
        #expect(settings.selections[.model] == nil)
        let enabled: V2ModelCatalogResponse = try fixture("modelCatalog")
        settings.replace(ChatSettingsCatalog(V2SessionCatalogs(model: enabled.catalog, permission: permission.catalog)),
                         selections: [.model: "sel_effort"])
        #expect(settings.modelID == "model" && settings.reasoningID == "high")
        #expect(settings.selections[.model] == "sel_effort")
        #expect(!settings.selectModel("model", reasoning: "other-model-reasoning"))
        #expect(settings.selections[.model] == "sel_effort")
    }

    @Test func livePresentationPublishesLocalSendAndStopsWhenRepositoryCloses() async throws {
        let http = TestHTTPTransport(); let repo = repository(transport: http)
        defer { repo.reset() }
        let model = repo.session(id: "session")
        let timeline = SessionTimelinePresentation()
        let running = Task { await timeline.run(sessionID: model.id, repository: repo) }
        defer { running.cancel() }
        try await eventually { model.canSend && !timeline.rows.isEmpty }
        model.draft = "a new message"
        _ = await model.sendDraft()
        try await eventually { timeline.pendingMessages.count == 1 }
        #expect(timeline.pendingMessages[0].content == "a new message")
        repo.reset()
        var stopped = false
        let waiting = Task { await running.value; stopped = true }
        defer { waiting.cancel() }
        try await eventually { stopped }
    }

    @Test func unsupportedCatalogDoesNotHideTheOtherAvailableCatalog() async throws {
        let http = TestHTTPTransport(); let repo = repository(transport: http)
        defer { repo.reset() }
        var object = try fixtureObject("capabilities")
        var set = object["capabilitySet"] as! [String: Any]
        var item = (set["capabilities"] as! [[String: Any]])[0]
        item["capabilityId"] = "catalog.model"
        set["capabilities"] = [item]; object["capabilitySet"] = set
        let capabilities: V2RuntimeCapabilityResponse = try decode(object)
        let result = try await repo.catalogs(sessionId: "session", capabilities: capabilities.capabilitySet)
        #expect(!result.model.models.isEmpty && result.permission.permissions.isEmpty)
        #expect(http.count("catalogs/model") == 1 && http.count("catalogs/permission") == 0)
        _ = try await repo.catalogs(sessionId: "session", capabilities: capabilities.capabilitySet)
        #expect(http.count("catalogs/model") == 1)
    }
}
