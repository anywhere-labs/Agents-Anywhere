import Foundation
import Testing
@testable import ClientCore

@Suite struct TimelineNavigationTests {
    private func viewport(offset: CGFloat = 0, height: CGFloat = 2000, container: CGFloat = 800) -> TimelineViewport {
        TimelineViewport(contentHeight: height, containerHeight: container, topInset: 80, bottomInset: 120, offsetY: offset)
    }
    private func nextCommand(_ state: inout TimelineScrollState) throws -> TimelineScrollState.BottomCommand {
        let request = try #require(state.pendingBottomRequest)
        let command = state.begin(request)
        return try #require(command)
    }

    private func openedAtBottom() throws -> TimelineScrollState {
        var state = TimelineScrollState()
        state.geometryChanged(viewport(offset: 1320))
        state.open()
        let command = try nextCommand(&state)
        let completed = state.complete(command)
        #expect(completed)
        return state
    }

    @Test func nativeInsetsAreCountedOnceForLongShortAndKeyboardLayouts() {
        #expect(!TimelineViewport().isMeasured)
        for (content, container, top, bottom, target) in [
            (2000.0, 800.0, 80.0, 120.0, 1320.0),
            (2000.0, 500.0, 80.0, 120.0, 1620.0),
            (2000.0, 800.0, 80.0, 360.0, 1560.0),
            (200.0, 800.0, 80.0, 120.0, -80.0),
            (0.0, 800.0, 80.0, 120.0, -80.0)
        ] {
            let arrived = TimelineViewport(contentHeight: content, containerHeight: container,
                topInset: top, bottomInset: bottom, offsetY: target)
            #expect(arrived.bottomOffset == target && arrived.isAtBottom && arrived.isNearBottom)
            let rounded = TimelineViewport(contentHeight: content, containerHeight: container,
                topInset: top, bottomInset: bottom, offsetY: target - 0.5)
            #expect(rounded.isAtBottom)
        }
        #expect(viewport(offset: 1313).isAtBottom)
        #expect(!viewport(offset: 1280).isAtBottom && viewport(offset: 1280).isNearBottom)
        #expect(!viewport(offset: 1200).isNearBottom)
    }

    @Test func openingWaitsForDataAndGeometryThenRequestsOneAnimation() throws {
        var state = TimelineScrollState()
        state.geometryChanged(viewport())
        #expect(state.pendingBottomRequest == nil && !state.showsBottomButton())
        state.open()
        let command = try nextCommand(&state)
        let generation = state.navigationGeneration
        state.geometryChanged(viewport(offset: 1320))
        let completed = state.complete(command)
        #expect(completed)
        #expect(state.mode == .following && state.pendingBottomRequest == nil && !state.showsBottomButton())
        state.open()
        #expect(state.navigationGeneration == generation && state.pendingBottomRequest == nil)
        var unmeasured = TimelineScrollState()
        unmeasured.open()
        #expect(unmeasured.pendingBottomRequest == nil)
    }

    @Test func offsetCallbacksCannotRestartAnAnimationForUnchangedLayout() throws {
        var state = try openedAtBottom()
        state.geometryChanged(viewport(offset: 1320, height: 2200))
        let command = try nextCommand(&state)
        state.phaseChanged(.animating, viewport: viewport(offset: 1320, height: 2200))
        for offset in stride(from: 1325.0, through: 1515.0, by: 5) {
            state.geometryChanged(viewport(offset: offset, height: 2200))
            #expect(state.pendingBottomRequest == nil && !state.showsBottomButton())
        }
        state.phaseChanged(.idle, viewport: viewport(offset: 1520, height: 2200))
        let completed = state.complete(command)
        #expect(completed)
        #expect(state.pendingBottomRequest == nil && !state.showsBottomButton())
    }

