import Foundation
import Testing
@testable import ClientCore

@Suite struct TimelineOpeningPositionTests {
    private func viewport(height: CGFloat = 3000, width: CGFloat = 600, offset: CGFloat = 2380) -> TimelineViewport {
        .init(contentHeight: height, containerHeight: 800, containerWidth: width,
            topInset: 80, bottomInset: 100, offsetY: offset)
    }

    @Test func requestsTheBottomAndRetriesWithoutRequiringNewGeometryCallbacks() {
        var opening = TimelineOpeningPosition(now: 0)
        #expect(opening.advance(viewport: .init(), isAtBottom: false, isIdle: true, now: 0) == .wait)
        #expect(opening.advance(viewport: viewport(offset: 0), isAtBottom: false, isIdle: true, now: 0.1) == .scrollToBottom)
        #expect(opening.advance(viewport: viewport(offset: 0), isAtBottom: false, isIdle: true, now: 0.2) == .wait)
        #expect(opening.advance(viewport: viewport(offset: 0), isAtBottom: false, isIdle: true, now: 0.4) == .scrollToBottom)
    }

    @Test func nativeBottomVisibilityHandlesLongAndClampedShortConversations() {
        for view in [viewport(), viewport(height: 200, offset: -80)] {
            var opening = TimelineOpeningPosition(now: 0)
            #expect(opening.advance(viewport: view, isAtBottom: true, isIdle: true, now: 0) == .scrollToBottom)
            #expect(opening.advance(viewport: view, isAtBottom: true, isIdle: true, now: 0.1) == .wait)
            #expect(opening.advance(viewport: view, isAtBottom: true, isIdle: true, now: 0.2) == .wait)
            #expect(opening.advance(viewport: view, isAtBottom: true, isIdle: true, now: 0.3) == .reveal)
        }
    }

    @Test func lateMarkdownLayoutAndSidebarResizingRestartTheQuietPeriod() {
        var opening = TimelineOpeningPosition(now: 0)
        _ = opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0)
        #expect(opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0.1) == .wait)
        let resized = viewport(height: 3800, width: 420, offset: 3180)
        #expect(opening.advance(viewport: resized, isAtBottom: true, isIdle: true, now: 0.2) == .wait)
        #expect(opening.advance(viewport: resized, isAtBottom: true, isIdle: false, now: 0.3) == .wait)
        #expect(opening.advance(viewport: resized, isAtBottom: true, isIdle: true, now: 0.4) == .wait)
        #expect(opening.advance(viewport: resized, isAtBottom: true, isIdle: true, now: 0.6) == .reveal)
    }

    @Test func losingBottomVisibilityNeverRevealsEvenWhenGeometryLooksUnchanged() {
        var opening = TimelineOpeningPosition(now: 0)
        _ = opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0)
        #expect(opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0.1) == .wait)
        #expect(opening.advance(viewport: viewport(), isAtBottom: false, isIdle: true, now: 0.2) == .wait)
        #expect(opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0.3) == .wait)
        #expect(opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0.5) == .reveal)
    }

    @Test func subpixelRoundingDoesNotKeepTheOpeningMaskUp() {
        var opening = TimelineOpeningPosition(now: 0)
        _ = opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0)
        _ = opening.advance(viewport: viewport(), isAtBottom: true, isIdle: true, now: 0.1)
        #expect(opening.advance(viewport: viewport(height: 3000.25, offset: 2380.25),
            isAtBottom: true, isIdle: true, now: 0.3) == .reveal)
    }

    @Test func missingLayoutOrTailOffersRetryInsteadOfAnEndlessSpinner() {
        for view in [TimelineViewport(), viewport(offset: 0)] {
            var opening = TimelineOpeningPosition(now: 0)
            _ = opening.advance(viewport: view, isAtBottom: false, isIdle: true, now: 0)
            #expect(opening.advance(viewport: view, isAtBottom: false, isIdle: true, now: 6) == .retry)
        }
    }

    @Test @MainActor func openingHoldsStreamingAndOptimisticHandoffUntilTheLayoutIsRevealed() throws {
        let first: V2TimelineItem = try decode(itemObject(id: "reply", text: "Initial reply"))
        let updated: V2TimelineItem = try decode(itemObject(id: "reply", revision: 2, text: "Initial reply with more content"))
        let echo: V2TimelineItem = try decode(itemObject(id: "echo", order: 2, text: "Question", clientID: "local"))
        let pending = V2PendingMessage(id: "local", content: "Question", attachmentIDs: [])
        let timeline = SessionTimelinePresentation()
        timeline.presentOpening([first], pendingMessages: [pending])
        let row = try #require(timeline.rows.first)
        timeline.stage([updated, echo], animate: false)
        timeline.flush(now: 1)
        timeline.synchronizePending([])
        #expect(row.text == "Initial reply" && timeline.rows.count == 1 && timeline.pendingMessages.count == 1)
        timeline.finishOpening()
        timeline.flush(now: 2)
        timeline.synchronizePending([])
        #expect(timeline.rows.first === row && row.text == "Initial reply with more content")
        #expect(timeline.rows.last?.id == "echo" && timeline.pendingMessages.isEmpty)
    }

    @Test @MainActor func finishingOpeningWakesAlreadyBufferedRealtimeWithoutAnotherNetworkEvent() async throws {
        let http = TestHTTPTransport(), realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let session = repo.session(id: "session")
        let model = SessionChatModel(session: session, repository: repo, attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)))
        await model.prepareOpening()
        #expect(model.isOpeningReady)
        let updates = Task { await model.timeline.run(sessionID: session.id, repository: repo) }
        defer { updates.cancel() }
        try await eventually { session.runtime.isFresh }
        realtime.yield(try event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "next", order: 2, seq: 11)]))
        try await eventually { session.timeline.contains { $0.id == "next" } }
        try await Task.sleep(for: .milliseconds(50))
        #expect(!model.timeline.rows.contains { $0.id == "next" })
        model.timeline.finishOpening()
        try await eventually { model.timeline.rows.contains { $0.id == "next" } }
    }
}
