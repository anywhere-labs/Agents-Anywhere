import Foundation
import Testing
@testable import ClientCore

@Suite struct TimelineHistoryPositionTests {
    private func layout(first: String = "old", anchor: String = "old", y: CGFloat = 80,
                        edge: TimelineHistoryLayout.Edge = .top) -> TimelineHistoryLayout {
        TimelineHistoryLayout(firstRowID: first, anchorRowID: anchor, edge: edge, y: y)
    }

    @Test @MainActor func loadingWaitsForPresentationAndLayoutAfterTheHTTPResponse() throws {
        let old: V2TimelineItem = try decode(itemObject(id: "old", text: "Already visible"))
        let earlier: V2TimelineItem = try decode(itemObject(id: "earlier", text: "Earlier page"))
        let timeline = SessionTimelinePresentation()
        timeline.stage([old], animate: false); timeline.flush(now: 0)
        var history = TimelineHistoryPosition(id: 1, layout: layout(), offsetY: 32, topInset: 80)
        // Repository completion and the fixed presentation deadline are separate.
        timeline.stage([earlier, old], animate: false)
        history.receivedPage(firstRowID: earlier.id)
        #expect(timeline.rows.first?.id == "old" && !history.isReadyToFinish)
        timeline.flush(now: 1)
        #expect(!history.isReadyToFinish)
        let correction = history.laidOut(layout(first: try #require(timeline.rows.first?.id), y: 780), generation: 1)
        #expect(correction == 732 && history.isReadyToFinish)
    }

    @Test func prependingPreservesTheOffsetInsideALongMessage() {
        var history = TimelineHistoryPosition(id: 2, layout: layout(y: 80), offsetY: 420, topInset: 80)
        let correction = history.laidOut(layout(first: "earlier", y: 1080), generation: 2)
        #expect(correction == 1420)
        // The old message begins 340 points above the reader before and after.
        let oldScreenY: CGFloat = 80 - 420
        #expect(oldScreenY == 1080 - correction!)
        #expect(!history.isReadyToFinish)
        history.receivedPage(firstRowID: "earlier")
        #expect(history.isReadyToFinish)
    }

    @Test func tailGrowthAndRepeatedLayoutDoNotAddToThePrependCorrection() {
        var history = TimelineHistoryPosition(id: 3, layout: layout(), offsetY: 20, topInset: 80)
        // Appending streamed text below the anchor never moves the anchor itself.
        let append = history.laidOut(layout(), generation: 3)
        #expect(append == nil)
        let prepend = history.laidOut(layout(first: "earlier", y: 580), generation: 3)
        #expect(prepend == 520)
        let repeated = history.laidOut(layout(first: "earlier", y: 580), generation: 3)
        #expect(repeated == nil)
        // A final Markdown measurement corrects against the original point,
        // not by accumulating every observed content-size change.
        let settled = history.laidOut(layout(first: "earlier", y: 612), generation: 3)
        #expect(settled == 552)
    }

    @Test func newDragOrNavigationCancelsRestorationWithoutLosingLoadingCompletion() {
        for explicitlyCancelled in [false, true] {
            var history = TimelineHistoryPosition(id: 4, layout: layout(), offsetY: 0, topInset: 80)
            if explicitlyCancelled { history.cancelRestoration() }
            history.receivedPage(firstRowID: "earlier")
            #expect(!history.isReadyToFinish)
            let correction = history.laidOut(layout(first: "earlier", y: 780), generation: explicitlyCancelled ? 4 : 5)
            #expect(correction == nil && history.isReadyToFinish)
        }
    }

    @Test func unchangedEmptyOrFailedPagesFinishWithoutMovingTheReader() {
        var history = TimelineHistoryPosition(id: 5, layout: layout(), offsetY: 20, topInset: 80)
        history.receivedPage(firstRowID: "old")
        let correction = history.laidOut(layout(), generation: 5)
        #expect(history.isReadyToFinish && correction == nil)
        var empty = TimelineHistoryPosition(id: 6, layout: nil, offsetY: 0, topInset: 80)
        empty.receivedPage(firstRowID: nil)
        #expect(empty.isReadyToFinish)
    }

    @Test func outwardPullRestoresTheRestingInsetInsteadOfKeepingOverscroll() {
        var history = TimelineHistoryPosition(id: 7, layout: layout(), offsetY: -135, topInset: 80)
        let correction = history.laidOut(layout(first: "earlier", y: 1080), generation: 7)
        #expect(correction == 920)
    }

    @Test func prefixedToolGroupsRetainTheirExistingTrailingBoundary() {
        var history = TimelineHistoryPosition(id: 8, layout: layout(first: "old-tool", anchor: "last-tool", y: 500, edge: .bottom),
            offsetY: 100, topInset: 80)
        let correction = history.laidOut(layout(first: "earlier-tool", anchor: "last-tool", y: 800, edge: .bottom), generation: 8)
        #expect(correction == 400)
        let unrelated = history.laidOut(layout(first: "earlier-tool", anchor: "other-tool", y: 900, edge: .bottom), generation: 8)
        #expect(unrelated == nil)
    }
}
