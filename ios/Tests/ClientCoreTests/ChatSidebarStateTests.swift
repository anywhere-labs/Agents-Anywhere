import Testing
@testable import ClientCore

@Suite struct ChatSidebarStateTests {
    @Test func regularSplitStartsOpenAndNavigationKeepsBothColumnsVisible() {
        var sidebar = ChatSidebarState()
        sidebar.setLayout(.regularSplit)
        #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        for _ in 0..<3 {
            sidebar.selectDestination()
            #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        }
    }

    @Test func phoneAndCompactIPadDismissTheOverlayAfterSelection() {
        for layout in [ChatSidebarState.Layout.drawer, .compactSplit] {
            var sidebar = ChatSidebarState()
            sidebar.setLayout(layout)
            sidebar.isOpen = true
            #expect(sidebar.obscuresDetail)
            sidebar.selectDestination()
            #expect(!sidebar.isOpen && !sidebar.obscuresDetail)
        }
    }

    @Test func resizingRestoresRegularSplitWithoutUndoingAnExplicitToggle() {
        var sidebar = ChatSidebarState()
        sidebar.setLayout(.regularSplit)
        sidebar.isOpen = false
        sidebar.setLayout(.regularSplit)
        sidebar.selectDestination()
        #expect(!sidebar.isOpen && !sidebar.obscuresDetail)
        sidebar.setLayout(.compactSplit)
        sidebar.isOpen = true
        #expect(sidebar.obscuresDetail)
        sidebar.setLayout(.regularSplit)
        #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        sidebar.setLayout(.compactSplit)
        #expect(!sidebar.isOpen)
    }

    @Test func openPhoneDrawerDisablesTheUntranslatedPageAndEnablesSidebarActions() {
        let interaction = DrawerInteractionState(isOpen: true, progress: 1, isAnimating: false, isDragging: false)
        #expect(interaction.acceptsSidebarTouches)
        #expect(!interaction.acceptsContentTouches)
    }

    @Test func closingAfterSelectionWaitsForTheSpringBeforeEnablingThePage() {
        // isOpen and progress already contain their destination values while
        // the spring is still drawing the main card over part of the sidebar.
        let closing = DrawerInteractionState(isOpen: false, progress: 0, isAnimating: true, isDragging: false)
        #expect(!closing.acceptsContentTouches && !closing.acceptsSidebarTouches)
        let closed = DrawerInteractionState(isOpen: false, progress: 0, isAnimating: false, isDragging: false)
        #expect(closed.acceptsContentTouches && !closed.acceptsSidebarTouches)
    }

    @Test func interruptedAndUnsettledPansCannotActivateEitherSurface() {
        let states = [
            DrawerInteractionState(isOpen: true, progress: 1, isAnimating: true, isDragging: false),
            DrawerInteractionState(isOpen: true, progress: 1, isAnimating: false, isDragging: true),
            DrawerInteractionState(isOpen: false, progress: 0, isAnimating: false, isDragging: true),
            DrawerInteractionState(isOpen: true, progress: 0.6, isAnimating: false, isDragging: false),
            DrawerInteractionState(isOpen: false, progress: 0.4, isAnimating: false, isDragging: false),
        ]
        for state in states {
            #expect(!state.acceptsContentTouches && !state.acceptsSidebarTouches)
        }
    }
}