    @Test func newerStreamingLayoutSupersedesOnlyTheOldAnimation() throws {
        var state = try openedAtBottom()
        state.geometryChanged(viewport(offset: 1320, height: 2200))
        let first = try nextCommand(&state)
        state.geometryChanged(viewport(offset: 1400, height: 2400))
        let second = try nextCommand(&state)
        let completedFirst = state.complete(first)
        #expect(!completedFirst && state.activeCommand == second)
        state.geometryChanged(viewport(offset: 1720, height: 2400))
        let completedSecond = state.complete(second)
        #expect(completedSecond && state.pendingBottomRequest == nil)
    }

    @Test func manualReadingSurvivesLateLayoutAndCannotSnapBackOnIdle() throws {
        var state = try openedAtBottom()
        state.phaseChanged(.tracking, viewport: viewport(offset: 1320))
        state.phaseChanged(.interacting, viewport: viewport(offset: 900))
        state.geometryChanged(viewport(offset: 1320)) // Older cached measurement.
        state.phaseChanged(.idle, viewport: viewport(offset: 900))
        #expect(state.mode == .reading && state.showsBottomButton())
        state.geometryChanged(viewport(offset: 900, height: 2300))
        #expect(state.pendingBottomRequest == nil && state.showsBottomButton())
        for phase in [TimelineScrollState.Phase.tracking, .interacting, .decelerating, .animating] {
            state.phaseChanged(phase, viewport: viewport(offset: 900))
            #expect(!state.showsBottomButton())
        }
    }

    @Test func aManualArrivalResumesFollowingButTheWiderPillMarginDoesNot() throws {
        for (offset, expected) in [(1320.0, TimelineScrollState.Mode.following), (1280.0, .reading)] {
            var state = try openedAtBottom()
            state.phaseChanged(.interacting, viewport: viewport(offset: offset))
            state.phaseChanged(.idle, viewport: viewport(offset: offset))
            #expect(state.mode == expected && !state.showsBottomButton())
            state.geometryChanged(viewport(offset: offset, height: 2200))
            #expect((state.pendingBottomRequest != nil) == (expected == .following))
        }
    }

    @Test func explicitReturnSurvivesOldDecelerationButANewDragCancelsIt() throws {
        var state = try openedAtBottom()
        state.phaseChanged(.tracking, viewport: viewport(offset: 1000))
        state.phaseChanged(.decelerating, viewport: viewport(offset: 900))
        state.requestBottom()
        let command = try nextCommand(&state)
        state.phaseChanged(.idle, viewport: viewport(offset: 850))
        #expect(state.returningToBottom && state.activeCommand == command)
        state.phaseChanged(.animating, viewport: viewport(offset: 1000))
        let began = state.phaseChanged(.interacting, viewport: viewport(offset: 1000))
        let completed = state.complete(command)
        #expect(began && !completed && state.pendingBottomRequest == nil)
        state.phaseChanged(.idle, viewport: viewport(offset: 800))
        #expect(state.mode == .reading && state.showsBottomButton())
    }

    @Test func approvalsCancelQueuedFollowingAndReturnAfterTheFooterShrinks() throws {
        var state = try openedAtBottom()
        state.geometryChanged(viewport(offset: 1320, height: 2200))
        let queued = try #require(state.pendingBottomRequest)
        state.setInteractionPresented(true)
        let obsolete = state.begin(queued)
        #expect(obsolete == nil)
        let card = TimelineViewport(contentHeight: 2200, containerHeight: 800, topInset: 80, bottomInset: 360, offsetY: 1320)
        state.geometryChanged(card)
        #expect(state.mode == .reading && state.pendingBottomRequest == nil && state.showsBottomButton())
        state.requestBottom() // An accepted response with other cards still present.
        let command = try nextCommand(&state)
        state.geometryChanged(.init(contentHeight: 2200, containerHeight: 800, topInset: 80, bottomInset: 360, offsetY: 1760))
        let completed = state.complete(command)
        #expect(completed && state.mode == .reading)
        state.geometryChanged(.init(contentHeight: 2250, containerHeight: 800, topInset: 80, bottomInset: 360, offsetY: 1760))
        #expect(state.pendingBottomRequest == nil)
        state.setInteractionPresented(false)
        state.geometryChanged(viewport(offset: 1520, height: 2250))
        let resized = try #require(state.pendingBottomRequest)
        #expect(resized.bottomOffset == 1570 && state.returningToBottom)
    }

