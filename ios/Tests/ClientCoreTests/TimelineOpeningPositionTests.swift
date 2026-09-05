import Foundation
import Testing
@testable import ClientCore

@Suite struct TimelineOpeningPositionTests {
    private func layout(id: String = "user", scrollID: String = "user", y: CGFloat = 80, width: CGFloat = 600) -> TimelineOpeningLayout {
        .init(id: id, scrollID: scrollID, frame: CGRect(x: 24, y: y, width: width, height: 2))
    }

    @Test func completedHTTPAndLaidOutHistoryDoNotByThemselvesRevealTheTimeline() {
        var opening = TimelineOpeningPosition(targetID: "user", now: 0)
        #expect(opening.advance(presented: false, layout: nil, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0) == .wait)
        #expect(opening.advance(presented: true, layout: nil, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0.1) == .wait)
        #expect(opening.advance(presented: true, layout: layout(y: 9000), visibleID: nil, viewportHeight: 700, isIdle: true, now: 0.2) == .scrollTo("user"))
        #expect(opening.advance(presented: true, layout: layout(y: 9000), visibleID: nil, viewportHeight: 700, isIdle: true, now: 0.3) == .wait)
    }

    @Test func nativeVisibilityAndQuietLayoutAcknowledgeAnInsetOrClampedPosition() {
        // Top-inset alignment and native end-clamping can leave the user at
        // different screen coordinates. Neither requires a made-up exact offset.
        for y: CGFloat in [80, 480] {
            var opening = TimelineOpeningPosition(targetID: "user", now: 0)
            #expect(opening.advance(presented: true, layout: layout(y: y), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0) == .scrollTo("user"))
            #expect(opening.advance(presented: true, layout: layout(y: y), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.1) == .wait)
            #expect(opening.advance(presented: true, layout: layout(y: y), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.2) == .reveal)
        }
    }

    @Test func retriesWhenANativeRequestProducesNoGeometryCallback() {
        var opening = TimelineOpeningPosition(targetID: "user", now: 0)
        let offscreen = layout(y: 9000)
        #expect(opening.advance(presented: true, layout: offscreen, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0) == .scrollTo("user"))
        #expect(opening.advance(presented: true, layout: offscreen, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0.3) == .scrollTo("user"))
        #expect(opening.advance(presented: true, layout: layout(), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.4) == .wait)
        #expect(opening.advance(presented: true, layout: layout(), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.5) == .reveal)
    }

    @Test func resizingOrScrollingKeepsTheMaskUntilTheNewLayoutSettles() {
        var opening = TimelineOpeningPosition(targetID: "user", now: 0)
        #expect(opening.advance(presented: true, layout: layout(), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0) == .scrollTo("user"))
        #expect(opening.advance(presented: true, layout: layout(), visibleID: "user", viewportHeight: 700, isIdle: false, now: 0.1) == .wait)
        #expect(opening.advance(presented: true, layout: layout(), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.2) == .wait)
        #expect(opening.advance(presented: true, layout: layout(y: 100, width: 400), visibleID: "user", viewportHeight: 600, isIdle: true, now: 0.3) == .wait)
        #expect(opening.advance(presented: true, layout: layout(y: 100, width: 400), visibleID: "user", viewportHeight: 600, isIdle: true, now: 0.4) == .reveal)
    }

    @Test func foldedFallbackScrollsToTheContainingGroupAndIgnoresAnOldMarker() {
        var opening = TimelineOpeningPosition(targetID: "last-tool", now: 0)
        #expect(opening.advance(presented: true, layout: layout(), visibleID: "user", viewportHeight: 700, isIdle: true, now: 0) == .wait)
        let group = layout(id: "last-tool", scrollID: "first-tool")
        #expect(opening.advance(presented: true, layout: group, visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.1) == .scrollTo("first-tool"))
        #expect(opening.advance(presented: true, layout: group, visibleID: "user", viewportHeight: 700, isIdle: true, now: 0.2) == .wait)
        #expect(opening.advance(presented: true, layout: group, visibleID: "last-tool", viewportHeight: 700, isIdle: true, now: 0.3) == .wait)
        #expect(opening.advance(presented: true, layout: group, visibleID: "last-tool", viewportHeight: 700, isIdle: true, now: 0.4) == .reveal)
    }

    @Test func aMissingOrUnreachableTargetOffersRetryInsteadOfAnEndlessSpinner() {
        for target in [nil, layout(y: 9000)] {
            var opening = TimelineOpeningPosition(targetID: "user", now: 0)
            _ = opening.advance(presented: true, layout: target, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0)
            #expect(opening.advance(presented: true, layout: target, visibleID: nil, viewportHeight: 700, isIdle: true, now: 6) == .retry)
        }
        var empty = TimelineOpeningPosition(targetID: nil, now: 0)
        #expect(empty.advance(presented: false, layout: nil, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0) == .wait)
        #expect(empty.advance(presented: true, layout: nil, visibleID: nil, viewportHeight: 700, isIdle: true, now: 0.1) == .reveal)
    }

    @Test @MainActor func openingFollowsAnOptimisticEchoThatArrivesBeforeLayout() async throws {
        let http = TestHTTPTransport(), realtime = TestRealtimeAPI(), gate = TestGate()
        let repo = repository(transport: http, realtime: realtime)
        defer { repo.reset() }
        let session = repo.session(id: "session"), connection = Task { await repo.session(id: "session").connect() }
        defer { connection.cancel() }
        try await eventually { session.canSend }
        http.respond = { call in if call.path.hasSuffix("messages") { await gate.wait() }; return try http.defaultResponse(call) }
        session.draft = "Pending while opening"
        let send = Task { await session.sendDraft() }
        defer { gate.release(); send.cancel() }
        try await eventually { http.count("messages") == 1 }
        let pending = try #require(session.pendingMessages.first)
        let model = SessionChatModel(session: session, repository: repo, attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)))
        await model.prepareOpening()
        #expect(model.openingTargetID == pending.id)
        realtime.yield(try event("timeline.item_created", seq: 11, payload: ["item": itemObject(id: "echo", order: 2, seq: 11, clientID: pending.id)]))
        try await eventually { pending.delivery == .confirmed }
        #expect(session.pendingMessages.isEmpty && model.openingTargetID == "echo")
    }
}
