import Foundation
import Testing
@testable import ClientCore

@Suite struct TimelineNavigationTests {
    private func viewport(distance: CGFloat, height: CGFloat = 2000) -> TimelineViewport {
        TimelineViewport(contentHeight: height, containerHeight: 800,
            topInset: 80, bottomInset: 120, offsetY: height - 680 - distance)
    }

    @Test func buttonStaysDuringReturnAndNewDragLeavesItInHistory() {
        let far = viewport(distance: 500), bottom = viewport(distance: 0), above = viewport(distance: 30)
        var state = TimelineScrollState()
        state.browseHistory()
        #expect(state.showsBottomButton(far))
        state.requestBottom()
        #expect(state.showsBottomButton(far))
        state.phaseChanged(.animating, viewport: far)
        state.geometryChanged(viewport(distance: 15))
        #expect(state.showsBottomButton(viewport(distance: 15)))
        state.geometryChanged(bottom)
        state.phaseChanged(.idle, viewport: bottom)
        #expect(!state.showsBottomButton(bottom) && !state.returningToBottom)

        // Native scrolling may go directly to interacting after an animation.
        let result1 = state.phaseChanged(.interacting, viewport: bottom)
        #expect(result1)
        state.geometryChanged(above)
        state.phaseChanged(.decelerating, viewport: above)
        state.phaseChanged(.idle, viewport: above)
        #expect(state.showsBottomButton(above))
        #expect(!state.followsTail && !state.shouldFollow(above))
        state.geometryChanged(viewport(distance: 80, height: 2050))
        #expect(!state.shouldFollow(viewport(distance: 80, height: 2050)))
    }

    @Test func phaseGeometryWinsOverThePreviousGeometryCallback() {
        let bottom = viewport(distance: 0), above = viewport(distance: 28)
        var state = TimelineScrollState()
        state.requestBottom()
        state.phaseChanged(.animating, viewport: bottom)
        state.geometryChanged(bottom)
        state.phaseChanged(.interacting, viewport: bottom)
        // No geometry callback has published the new offset before idle.
        state.phaseChanged(.idle, viewport: above)
        #expect(!state.followsTail && state.showsBottomButton(above))
        #expect(!state.shouldFollow(above))
    }

    @Test func reachingBottomHidesThePillRegardlessOfPreviousFollowIntent() {
        var state = TimelineScrollState()
        state.browseHistory()
        #expect(!state.showsBottomButton(viewport(distance: 0)))
        #expect(!state.showsBottomButton(viewport(distance: 0.8)))
        state.phaseChanged(.interacting, viewport: viewport(distance: 50))
        state.phaseChanged(.idle, viewport: viewport(distance: 0))
        #expect(state.followsTail)
        #expect(state.shouldFollow(viewport(distance: 50, height: 2050)))
    }

    @Test func newGestureInvalidatesAPendingReturnOrLatestLoad() {
        var state = TimelineScrollState()
        state.requestBottom()
        let request = state.navigationGeneration
        state.phaseChanged(.animating, viewport: viewport(distance: 200))
        let result2 = state.phaseChanged(.interacting, viewport: viewport(distance: 200))
        #expect(result2)
        #expect(state.navigationGeneration != request)
        #expect(!state.returningToBottom && !state.shouldFollow(viewport(distance: 200)))
        let gesture = state.navigationGeneration
        let result3 = !state.phaseChanged(.interacting, viewport: viewport(distance: 300))
        #expect(result3)
        #expect(state.navigationGeneration == gesture)
    }

    @Test func safeAreaKeyboardShortContentAndFractionalBottomHaveNoCorrectionLoop() {
        for bottomInset in [80.0, 380] {
            let atBottom = TimelineViewport(contentHeight: 1200.2, containerHeight: 800,
                topInset: 80, bottomInset: bottomInset, offsetY: 400.2 + bottomInset)
            #expect(atBottom.hasOverflow && atBottom.isAtBottom)
            #expect(!atBottom.shouldFollowTail(isFollowing: true, userIsScrolling: false))
        }
        let short = TimelineViewport(contentHeight: 500, containerHeight: 800, topInset: 80, bottomInset: 80, offsetY: -80)
        #expect(!short.hasOverflow && short.isAtBottom)
        let keyboard = TimelineViewport(contentHeight: 500, containerHeight: 800, topInset: 80, bottomInset: 380, offsetY: -80)
        #expect(keyboard.hasOverflow && !keyboard.isAtBottom)
        #expect(!TimelineViewport().shouldFollowTail(isFollowing: true, userIsScrolling: false))
        #expect(viewport(distance: 1.8).isAtBottom)
        #expect(!viewport(distance: 20).isAtBottom)
    }

    @Test func latestRecordsRequireOneFreshPullOnAnAlreadyVisiblePrompt() {
        var pull = TimelineLatestPull()
        let bottom = viewport(distance: 0), pulled = viewport(distance: -30)
        pull.begin(at: bottom, promptVisible: true, canLoad: true)
        pull.update(pulled)
        #expect(pull.isReady)
        let result4 = pull.end()
        #expect(result4)
        let result5 = !pull.end()
        #expect(result5)
        // Subsequent geometry from inertia cannot trigger another request.
        pull.update(viewport(distance: -50))
        let result6 = !pull.end()
        #expect(result6)
        pull.begin(at: viewport(distance: 500), promptVisible: false, canLoad: true)
        pull.update(pulled)
        let result7 = !pull.end()
        #expect(result7)
        // A failed read can be retried by another deliberate pull.
        pull.begin(at: bottom, promptVisible: true, canLoad: true)
        pull.update(pulled)
        let result8 = pull.end()
        #expect(result8)
    }

    @Test func resizingAndLoadingCannotTriggerPullAndReversingCancelsIt() {
        var pull = TimelineLatestPull()
        let bottom = viewport(distance: 0)
        pull.begin(at: bottom, promptVisible: true, canLoad: false)
        pull.update(viewport(distance: -50))
        let result9 = !pull.end()
        #expect(result9)
        pull.begin(at: bottom, promptVisible: true, canLoad: true)
        pull.update(viewport(distance: -50, height: 2020))
        let result10 = !pull.end()
        #expect(result10)
        pull.begin(at: bottom, promptVisible: true, canLoad: true)
        pull.update(viewport(distance: -40))
        pull.update(viewport(distance: -5))
        let result11 = !pull.end()
        #expect(result11)
    }
}