    @Test func anExistingApprovalCannotCancelTheInitialOpeningReturn() throws {
        var state = TimelineScrollState()
        state.geometryChanged(viewport())
        state.open(interactionPresented: true)
        state.setInteractionPresented(true)
        let command = try nextCommand(&state)
        #expect(state.returningToBottom)
        state.geometryChanged(viewport(offset: 1320))
        let completed = state.complete(command)
        #expect(completed && state.mode == .reading)
    }

    @Test func drawerMotionAndOcclusionSuspendFollowingWithoutLosingReadingIntent() throws {
        for reading in [false, true] {
            var state = try openedAtBottom()
            if reading { state.browseHistory() }
            let generation = state.navigationGeneration
            state.setNavigationSuspended(true)
            state.geometryChanged(viewport(offset: 1320, height: 2250))
            state.phaseChanged(.interacting, viewport: viewport(offset: 1320, height: 2250))
            #expect(state.navigationGeneration == generation)
            #expect(state.pendingBottomRequest == nil && !state.showsBottomButton())
            state.setNavigationSuspended(false)
            state.phaseChanged(.idle, viewport: viewport(offset: 1320, height: 2250))
            #expect((state.pendingBottomRequest == nil) == reading)
        }
    }

    @Test func closingDrawerCannotLetAnOldCompletionReleaseTheNewAnimation() throws {
        var state = TimelineScrollState()
        state.geometryChanged(viewport())
        state.open()
        let first = try nextCommand(&state)
        state.setNavigationSuspended(true)
        state.setNavigationSuspended(false)
        let second = try nextCommand(&state)
        let completedFirst = state.complete(first)
        #expect(first.id != second.id && !completedFirst && state.activeCommand == second)
    }

    @Test func stationaryBottomAndSubpixelLayoutDoNotProduceCorrectionLoops() throws {
        var state = try openedAtBottom()
        for delta in [0.25, -0.25, 0, 1, -1, 0] {
            state.geometryChanged(viewport(offset: 1320, height: 2000 + delta))
            #expect(state.pendingBottomRequest == nil && !state.showsBottomButton())
        }
        state.setNavigationSuspended(true)
        state.setNavigationSuspended(false)
        #expect(state.pendingBottomRequest == nil && !state.showsBottomButton())
    }

    @Test func anUnchangedFailedNativeTargetIsNotRetriedInALayoutLoop() throws {
        var state = TimelineScrollState()
        state.geometryChanged(viewport())
        state.open()
        let command = try nextCommand(&state)
        let completed = state.complete(command)
        #expect(completed)
        for offset in [0.0, 0.25, 0, 0.5] {
            state.geometryChanged(viewport(offset: offset))
            #expect(state.pendingBottomRequest == nil && state.showsBottomButton())
        }
        state.requestBottom()
        #expect(state.pendingBottomRequest != nil)
    }

    @Test func aNewGestureInvalidatesHistoryRestorationAndPendingReturns() throws {
        var state = try openedAtBottom()
        state.browseHistory()
        let request = state.navigationGeneration
        state.phaseChanged(.interacting, viewport: viewport(offset: 800))
        #expect(state.navigationGeneration != request)
        let gesture = state.navigationGeneration
        state.phaseChanged(.interacting, viewport: viewport(offset: 700))
        #expect(state.navigationGeneration == gesture)
        state.requestBottom()
        state.phaseChanged(.idle, viewport: viewport(offset: 700))
        #expect(state.returningToBottom && state.pendingBottomRequest != nil)
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
