import Foundation
import Testing
@testable import ClientCore

@Suite struct TimelineNavigationTests {
    private func viewport(offset: CGFloat = 0, height: CGFloat = 2000, container: CGFloat = 800) -> TimelineViewport {
        TimelineViewport(contentHeight: height, containerHeight: container, topInset: 80, bottomInset: 120, offsetY: offset)
    }
    private func tail(_ state: inout TimelineScrollState, near: Bool, end: Bool) {
        state.tailVisibilityChanged(.near, visible: near)
        state.tailVisibilityChanged(.end, visible: end)
    }

    @Test func realTailVisibilityWinsOverMisleadingContentSizeAndInsets() {
        var state = TimelineScrollState()
        state.browseHistory()
        // This geometry used to suggest a gap even when the rendered tail was visible.
        let misleading = viewport(offset: 1300)
        #expect(misleading.contentHeight - misleading.visibleBottom > 0)
        tail(&state, near: true, end: true)
        #expect(!state.showsBottomButton() && !state.shouldFollow())
        // Independently delivered near/end callbacks must not flash the pill.
        state.tailVisibilityChanged(.near, visible: false)
        #expect(!state.showsBottomButton())
        state.tailVisibilityChanged(.end, visible: false)
        #expect(state.showsBottomButton())
    }

    @Test func unknownAndNearTailHideThePillWithoutGrantingAutoFollow() {
        var state = TimelineScrollState()
        state.browseHistory()
        #expect(!state.showsBottomButton() && !state.shouldFollow())
        tail(&state, near: true, end: false)
        #expect(!state.showsBottomButton() && !state.shouldFollow())
        tail(&state, near: false, end: false)
        #expect(state.showsBottomButton())
        for phase in [TimelineScrollState.Phase.tracking, .interacting, .decelerating, .animating] {
            state.phaseChanged(phase)
            #expect(!state.showsBottomButton())
        }
        state.phaseChanged(.idle)
        state.settleUserScroll()
        #expect(state.showsBottomButton() && !state.shouldFollow())
    }

    @Test func lateVisibilityAfterIdleCannotPullTheReaderBackToTheTail() {
        var state = TimelineScrollState()
        tail(&state, near: true, end: true)
        state.phaseChanged(.interacting)
        state.phaseChanged(.idle)
        // Visibility delivery can trail the native phase callback.
        #expect(!state.followsTail && state.needsScrollSettlement)
        tail(&state, near: false, end: false)
        state.settleUserScroll()
        #expect(!state.followsTail && !state.shouldFollow() && state.showsBottomButton())
    }

    @Test func manualArrivalResumesFollowingOnlyAfterVisibilitySettles() {
        var state = TimelineScrollState()
        tail(&state, near: false, end: false)
        state.phaseChanged(.interacting)
        tail(&state, near: true, end: true)
        state.phaseChanged(.idle)
        #expect(!state.followsTail)
        state.settleUserScroll()
        #expect(state.followsTail && !state.shouldFollow())
        state.tailVisibilityChanged(.end, visible: false)
        #expect(state.shouldFollow())
    }

    @Test func returnSurvivesOldDecelerationButANewDragCancelsIt() {
        var state = TimelineScrollState()
        tail(&state, near: false, end: false)
        state.phaseChanged(.tracking); state.phaseChanged(.decelerating)
        state.requestBottom()
        let request = state.navigationGeneration
        #expect(state.shouldFollow() && !state.showsBottomButton())
        tail(&state, near: true, end: true)
        #expect(state.returningToBottom)
        state.phaseChanged(.animating)
        #expect(!state.returningToBottom)
        tail(&state, near: false, end: false)
        let began = state.phaseChanged(.interacting)
        #expect(began && state.navigationGeneration != request)
        state.phaseChanged(.idle); state.settleUserScroll()
        #expect(!state.shouldFollow() && state.showsBottomButton())
    }

    @Test func interactionInvalidatesQueuedNavigationAndKeepsTheReadingPosition() {
        var state = TimelineScrollState()
        tail(&state, near: false, end: false)
        state.requestBottom()
        let request = state.navigationGeneration
        state.setInteractionPresented(true)
        #expect(state.navigationGeneration != request && !state.returningToBottom && !state.shouldFollow())
        tail(&state, near: true, end: true)
        tail(&state, near: false, end: false)
        #expect(!state.shouldFollow())
        state.requestBottom()
        #expect(state.shouldFollow())
        tail(&state, near: true, end: true)
        #expect(!state.returningToBottom)
        tail(&state, near: false, end: false)
        #expect(!state.shouldFollow())
        state.setInteractionPresented(false)
        #expect(state.shouldFollow() && state.returningToBottom)
    }

    @Test func newGestureInvalidatesHistoryRestorationAndPendingSettlements() {
        var state = TimelineScrollState()
        tail(&state, near: false, end: false)
        state.browseHistory()
        let request = state.navigationGeneration
        state.phaseChanged(.interacting)
        #expect(state.navigationGeneration != request)
        let gesture = state.navigationGeneration
        state.phaseChanged(.interacting)
        #expect(state.navigationGeneration == gesture)
        state.settleUserScroll()
        #expect(!state.followsTail)
        state.requestBottom()
        state.phaseChanged(.idle); state.settleUserScroll()
        #expect(state.followsTail)
    }

    @Test func eachHistoryEdgeNeedsOneFreshPullOnAnAlreadyVisiblePrompt() {
        for edge in [TimelineHistoryPull.Edge.older, .latest] {
            var pull = TimelineHistoryPull(edge: edge)
            let direction: CGFloat = edge == .older ? -1 : 1
            pull.begin(at: viewport(), promptVisible: true, canLoad: true)
            pull.update(viewport(offset: direction * 30))
            #expect(pull.isReady)
            let first = pull.end(), second = pull.end()
            #expect(first && !second)
            pull.update(viewport(offset: direction * 60))
            let inertia = pull.end()
            #expect(!inertia)
            pull.begin(at: viewport(), promptVisible: false, canLoad: true)
            pull.update(viewport(offset: direction * 30))
            let firstArrival = pull.end()
            #expect(!firstArrival)
            // A failed page read can be retried by a new deliberate pull.
            pull.begin(at: viewport(), promptVisible: true, canLoad: true)
            pull.update(viewport(offset: direction * 30))
            let retry = pull.end()
            #expect(retry)
        }
    }

    @Test func historyPullCancelsOnResizingReversalOrExistingRequests() {
        for edge in [TimelineHistoryPull.Edge.older, .latest] {
            var pull = TimelineHistoryPull(edge: edge)
            let direction: CGFloat = edge == .older ? -1 : 1
            pull.begin(at: viewport(), promptVisible: true, canLoad: false)
            pull.update(viewport(offset: direction * 50))
            #expect(!pull.isReady)
            pull.begin(at: viewport(), promptVisible: true, canLoad: true)
            pull.update(viewport(offset: direction * 50, height: 2020))
            #expect(!pull.isReady)
            pull.begin(at: viewport(), promptVisible: true, canLoad: true)
            pull.update(viewport(offset: direction * 50, container: 500))
            #expect(!pull.isReady)
            pull.begin(at: viewport(), promptVisible: true, canLoad: true)
            pull.update(viewport(offset: direction * 40))
            pull.update(viewport(offset: direction * 5))
            let reversed = pull.end()
            #expect(!reversed)
        }
    }
}
