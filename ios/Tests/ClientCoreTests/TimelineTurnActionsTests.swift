import Testing
@testable import ClientCore

@Suite @MainActor struct TimelineTurnActionsTests {
    private func row(_ id: String, type: String = "message", role: String = "assistant", text: String = "", status: String = "done") throws -> ChatTimelineRowModel {
        var value = try itemObject(id: id, text: text)
        value["type"] = type; value["role"] = role; value["status"] = status
        return ChatTimelineRowModel(try decode(value))
    }

    @Test func oneFooterCopiesAllReplyFragmentsAndExcludesToolsAndReasoning() throws {
        let rows = try [row("user", role: "user", text: "Question"), row("first", text: "First"),
            row("tool", type: "tool", text: "secret output"), row("reasoning", type: "reasoning", text: "Thought"),
            row("second", text: "Second"), row("last-tool", type: "tool")]
        let groups = TimelineGrouping.groups(rows, interactionTargets: [])
        let actions = TimelineTurnActions.build(groups: groups, suppressLatest: false)
        #expect(actions.count == 1)
        #expect(actions["last-tool"]?.copyText == "First\n\nSecond")
        #expect(actions["first"] == nil && actions["second"] == nil)
    }

    @Test func activeLatestTurnHasNoFooterButPreviousCompletedTurnRetainsOne() throws {
        let rows = try [row("user-1", role: "user"), row("reply-1", text: "Done"),
            row("user-2", role: "user"), row("reply-2", text: "Working")]
        let groups = TimelineGrouping.groups(rows, interactionTargets: [])
        let active = TimelineTurnActions.build(groups: groups, suppressLatest: true)
        #expect(active.count == 1 && active["reply-1"]?.copyText == "Done")
        #expect(TimelineTurnActions.build(groups: groups, suppressLatest: false).count == 2)
    }

    @Test func visibleActiveItemsAndNonAssistantTextDoNotGainActions() throws {
        let running = TimelineGrouping.groups(try [row("reply", text: "Still streaming", status: "running")], interactionTargets: [])
        #expect(TimelineTurnActions.build(groups: running, suppressLatest: false).isEmpty)
        let other = TimelineGrouping.groups(try [row("system", role: "system", text: "Notice"), row("user", role: "user", text: "Question")], interactionTargets: [])
        #expect(TimelineTurnActions.build(groups: other, suppressLatest: false).isEmpty)
    }
}
